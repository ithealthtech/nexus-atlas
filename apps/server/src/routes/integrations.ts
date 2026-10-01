import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  atLeast,
  cwRmmConnectionSchema,
  cwRmmSyncOptionsSchema,
  ROLE_INFO,
  ticketNoteSchema,
  type Actor,
  type TicketNotes,
} from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { actorFor } from '../identity/service.js';
import type { StoredCwRmm } from '../services/settings.js';
import { ImportRun } from '../services/importers/common.js';
import {
  companiesWithMapping,
  CwRmmClient,
  deviceLayout,
  runCwRmmSync,
  LINK_SCOPES,
  saveMapping,
  TICKET_NOTE_SCOPES,
  TICKET_SCOPES,
} from '../services/integrations/cw-rmm.js';
import { runExpiryTickets } from '../services/integrations/cw-expiry-tickets.js';
import { CwDeviceInsight } from '../services/integrations/cw-device-insight.js';
import { CwSecurityService } from '../services/integrations/cw-security.js';
import {
  addTicketNote,
  clearTickets,
  CwTicketReader,
  runTicketSync,
  TICKET_SOURCE,
  ticketNotes,
  ticketNumberIn,
} from '../services/integrations/cw-tickets.js';
import { isUuid, Scope } from '../services/scope.js';
import { clearLinkRefs, CwLinkWriter, runLinkWriteBack } from '../services/integrations/cw-writeback.js';
import { RmmHealthService } from '../services/rmm-health.js';
import type { SettingsService } from '../services/settings.js';
import type { WarrantyLookup } from '../services/warranty-lookup.js';

const HOUR = 3_600_000;

/** Starts a background sync; resolves once the job exists, not when it finishes. */
async function startSync(
  db: Database,
  settings: SettingsService,
  actor: Actor,
  fetcher: typeof fetch | undefined,
  log: (error: unknown) => void,
  warranty?: WarrantyLookup,
  publicUrl?: string,
) {
  const saved = await settings.cwRmm(actor.orgId);
  if (!saved) throw new HttpError(400, 'Connect ConnectWise RMM first.');
  const client = CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, fetcher);
  const run = await ImportRun.start(db, actor, 'cw-rmm');
  const options = cwRmmSyncOptionsSchema.parse(saved.options ?? {});
  const done = runCwRmmSync(db, actor, client, run, saved.map, options, warranty)
    .then(async (complete) => {
      // Today's point on the RMM health trend lines, for the clients whose devices were read.
      await new RmmHealthService(settings).snapshot(db, actor.orgId, complete).catch((error) => log(error));
      // Tickets use their own token, so a key without ticket access still syncs devices.
      if (options.tickets) {
        const tickets = CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, fetcher, TICKET_SCOPES);
        await runTicketSync(db, actor.orgId, new CwTicketReader(tickets, saved.region), run, saved.map);
      } else await clearTickets(db, actor.orgId);
      // Writing into ConnectWise is opt-in, and gets its own token so read-only keys never ask for write scopes.
      if (options.atlasLinks && publicUrl) {
        const writer = (scopes: string) =>
          CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, fetcher, scopes);
        const links = new CwLinkWriter(writer(LINK_SCOPES));
        await runLinkWriteBack(db, actor.orgId, links, run, saved.map, publicUrl);
      }
      if (options.expiryTickets) {
        const writer = CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, fetcher, TICKET_NOTE_SCOPES);
        await runExpiryTickets(db, actor, writer, run, saved.map, options, publicUrl);
      }
      await run.flush('done');
      await settings.patchCwRmm(actor.orgId, { lastSyncAt: new Date().toISOString() });
    })
    .catch(async (error) => {
      run.note(error instanceof HttpError ? error.message : 'The sync stopped unexpectedly.');
      log(error);
      await run.flush('failed');
    });
  return { id: run.jobId, done };
}

