import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { bitdefenderConnectionSchema, bitdefenderSyncOptionsSchema, type Actor } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { ImportRun } from '../services/importers/common.js';
import {
  assetEndpoint,
  BitdefenderClient,
  clearEndpoints,
  clientEndpoints,
  runBitdefenderSync,
} from '../services/integrations/bitdefender.js';
import { companiesWithMapping, deviceLayout, mapCompanies } from '../services/integrations/cw-rmm.js';
import type { ErrorLog } from '../services/repeating.js';
import { ConnectedSyncScheduler } from '../services/sync-scheduler.js';
import { isUuid, Scope } from '../services/scope.js';
import { requestEvent } from '../services/security-log.js';
import type { SettingsService, StoredBitdefender } from '../services/settings.js';

const HOUR = 3_600_000;
const PRODUCT = 'Bitdefender GravityZone';

/** Starts a background sync; resolves once the job exists, not when it finishes. */
async function startSync(
  db: Database,
  settings: SettingsService,
  actor: Actor,
  fetcher: typeof fetch | undefined,
  log: ErrorLog,
) {
  const saved = await settings.bitdefender(actor.orgId);
  if (!saved) throw new HttpError(400, `Connect ${PRODUCT} first.`);
  const run = await ImportRun.start(db, actor, 'bitdefender');
  const done = runBitdefenderSync(db, actor, BitdefenderClient.for(saved, fetcher), run, saved)
    .then(async () => {
      await run.flush('done');
      await settings.patchBitdefender(actor.orgId, { lastSyncAt: new Date().toISOString() });
    })
    .catch(async (error) => {
      run.note(error instanceof HttpError ? error.message : 'The sync stopped unexpectedly.');
      log(error);
      await run.flush('failed');
    });
  return { id: run.jobId, done };
}

/**
 * Bitdefender GravityZone: the connection and company links (administrators), syncs (manual and hourly), and each
 * client's and asset's endpoint protection for anyone who can read them.
 */
export function registerBitdefenderRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    bitdefenderFetch?: typeof fetch;
  },
) {
  const { db, authed, recent, settings } = deps;
  const admin = (req: FastifyRequest) => {
    requireAdmin(req.session!.actor);
    return req.session!.actor;
  };
  const event = (req: FastifyRequest, action: string, detail = '') => requestEvent(db, req, action, detail);
  const clientFor = async (orgId: string) => {
    const saved = await settings.bitdefender(orgId);
    if (!saved) throw new HttpError(400, `Connect ${PRODUCT} first.`);
    return { saved, client: BitdefenderClient.for(saved, deps.bitdefenderFetch) };
  };

  app.get('/api/integrations/bitdefender', authed, async (req) => settings.bitdefenderView(admin(req).orgId));
  app.put('/api/integrations/bitdefender', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    // The key is tried before it's saved, so a typo shows up here and never replaces a working key.
    const body = bitdefenderConnectionSchema.parse(req.body);
    const apiKey = body.apiKey ?? (await settings.bitdefender(actor.orgId))?.apiKey;
    if (!apiKey) throw new HttpError(400, 'Enter the API key.', undefined, { apiKey: 'Enter the API key.' });
    const { auth, companies } = await BitdefenderClient.detectAuth(body.accessUrl, apiKey, deps.bitdefenderFetch);
    await settings.saveBitdefender(actor.orgId, actor.id, req.body, auth);
    await event(req, `${PRODUCT} connection saved`, `${companies.length} companies visible`);
    return { ...(await settings.bitdefenderView(actor.orgId)), companies: companies.length };
  });
  app.delete('/api/integrations/bitdefender', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    await settings.forgetBitdefender(actor.orgId);
    // The endpoints are only a copy of GravityZone's; assets the sync added stay as documentation.
    await clearEndpoints(db, actor.orgId);
    await event(req, `${PRODUCT} connection removed`);
    return { ok: true };
  });
  app.get('/api/integrations/bitdefender/companies', authed, async (req) => {
    const actor = admin(req);
    const { saved, client } = await clientFor(actor.orgId);
    return companiesWithMapping(db, actor, await client.companies(), saved.map);
  });
  app.put('/api/integrations/bitdefender/companies', authed, async (req) => {
    const actor = admin(req);
    const { saved, client } = await clientFor(actor.orgId);
    const companies = await client.companies();
    const map = await mapCompanies(db, actor, companies, saved.map, req.body, PRODUCT);
    await settings.patchBitdefender(actor.orgId, { map });
    return companiesWithMapping(db, actor, companies, map);
  });
  app.put('/api/integrations/bitdefender/options', authed, async (req) => {
    const actor = admin(req);
    const options = bitdefenderSyncOptionsSchema.parse(req.body);
    // Adding assets needs somewhere to put them: the device layout ConnectWise RMM uses, or Configurations.
    if (options.createAssets) await deviceLayout(db, actor.orgId, null, actor);
    await settings.patchBitdefender(actor.orgId, { options });
    return settings.bitdefenderView(actor.orgId);
  });
  app.post('/api/integrations/bitdefender/sync', authed, async (req, reply) => {
    const actor = admin(req);
    const { id } = await startSync(db, settings, actor, deps.bitdefenderFetch, (err) =>
      req.log.error({ err }, `${PRODUCT} sync failed`),
    );
    await event(req, `${PRODUCT} sync started`);
    return reply.status(202).send({ id });
  });

  // ---- endpoint protection, for anyone who can read the client or asset ----
  const linkedClients = async (orgId: string) =>
    new Set(
      Object.values((await settings.bitdefender(orgId))?.map ?? {}).flatMap((m) =>
        m.action === 'link' ? [m.clientId] : [],
      ),
    );
  app.get<{ Params: { id: string } }>('/api/clients/:id/bitdefender', authed, async (req) => {
    const actor = req.session!.actor;
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Client not found.');
    await new Scope(db, actor).require(req.params.id, 'read', 'Client');
    const linked = (await linkedClients(actor.orgId)).has(req.params.id);
    return clientEndpoints(db, actor.orgId, req.params.id, linked);
  });
  app.get<{ Params: { id: string } }>('/api/assets/:id/bitdefender', authed, async (req) => {
    const actor = req.session!.actor;
    const [asset] = isUuid(req.params.id)
      ? await db
          .select({ clientId: schema.assets.clientId })
          .from(schema.assets)
          .where(and(eq(schema.assets.id, req.params.id), eq(schema.assets.orgId, actor.orgId)))
      : [];
    if (!asset) throw new HttpError(404, 'Asset not found.');
    await new Scope(db, actor).require(asset.clientId, 'read', 'Asset');
    // Fastify won't send a bare null as JSON, so "not a Bitdefender endpoint" is { endpoint: null }.
    return { endpoint: await assetEndpoint(db, actor.orgId, req.params.id) };
  });
}

/** Runs each organization's Bitdefender sync about hourly, as the administrator who connected it. */
export class BitdefenderScheduler extends ConnectedSyncScheduler<StoredBitdefender> {
  constructor(db: Database, settings: SettingsService, log: ErrorLog, fetcher?: typeof fetch) {
    super(db, log, {
      product: PRODUCT,
      settingsKey: 'bitdefender',
      every: HOUR,
      checkEvery: 10 * 60_000,
      load: (orgId) => settings.bitdefender(orgId),
      start: (actor) => startSync(db, settings, actor, fetcher, log),
    });
  }
}
