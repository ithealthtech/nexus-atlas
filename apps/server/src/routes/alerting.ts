import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { alertHistoryQuerySchema, alertVersionNumberSchema } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { Scope, isUuid } from '../services/scope.js';
import type { AlertDeliveryService } from '../services/alerting/delivery.js';
import { AlertWorkspaceService } from '../services/alerting/workspace.js';
import { AlertPreviewService } from '../services/alerting/preview.js';
import { AlertVersionService } from '../services/alerting/versions.js';
import type { SettingsService } from '../services/settings.js';
import type { TeamsSettingsStore } from '../services/teams/settings.js';

export function registerAlertingRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    teams: TeamsSettingsStore;
    publicOrigin: string;
  },
) {
  const workspace = new AlertWorkspaceService(deps.db);
  const preview = new AlertPreviewService(deps.db, deps);
  const versions = new AlertVersionService(deps.db);
  const scope = (req: FastifyRequest) => new Scope(deps.db, req.session!.actor);
  app.get('/api/settings/alerting', deps.authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return workspace.read(scope(req));
  });
  app.put('/api/settings/alerting', deps.authed, async (req) => {
    deps.recent(req);
    return workspace.save(scope(req), req.body, req.ip);
  });
  app.post('/api/settings/alerting/preview', deps.authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return preview.preview(scope(req), req.body, req.ip);
  });
  app.get('/api/settings/alerting/versions', deps.authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const query = alertHistoryQuerySchema.parse(req.query);
    return versions.history(scope(req), query.beforeVersion);
  });
  app.post('/api/settings/alerting/publish', deps.authed, async (req, reply) => {
    deps.recent(req);
    reply.header('cache-control', 'no-store');
    return versions.publish(scope(req), req.body, req.ip);
  });
  app.get<{ Params: { version: string } }>(
    '/api/settings/alerting/versions/:version',
    deps.authed,
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return versions.read(scope(req), alertVersionNumberSchema.parse(req.params.version));
    },
  );
  app.post<{ Params: { version: string } }>(
    '/api/settings/alerting/versions/:version/restore',
    deps.authed,
    async (req) => {
      deps.recent(req);
      return versions.restore(scope(req), alertVersionNumberSchema.parse(req.params.version), req.body, req.ip);
    },
  );
}

/** Live delivery from the alerting center: going live, what would send, history, retries and test sends. */
export function registerAlertDeliveryRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    delivery: AlertDeliveryService;
  },
) {
  const { delivery } = deps;
  const scope = (req: FastifyRequest) => new Scope(deps.db, req.session!.actor);
  app.get('/api/settings/alerting/delivery', deps.authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return delivery.state(scope(req));
  });
  app.put('/api/settings/alerting/delivery', deps.authed, async (req) => {
    deps.recent(req);
    return delivery.setMode(scope(req), req.body, req.ip);
  });
  app.get('/api/settings/alerting/delivery/preview', deps.authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return delivery.dryRun(scope(req));
  });
  app.get('/api/settings/alerting/deliveries', deps.authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return delivery.history(scope(req), req.query);
  });
  app.post<{ Params: { id: string } }>('/api/settings/alerting/deliveries/:id/retry', deps.authed, async (req) => {
    deps.recent(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Delivery not found.');
    return delivery.retry(scope(req), req.params.id, req.body, req.ip);
  });
  // An alert's own page, from the link in its email or Teams post: open to staff who can open the client.
  app.get<{ Params: { id: string } }>('/api/alerts/:id', deps.authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Alert not found.');
    return delivery.alert(scope(req), req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/alerts/:id/acknowledge', deps.authed, async (req) => {
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Alert not found.');
    return delivery.acknowledge(scope(req), req.params.id, req.ip);
  });
  app.post('/api/settings/alerting/test', deps.authed, async (req) => {
    deps.recent(req);
    return delivery.testSend(scope(req), req.body, req.ip);
  });
}
