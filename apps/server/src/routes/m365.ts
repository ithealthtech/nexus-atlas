import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { m365LinkSchema, m365SyncOptionsSchema, type Actor } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { actorFor } from '../identity/service.js';
import { ClientService } from '../services/clients.js';
import { ImportRun } from '../services/importers/common.js';
import { M365Client, runM365Sync, tenantLinks } from '../services/integrations/m365.js';
import type { SettingsService } from '../services/settings.js';

const SYNC_EVERY = 6 * 3_600_000;

async function startSync(
  db: Database,
  settings: SettingsService,
  actor: Actor,
  fetcher: typeof fetch | undefined,
  log: (error: unknown) => void,
) {
  const saved = await settings.m365(actor.orgId);
  if (!saved) throw new HttpError(400, 'Connect Microsoft 365 first.');
  const client = new M365Client(saved.clientId, saved.clientSecret, fetcher);
  const run = await ImportRun.start(db, actor, 'm365');
  const done = runM365Sync(db, actor, client, run, saved, async (clientId, result) => {
    const current = await settings.m365(actor.orgId);
    const t = current?.tenants[clientId];
    if (!current || !t) return;
    await settings.patchM365(actor.orgId, {
      tenants: {
        ...current.tenants,
        [clientId]: {
          ...t,
          tenantName: result.name ?? t.tenantName,
          status: result.ok ? 'ok' : 'failed',
          detail: result.ok ? null : (result.detail ?? null),
          checkedAt: new Date().toISOString(),
        },
      },
    });
  })
    .then(async () => {
      await run.flush('done');
      await settings.patchM365(actor.orgId, { lastSyncAt: new Date().toISOString() });
    })
    .catch(async (error) => {
      run.note(error instanceof HttpError ? error.message : 'The sync stopped unexpectedly.');
      log(error);
      await run.flush('failed');
    });
  return { id: run.jobId, done };
}

