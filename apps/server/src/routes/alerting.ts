import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { Scope } from '../services/scope.js';
import { AlertWorkspaceService } from '../services/alerting/workspace.js';
import { AlertPreviewService } from '../services/alerting/preview.js';
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
}
