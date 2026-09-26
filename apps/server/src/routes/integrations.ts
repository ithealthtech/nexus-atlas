import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { cwRmmConnectionSchema, type Actor } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { actorFor } from '../identity/service.js';
import { ImportRun } from '../services/importers/common.js';
import { companiesWithMapping, CwRmmClient, runCwRmmSync, saveMapping } from '../services/integrations/cw-rmm.js';
import type { SettingsService } from '../services/settings.js';

const HOUR = 3_600_000;

/** Starts a background sync; resolves once the job exists, not when it finishes. */
async function startSync(
  db: Database,
  settings: SettingsService,
  actor: Actor,
  fetcher: typeof fetch | undefined,
  log: (error: unknown) => void,
) {
  const saved = await settings.cwRmm(actor.orgId);
  if (!saved) throw new HttpError(400, 'Connect ConnectWise RMM first.');
  const client = CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, fetcher);
  const run = await ImportRun.start(db, actor, 'cw-rmm');
  const done = runCwRmmSync(db, actor, client, run, saved.map)
    .then(async () => {
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

/** ConnectWise RMM (Asio): connection, company mapping, and syncs (manual and hourly). */
export function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    cwRmmFetch?: typeof fetch;
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

  app.get('/api/integrations/cw-rmm', authed, async (req) => settings.cwRmmView(admin(req).orgId));
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
  app.post('/api/integrations/cw-rmm/sync', authed, async (req, reply) => {
    const actor = admin(req);
    const { id } = await startSync(db, settings, actor, deps.cwRmmFetch, (err) =>
      req.log.error({ err }, 'ConnectWise RMM sync failed'),
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
        started.push((await startSync(this.db, this.settings, actorFor(user), this.fetcher, this.log)).done);
      } catch (error) {
        // Another import is running; try again next tick.
        if (!(error instanceof HttpError && error.status === 409)) this.log(error);
      }
    }
    await Promise.all(started);
  }
}