/** Microsoft 365 documentation sync: the MSP's multi-tenant app, which client uses which tenant, and syncs. */
export function registerM365Routes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    publicOrigin: string;
    fetcher?: typeof fetch;
  },
) {
  const { db, authed, recent, settings } = deps;
  const redirectUri = `${deps.publicOrigin}/api/integrations/m365/consent`;
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
  const connected = async (orgId: string) => {
    const saved = await settings.m365(orgId);
    if (!saved) throw new HttpError(400, 'Connect Microsoft 365 first.');
    return saved;
  };
  const view = async (actor: Actor) => {
    const saved = await settings.m365(actor.orgId);
    if (!saved) return { connection: null, tenants: [], redirectUri };
    const clients = await new ClientService(db).list(actor);
    return {
      connection: await settings.m365View(actor.orgId, deps.publicOrigin),
      tenants: tenantLinks(saved, clients, redirectUri),
      redirectUri,
    };
  };

  app.get('/api/integrations/m365', authed, async (req) => view(admin(req)));
  app.put('/api/integrations/m365', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    await settings.saveM365(actor.orgId, actor.id, req.body);
    await event(req, 'Microsoft 365 connection saved');
    return view(actor);
  });
  app.delete('/api/integrations/m365', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    await settings.forgetM365(actor.orgId);
    await event(req, 'Microsoft 365 connection removed');
    return { ok: true };
  });
  app.put('/api/integrations/m365/options', authed, async (req) => {
    const actor = admin(req);
    await settings.patchM365(actor.orgId, { options: m365SyncOptionsSchema.parse(req.body) });
    return view(actor);
  });

  // Links a client to its tenant, then checks the app can sign in there (it can't until consent is granted).
  app.post('/api/integrations/m365/tenants', authed, async (req) => {
    const actor = admin(req);
    const saved = await connected(actor.orgId);
    const body = m365LinkSchema.parse(req.body);
    const client = await new ClientService(db).get(actor, body.clientId);
    const taken = Object.entries(saved.tenants).find(
      ([id, t]) => id !== body.clientId && t.tenantId.toLowerCase() === body.tenant.toLowerCase(),
    );
    if (taken) throw new HttpError(409, 'That tenant is already linked to another client.');
    await settings.patchM365(actor.orgId, {
      tenants: {
        ...saved.tenants,
        [body.clientId]: {
          tenantId: body.tenant,
          tenantName: null,
          status: 'unchecked',
          detail: null,
          checkedAt: null,
        },
      },
    });
    await event(req, 'Microsoft 365 tenant linked', `${client.name}: ${body.tenant}`);
    return view(actor);
  });
  app.post<{ Params: { clientId: string } }>('/api/integrations/m365/tenants/:clientId/check', authed, async (req) => {
    const actor = admin(req);
    const saved = await connected(actor.orgId);
    const link = saved.tenants[req.params.clientId];
    if (!link) throw new HttpError(404, 'That client has no Microsoft 365 tenant linked.');
    let next: (typeof saved.tenants)[string];
    try {
      const found = await new M365Client(saved.clientId, saved.clientSecret, deps.fetcher).check(link.tenantId);
      // A domain is swapped for the tenant's ID, which never changes.
      next = {
        tenantId: found.tenantId,
        tenantName: found.name,
        status: 'ok',
        detail: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      next = { ...link, status: 'failed', detail: error.message, checkedAt: new Date().toISOString() };
    }
    await settings.patchM365(actor.orgId, { tenants: { ...saved.tenants, [req.params.clientId]: next } });
    return view(actor);
  });
  app.delete<{ Params: { clientId: string } }>('/api/integrations/m365/tenants/:clientId', authed, async (req) => {
    const actor = admin(req);
    const saved = await connected(actor.orgId);
    const { [req.params.clientId]: removed, ...rest } = saved.tenants;
    if (!removed) throw new HttpError(404, 'That client has no Microsoft 365 tenant linked.');
    await settings.patchM365(actor.orgId, { tenants: rest });
    await event(req, 'Microsoft 365 tenant unlinked', removed.tenantId);
    return view(actor);
  });
  app.post('/api/integrations/m365/sync', authed, async (req, reply) => {
    const actor = admin(req);
    const { id } = await startSync(db, settings, actor, deps.fetcher, (err) =>
      req.log.error({ err }, 'Microsoft 365 sync failed'),
    );
    await event(req, 'Microsoft 365 sync started');
    return reply.status(202).send({ id });
  });

  // Microsoft sends the Global Administrator back here after the consent screen. Nothing is changed: the page
  // they land on checks the tenant, signed in as the administrator who opened the link.
  app.get<{ Querystring: { admin_consent?: string; state?: string; error?: string } }>(
    '/api/integrations/m365/consent',
    async (req, reply) => {
      const ok = req.query.admin_consent === 'True' && !req.query.error;
      const client = /^[0-9a-f-]{36}$/i.test(req.query.state ?? '') ? req.query.state : '';
      return reply.redirect(
        `/#/admin/data?m365=${ok ? 'consented' : 'declined'}${client ? `&client=${client}` : ''}`,
        302,
      );
    },
  );
}

/** Runs each organization's Microsoft 365 sync every few hours, as the administrator who connected it. */
export class M365Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly log: (error: unknown) => void,
    private readonly fetcher?: typeof fetch,
  ) {}

  start(intervalMs = 15 * 60_000) {
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
      .where(sql`${schema.orgs.settings} ? 'm365'`);
    const started: Promise<void>[] = [];
    for (const { id } of orgs) {
      const saved = await this.settings.m365(id);
      if (!saved?.autoSync || !Object.keys(saved.tenants).length) continue;
      if (saved.lastSyncAt && now - Date.parse(saved.lastSyncAt) < SYNC_EVERY - 5 * 60_000) continue;
      const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, saved.connectedBy));
      if (!user || user.disabled || (user.role !== 'owner' && user.role !== 'admin')) {
        this.log(new Error(`Microsoft 365 sync skipped for org ${id}: the connecting administrator can't run it.`));
        continue;
      }
      try {
        started.push((await startSync(this.db, this.settings, actorFor(user), this.fetcher, this.log)).done);
      } catch (error) {
        // Another import is running; try again next tick.
        if (!(error instanceof HttpError && error.status === 409)) this.log(error);
      }
    }
    await Promise.all(started);
  }
}
