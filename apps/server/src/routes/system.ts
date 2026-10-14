import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { SERVICE_ACTION_LABELS, type ServiceAction } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { SystemServices } from '../services/system-services.js';

/**
 * The Services page: the state of the services Atlas runs on, and asking the server's helper to restart one or
 * repair the installation (administrators only).
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    services: SystemServices;
  },
) {
  const { db, authed, recent, services } = deps;
  const admin = (req: FastifyRequest) => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    return actor;
  };
  const databaseReachable = async () => {
    try {
      await db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  };

  app.get('/api/system/services', authed, async (req) => {
    admin(req);
    return services.overview(await databaseReachable());
  });

  // Every action interrupts people using Atlas, so each needs a fresh password confirmation and is logged.
  app.post<{ Body: { action?: unknown } }>('/api/system/services/run', authed, async (req, reply) => {
    const actor = admin(req);
    recent(req);
    const run = await services.request(req.body?.action, actor.name);
    await db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'Service action requested',
      detail: SERVICE_ACTION_LABELS[run.action as ServiceAction],
      ip: req.ip,
    });
    return reply.status(202).send(run);
  });
}
