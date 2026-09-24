import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { UpdateService } from '../services/updates.js';

/** The Updates page: newer releases, and asking the server's updater to install one (administrators only). */
export function registerUpdateRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    updates: UpdateService;
  },
) {
  const { db, authed, recent, updates } = deps;
  const admin = (req: FastifyRequest) => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    return actor;
  };

  app.get('/api/updates', authed, async (req) => {
    admin(req);
    return updates.info();
  });

  app.post('/api/updates/check', authed, async (req) => {
    admin(req);
    return updates.info(true);
  });

  // Installing restarts Atlas for everyone, so it needs a fresh password confirmation and is logged.
  app.post<{ Body: { tag?: unknown } }>('/api/updates/apply', authed, async (req, reply) => {
    const actor = admin(req);
    recent(req);
    const tag = req.body?.tag;
    if (typeof tag !== 'string' || tag.length > 40) throw new HttpError(400, 'Choose a release.');
    const run = await updates.request(tag, actor.name);
    await db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'Update requested',
      detail: tag,
      ip: req.ip,
    });
    return reply.status(202).send(run);
  });
}