/** ConnectWise RMM (Asio): connection, company mapping, and syncs of devices and tickets (manual and hourly). */
export function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    cwRmmFetch?: typeof fetch;
    warranty?: WarrantyLookup;
    /** Atlas's own address, for the links written into ConnectWise. */
    publicUrl?: string;
  },
) {
  const { db, authed, recent, settings } = deps;
  const admin = (req: FastifyRequest) => {
    requireAdmin(req.session!.actor);
    return req.session!.actor;
  };
  const event = (req: FastifyRequest, action: string, detail = '') =>
    db.insert(schema.securityEvents).values({
      orgId: req.session!.actor.orgId,
      userId: req.session!.actor.id,
      actor: req.session!.actor.name,
      action,
      detail: detail.slice(0, 300),
      ip: req.ip,
    });
  const clientFor = async (orgId: string) => {
    const saved = await settings.cwRmm(orgId);
    if (!saved) throw new HttpError(400, 'Connect ConnectWise RMM first.');
    return { saved, client: CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, deps.cwRmmFetch) };
  };

  const insight = new CwDeviceInsight(settings, deps.cwRmmFetch);

  app.get('/api/integrations/cw-rmm', authed, async (req) => settings.cwRmmView(admin(req).orgId));
  // Anyone who can read the asset: its disk, memory and CPU use, device groups, and effective policy, read live.
  app.get<{ Params: { id: string } }>('/api/assets/:id/rmm-insight', authed, async (req) =>
    // Fastify won't send a bare null as JSON, so "not an RMM device" is { insight: null }.
    ({ insight: await insight.forAsset(new Scope(db, req.session!.actor), req.params.id) }),
  );
  app.put('/api/integrations/cw-rmm', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    // Check the credentials before saving, so a typo shows up here and never replaces a working key.
    const body = cwRmmConnectionSchema.parse(req.body);
    const secret = body.clientSecret ?? (await settings.cwRmm(actor.orgId))?.clientSecret;
    if (!secret)
      throw new HttpError(400, 'Enter the client secret.', undefined, { clientSecret: 'Enter the client secret.' });
    const companies = await CwRmmClient.for(body.region, body.clientId, secret, deps.cwRmmFetch).companies();
    await settings.saveCwRmm(actor.orgId, actor.id, req.body);
    await event(req, 'ConnectWise RMM connection saved', `${companies.length} companies visible`);
    return { ...(await settings.cwRmmView(actor.orgId)), companies: companies.length };
  });
  app.delete('/api/integrations/cw-rmm', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    await settings.forgetCwRmm(actor.orgId);
    // Synced devices stay as documentation; tickets are only a copy of ConnectWise's, so they go.
    await clearTickets(db, actor.orgId);
    await event(req, 'ConnectWise RMM connection removed');
    return { ok: true };
  });
  app.get('/api/integrations/cw-rmm/companies', authed, async (req) => {
    const actor = admin(req);
    const { saved, client } = await clientFor(actor.orgId);
    return companiesWithMapping(db, actor, client, saved);
  });
  app.put('/api/integrations/cw-rmm/companies', authed, async (req) => {
    const actor = admin(req);
    const { saved, client } = await clientFor(actor.orgId);
    await saveMapping(db, actor, settings, client, req.body);
    return companiesWithMapping(db, actor, client, { ...saved, ...(await settings.cwRmm(actor.orgId))! });
  });
  app.put('/api/integrations/cw-rmm/options', authed, async (req) => {
    const actor = admin(req);
    const options = cwRmmSyncOptionsSchema.parse(req.body);
    // A chosen layout must be one of this organization's, and not archived.
    if (options.layoutId) await deviceLayout(db, actor.orgId, options.layoutId);
    await settings.patchCwRmm(actor.orgId, { options });
    // Tickets switched off leave the dashboard at once, rather than staying frozen at the last sync.
    if (!options.tickets) await clearTickets(db, actor.orgId);
    // Switched back on later, every link is written again.
    if (!options.atlasLinks) await clearLinkRefs(db, actor.orgId);
    return settings.cwRmmView(actor.orgId);
  });
  // ---- ticket notes: read for staff, written only with the opt-in option on ----
  const noteClient = (saved: StoredCwRmm & { clientSecret: string }, write: boolean) =>
    CwRmmClient.for(
      saved.region,
      saved.clientId,
      saved.clientSecret,
      deps.cwRmmFetch,
      write ? TICKET_NOTE_SCOPES : TICKET_SCOPES,
    );
  /** A synced ticket the actor may see (staff only: notes are internal), with its client's access level. */
  const ticketFor = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const actor = req.session!.actor;
    if (!ROLE_INFO[actor.role].staff) throw new HttpError(404, 'Ticket not found.');
    const t = schema.tickets;
    const [ticket] = await db
      .select({ id: t.externalId, clientId: t.clientId, number: t.number })
      .from(t)
      .where(and(eq(t.orgId, actor.orgId), eq(t.source, TICKET_SOURCE), eq(t.externalId, req.params.id)))
      .limit(1);
    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    const level = await new Scope(db, actor).require(ticket.clientId, 'read', 'Ticket');
    const saved = await settings.cwRmm(actor.orgId);
    if (!saved) throw new HttpError(400, 'ConnectWise is not connected.');
    const options = cwRmmSyncOptionsSchema.parse(saved.options ?? {});
    return { actor, ticket, saved, canAdd: options.ticketNotes && atLeast(level, 'edit') };
  };
  app.get<{ Params: { id: string } }>('/api/tickets/:id/notes', authed, async (req): Promise<TicketNotes> => {
    const { ticket, saved, canAdd } = await ticketFor(req);
    return { notes: await ticketNotes(noteClient(saved, false), ticket.id), canAdd };
  });
  app.post<{ Params: { id: string } }>('/api/tickets/:id/notes', authed, async (req): Promise<TicketNotes> => {
    const { actor, ticket, saved, canAdd } = await ticketFor(req);
    if (!canAdd)
      throw new HttpError(
        403,
        'Adding notes to ConnectWise tickets is off, or your access to this client is read-only. An administrator can turn it on under ConnectWise RMM.',
      );
    const { text } = ticketNoteSchema.parse(req.body);
    await addTicketNote(noteClient(saved, true), ticket.id, `${text}\n\n(Added from Nexus Atlas by ${actor.name})`);
    await event(req, 'ConnectWise ticket note added', `Ticket ${ticket.number}`);
    return { notes: await ticketNotes(noteClient(saved, false), ticket.id), canAdd };
  });

  // A password revealed with a ticket number in its reason is noted on that ticket, when ticket notes are on. The
  // note says who looked at which entry and why; never the value.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || req.routeOptions.url !== '/api/passwords/:id/reveal' || reply.statusCode !== 200)
      return;
    const actor = req.session?.actor;
    const body = (req.body ?? {}) as { reason?: unknown; copy?: unknown; field?: unknown };
    const id = (req.params as { id?: string }).id;
    const number = typeof body.reason === 'string' ? ticketNumberIn(body.reason) : null;
    if (!actor || !number || !isUuid(id)) return;
    await noteReveal(actor, id, number, String(body.reason), body.copy === true, body.field).catch((err) =>
      req.log.warn({ err }, 'ConnectWise ticket note for a password reveal failed'),
    );
  });
  const noteReveal = async (
    actor: Actor,
    passwordId: string,
    number: string,
    reason: string,
    copy: boolean,
    field: unknown,
  ) => {
    const saved = await settings.cwRmm(actor.orgId);
    if (!saved || !cwRmmSyncOptionsSchema.parse(saved.options ?? {}).ticketNotes) return;
    const [password] = await db
      .select({ name: schema.passwords.name, clientId: schema.passwords.clientId })
      .from(schema.passwords)
      .where(and(eq(schema.passwords.orgId, actor.orgId), eq(schema.passwords.id, passwordId)));
    if (!password) return;
    const t = schema.tickets;
    const [ticket] = await db
      .select({ id: t.externalId })
      .from(t)
      .where(
        and(
          eq(t.orgId, actor.orgId),
          eq(t.source, TICKET_SOURCE),
          eq(t.clientId, password.clientId),
          eq(t.number, number),
        ),
      )
      .limit(1);
    if (!ticket) return;
    const what =
      field === 'totp'
        ? 'one-time code'
        : field === 'notes'
          ? 'notes'
          : field === 'custom'
            ? 'custom field'
            : 'password';
    await addTicketNote(
      noteClient(saved, true),
      ticket.id,
      `${actor.name} ${copy ? 'copied' : 'viewed'} the ${what} of “${password.name}” in Nexus Atlas.\nReason: ${reason}`,
    );
  };

  // ---- security and compliance (patching, backup, vulnerabilities, MDR), read live for anyone who can see the client ----
  const security = new CwSecurityService(db, settings, deps.cwRmmFetch);
  app.get<{ Params: { id: string } }>('/api/clients/:id/security', authed, async (req) => {
    const actor = req.session!.actor;
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Client not found.');
    await new Scope(db, actor).require(req.params.id, 'read', 'Client');
    return security.forClient(actor.orgId, req.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/assets/:id/security', authed, async (req) => {
    const actor = req.session!.actor;
    const [asset] = isUuid(req.params.id)
      ? await db
          .select({ clientId: schema.assets.clientId })
          .from(schema.assets)
          .where(and(eq(schema.assets.id, req.params.id), eq(schema.assets.orgId, actor.orgId)))
      : [];
    if (!asset) throw new HttpError(404, 'Asset not found.');
    await new Scope(db, actor).require(asset.clientId, 'read', 'Asset');
    return security.forDevice(actor.orgId, asset.clientId, req.params.id);
  });
  app.post('/api/integrations/cw-rmm/sync', authed, async (req, reply) => {
    const actor = admin(req);
    const { id } = await startSync(
      db,
      settings,
      actor,
      deps.cwRmmFetch,
      (err) => req.log.error({ err }, 'ConnectWise RMM sync failed'),
      deps.warranty,
      deps.publicUrl,
    );
    await event(req, 'ConnectWise RMM sync started');
    return reply.status(202).send({ id });
  });
}

