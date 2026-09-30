import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, TRACKER_FILTERS, TRACKER_KINDS, type TrackerFilter, type TrackerKind } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { Scope, isUuid } from '../services/scope.js';
import type { SettingsService } from '../services/settings.js';
import type { TrackerService } from '../services/trackers.js';

/** How many domains and hosts one "Check now" looks at. */
const CHECK_NOW_LIMIT = 50;
/** How soon one person can press "Check now" again. */
const CHECK_NOW_EVERY = 30_000;

/** The domain and SSL trackers: counts, lists, "Check now", and their settings. */
export function registerTrackerRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    trackers: TrackerService;
  },
) {
  const { db, authed, recent, settings, trackers } = deps;
  const actorOf = (req: FastifyRequest) => req.session!.actor;
  const lastCheck = new Map<string, number>();

  type Query = { client?: string; kind?: string; filter?: string };
  /** The scope and client for a request; a client the actor can't read is not found. */
  const scoped = async (req: FastifyRequest<{ Querystring: Query }>) => {
    const scope = new Scope(db, actorOf(req));
    const { client } = req.query;
    if (client !== undefined) {
      if (!isUuid(client)) throw new HttpError(404, 'Client not found.');
      await scope.require(client, 'read', 'Client');
    }
    return { scope, clientId: client };
  };

  app.get<{ Querystring: Query }>('/api/trackers', authed, async (req) => {
    const { scope, clientId } = await scoped(req);
    return trackers.report(scope, { clientId });
  });

  app.get<{ Querystring: Query }>('/api/trackers/items', authed, async (req) => {
    const kind = req.query.kind as TrackerKind;
    if (!TRACKER_KINDS.includes(kind)) throw new HttpError(400, 'Choose the domain or SSL tracker.');
    const filter = req.query.filter as TrackerFilter | undefined;
    if (filter !== undefined && !TRACKER_FILTERS.includes(filter)) throw new HttpError(400, 'Choose what to list.');
    const { scope, clientId } = await scoped(req);
    return trackers.items(scope, kind, { clientId, filter });
  });

  /** Checks a client's domains and certificates now (or, for staff, every client they can edit), up to a limit. */
  app.post<{ Body: { client?: unknown } }>('/api/trackers/check', authed, async (req) => {
    const actor = actorOf(req);
    const client = req.body?.client;
    const scope = new Scope(db, actor);
    if (client !== undefined && client !== null) {
      if (!isUuid(client)) throw new HttpError(404, 'Client not found.');
      await scope.require(client, 'edit', 'Client');
    } else if (!ROLE_INFO[actor.role].staff) throw new HttpError(403, 'Choose a client to check.');
    const last = lastCheck.get(actor.id) ?? 0;
    if (Date.now() - last < CHECK_NOW_EVERY)
      throw new HttpError(429, 'A check just ran. Wait a moment before checking again.');
    lastCheck.set(actor.id, Date.now());
    return trackers.run(actor, {
      clientId: typeof client === 'string' ? client : undefined,
      force: true,
      limit: CHECK_NOW_LIMIT,
    });
  });

  app.get('/api/settings/trackers', authed, async (req) => settings.trackers(actorOf(req).orgId));
  app.put('/api/settings/trackers', authed, async (req) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    recent(req);
    const saved = await settings.saveTrackers(actor.orgId, req.body);
    await db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'Domain and SSL tracker settings changed',
      detail: `${saved.enabled ? 'Scheduled checks on' : 'Scheduled checks off'} · ${
        saved.createCertificates ? 'adds' : "doesn't add"
      } SSL certificates for domains`,
      ip: req.ip,
    });
    return saved;
  });
}
