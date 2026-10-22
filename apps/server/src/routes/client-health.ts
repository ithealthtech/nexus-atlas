import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import type { ClientHealthService } from '../services/client-health.js';
import { Scope } from '../services/scope.js';

/** Client health scores, for staff: one client's score with its trend, and every client's for the dashboard. */
export function registerClientHealthRoutes(
  app: FastifyInstance,
  deps: { db: Database; authed: { onRequest: onRequestHookHandler }; health: ClientHealthService },
) {
  const { db, authed, health } = deps;
  const scopeOf = (req: FastifyRequest) => new Scope(db, req.session!.actor);
  app.get<{ Params: { id: string } }>('/api/clients/:id/health', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return health.forClient(scopeOf(req), req.params.id);
  });
  app.get('/api/client-health', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return health.list(scopeOf(req));
  });
}
