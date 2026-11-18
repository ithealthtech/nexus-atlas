import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { cwPsaConnectionSchema, cwPsaOptionsSchema, type Actor } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { ImportRun } from '../services/importers/common.js';
import { CwPsaClient } from '../services/integrations/cw-psa-client.js';
import {
  clearUnlinkedPsaTickets,
  psaCompanies,
  psaLinked,
  runPsaTicketSync,
} from '../services/integrations/cw-psa-tickets.js';
import { companiesWithMapping, mapCompanies } from '../services/integrations/cw-rmm.js';
import type { ErrorLog } from '../services/repeating.js';
import { requestEvent } from '../services/security-log.js';
import type { SettingsService, StoredCwPsa } from '../services/settings.js';
import { ConnectedSyncScheduler } from '../services/sync-scheduler.js';

const HOUR = 3_600_000;

/** Starts a background sync of PSA tickets; resolves once the job exists, not when it finishes. */
async function startPsaSync(
  db: Database,
  settings: SettingsService,
  actor: Actor,
  fetcher: typeof fetch | undefined,
  log: ErrorLog,
) {
  const saved = await settings.cwPsa(actor.orgId);
  if (!saved) throw new HttpError(400, 'Connect ConnectWise PSA first.');
  const run = await ImportRun.start(db, actor, 'cw-psa');
  const done = runPsaTicketSync(db, actor.orgId, new CwPsaClient(saved, fetcher), run, saved)
    .then(async () => {
      await settings.patchCwPsa(actor.orgId, { lastSyncAt: new Date().toISOString() });
      await run.flush('done');
    })
    .catch(async (error) => {
      run.note(error instanceof HttpError ? error.message : 'The sync stopped unexpectedly.');
      log(error);
      await run.flush('failed');
    });
  return { id: run.jobId, done };
}

/** ConnectWise PSA (Manage): connection, company links, portal ticket options, and ticket syncs (manual and hourly). */
export function registerCwPsaRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    cwPsaFetch?: typeof fetch;
  },
) {
  const { db, authed, recent, settings } = deps;
  const admin = (req: FastifyRequest) => {
    requireAdmin(req.session!.actor);
    return req.session!.actor;
  };
  const clientFor = async (orgId: string) => {
    const saved = await settings.cwPsa(orgId);
    if (!saved) throw new HttpError(400, 'Connect ConnectWise PSA first.');
    return { saved, client: new CwPsaClient(saved, deps.cwPsaFetch) };
  };

  app.get('/api/integrations/cw-psa', authed, async (req) => settings.cwPsaView(admin(req).orgId));
  app.put('/api/integrations/cw-psa', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    // Check the keys before saving, so a typo shows up here and never replaces a working connection.
    const body = cwPsaConnectionSchema.parse(req.body);
    const privateKey = body.privateKey ?? (await settings.cwPsa(actor.orgId))?.privateKey;
    if (!privateKey)
      throw new HttpError(400, 'Enter the private key.', undefined, { privateKey: 'Enter the private key.' });
    const companies = await psaCompanies(new CwPsaClient({ ...body, privateKey }, deps.cwPsaFetch));
    await settings.saveCwPsa(actor.orgId, actor.id, req.body);
    await requestEvent(db, req, 'ConnectWise PSA connection saved', `${companies.length} companies visible`);
    return { ...(await settings.cwPsaView(actor.orgId)), companies: companies.length };
  });
  app.delete('/api/integrations/cw-psa', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    await settings.forgetCwPsa(actor.orgId);
    // Tickets are only a copy of PSA's, so they go with the connection.
    await clearUnlinkedPsaTickets(db, actor.orgId, []);
    await requestEvent(db, req, 'ConnectWise PSA connection removed');
    return { ok: true };
  });
  app.get('/api/integrations/cw-psa/companies', authed, async (req) => {
    const actor = admin(req);
    const { saved, client } = await clientFor(actor.orgId);
    return companiesWithMapping(db, actor, await psaCompanies(client), saved.map);
  });
  app.put('/api/integrations/cw-psa/companies', authed, async (req) => {
    const actor = admin(req);
    const { saved, client } = await clientFor(actor.orgId);
    const companies = await psaCompanies(client);
    const map = await mapCompanies(db, actor, companies, saved.map, req.body, 'ConnectWise PSA');
    await settings.patchCwPsa(actor.orgId, { map });
    // An unlinked company's tickets leave the dashboard at once.
    await clearUnlinkedPsaTickets(
      db,
      actor.orgId,
      psaLinked(map).map(([c]) => c),
    );
    await requestEvent(db, req, 'ConnectWise PSA company links changed', `${psaLinked(map).length} linked`);
    return companiesWithMapping(db, actor, companies, map);
  });
  app.put('/api/integrations/cw-psa/options', authed, async (req) => {
    const actor = admin(req);
    const options = cwPsaOptionsSchema.parse(req.body);
    if (options.portalTickets && !options.portalTicketBoard)
      throw new HttpError(400, 'Name the service board client tickets go on.', undefined, {
        portalTicketBoard: 'Name the service board client tickets go on.',
      });
    await settings.patchCwPsa(actor.orgId, { options });
    await requestEvent(
      db,
      req,
      'ConnectWise PSA options changed',
      options.portalTickets ? `Portal tickets on, board "${options.portalTicketBoard}"` : 'Portal tickets off',
    );
    return settings.cwPsaView(actor.orgId);
  });
  app.post('/api/integrations/cw-psa/sync', authed, async (req, reply) => {
    const actor = admin(req);
    const { id } = await startPsaSync(db, settings, actor, deps.cwPsaFetch, (err) =>
      req.log.error({ err }, 'ConnectWise PSA sync failed'),
    );
    await requestEvent(db, req, 'ConnectWise PSA sync started');
    return reply.status(202).send({ id });
  });
}

/** Syncs PSA tickets hourly for each organization connected with automatic sync on. */
export class CwPsaScheduler extends ConnectedSyncScheduler<StoredCwPsa> {
  constructor(db: Database, settings: SettingsService, log: ErrorLog, fetcher?: typeof fetch) {
    super(db, log, {
      product: 'ConnectWise PSA',
      settingsKey: 'cwPsa',
      every: HOUR,
      checkEvery: 10 * 60_000,
      load: (orgId) => settings.cwPsa(orgId),
      ready: (saved) => psaLinked(saved.map).length > 0,
      start: (actor) => startPsaSync(db, settings, actor, fetcher, log),
    });
  }
}