/** Runs each organization's sync about hourly, as the administrator who connected it. */
export class CwRmmScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly log: (error: unknown) => void,
    private readonly fetcher?: typeof fetch,
    private readonly warranty?: WarrantyLookup,
    private readonly publicUrl?: string,
  ) {}

  start(intervalMs = 10 * 60_000) {
    this.timer = setInterval(() => void this.tick().catch(this.log), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()) {
    const orgs = await this.db
      .select({ id: schema.orgs.id })
      .from(schema.orgs)
      .where(sql`${schema.orgs.settings} ? 'cwRmm'`);
    const started: Promise<void>[] = [];
    for (const { id } of orgs) {
      const saved = await this.settings.cwRmm(id);
      if (!saved?.autoSync) continue;
      if (saved.lastSyncAt && now - Date.parse(saved.lastSyncAt) < HOUR - 5 * 60_000) continue;
      const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, saved.connectedBy));
      if (!user || user.disabled || (user.role !== 'owner' && user.role !== 'admin')) {
        this.log(new Error(`ConnectWise RMM sync skipped for org ${id}: the connecting administrator can't run it.`));
        continue;
      }
      try {
        started.push(
          (
            await startSync(
              this.db,
              this.settings,
              actorFor(user),
              this.fetcher,
              this.log,
              this.warranty,
              this.publicUrl,
            )
          ).done,
        );
      } catch (error) {
        // Another import is running; try again next tick.
        if (!(error instanceof HttpError && error.status === 409)) this.log(error);
      }
    }
    await Promise.all(started);
  }
}
