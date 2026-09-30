import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import { requireAdmin } from '../authz.js';
import type { RequestLogQuery, RequestLogService } from '../services/request-log.js';

/** The verbose request log (administrators only): entries, one entry in full, the on/off setting, and clearing it. */
export function registerRequestLogRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    requestLog: RequestLogService;
  },
) {
  const { db, authed, recent, requestLog } = deps;
  const admin = (req: FastifyRequest) => {
    requireAdmin(req.session!.actor);
    return req.session!.actor.orgId;
  };
  const event = (req: FastifyRequest, action: string, detail: string) =>
    db.insert(schema.securityEvents).values({
      orgId: req.session!.actor.orgId,
      userId: req.session!.actor.id,
      actor: req.session!.actor.name,
      action,
      detail,
      ip: req.ip,
    });

  app.get<{ Querystring: RequestLogQuery }>('/api/request-log', authed, async (req) => {
    const orgId = admin(req);
    await requestLog.flush();
    return requestLog.list(orgId, req.query);
  });
  app.get<{ Params: { id: string } }>('/api/request-log/:id', authed, async (req) =>
    requestLog.detail(admin(req), req.params.id),
  );
  // Turning it on records request and response bodies, so it needs a recent password confirmation.
  app.put('/api/request-log/settings', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    const saved = await requestLog.saveSettings(orgId, req.body);
    await event(
      req,
      saved.enabled ? 'Verbose request logging turned on' : 'Verbose request logging turned off',
      `${saved.incoming ? 'Outbound and incoming' : 'Outbound only'}, kept ${saved.retentionDays} days`,
    );
    return saved;
  });
  app.delete('/api/request-log', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    await requestLog.clear(orgId);
    await event(req, 'Request log cleared', '');
    return { ok: true };
  });
}
