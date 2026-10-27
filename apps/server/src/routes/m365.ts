import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { m365LinkSchema, m365SyncOptionsSchema, type Actor } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { gdapClient, GdapService, registerGdapRoutes } from './m365-gdap.js';
import type { IdentityService } from '../identity/service.js';
import type { KeyProvider } from '../crypto/keys.js';
import { ClientService } from '../services/clients.js';
import { ImportRun } from '../services/importers/common.js';
import { runM365Sync, tenantLinks } from '../services/integrations/m365.js';
import type { SettingsService, StoredM365 } from '../services/settings.js';
import type { ErrorLog } from '../services/repeating.js';
import { ConnectedSyncScheduler } from '../services/sync-scheduler.js';
import { securityEvent } from '../services/security-log.js';

const SYNC_EVERY = 6 * 3_600_000;

async function startSync(
  db: Database,
  settings: SettingsService,
  actor: Actor,
  fetcher: typeof fetch | undefined,
  log: ErrorLog,
) {
  const saved = await settings.m365(actor.orgId);
  if (!saved) throw new HttpError(400, 'Connect Microsoft 365 first.');
  const client = await gdapClient(settings, actor.orgId, fetcher);
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
      // The job reads "done" last, once everything the sync writes is written.
      await settings.patchM365(actor.orgId, { lastSyncAt: new Date().toISOString() });
      await run.flush('done');
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
    keys: KeyProvider;
    identity: IdentityService;
    cookieName: string;
    secureCookies: boolean;
  },
) {
  const { db, authed, recent, settings } = deps;
  registerGdapRoutes(app, { ...deps, gdap: new GdapService(deps.keys, deps.fetcher) });
  const redirectUri = `${deps.publicOrigin}/api/integrations/m365/consent`;
  const admin = (req: FastifyRequest) => {
    requireAdmin(req.session!.actor);
    return req.session!.actor;
  };
  const event = (req: FastifyRequest, action: string, detail = '') =>
    securityEvent(db, {
      orgId: req.session!.actor.orgId,
      userId: req.session!.actor.id,
      actor: req.session!.actor.name,
      action,
      detail,
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
      const found = await (await gdapClient(settings, actor.orgId, deps.fetcher)).check(link.tenantId);
      // Linked by a domain, it may turn out to be a tenant another client already has under its ID.
      const other = Object.entries(saved.tenants).find(
        ([id, t]) => id !== req.params.clientId && t.tenantId.toLowerCase() === found.tenantId.toLowerCase(),
      );
      if (other)
        throw new HttpError(
          409,
          `That tenant (${found.name}) is already linked to another client. Unlink one of them.`,
        );
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
export class M365Scheduler extends ConnectedSyncScheduler<StoredM365> {
  constructor(db: Database, settings: SettingsService, log: ErrorLog, fetcher?: typeof fetch) {
    super(db, log, {
      product: 'Microsoft 365',
      settingsKey: 'm365',
      every: SYNC_EVERY,
      checkEvery: 15 * 60_000,
      load: (orgId) => settings.m365(orgId),
      ready: (saved) => Object.keys(saved.tenants).length > 0,
      start: (actor) => startSync(db, settings, actor, fetcher, log),
    });
  }
}
