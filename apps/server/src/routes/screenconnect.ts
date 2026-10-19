import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import { requireAdmin } from '../authz.js';
import type { SettingsService } from '../services/settings.js';

/** The organization's ScreenConnect address, which the desktop app's Connect button opens. */
export function registerScreenConnectRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
  },
) {
  const { db, authed, recent, settings } = deps;
  const actorOf = (req: FastifyRequest) => req.session!.actor;

  app.get('/api/settings/screenconnect', authed, async (req) => settings.screenConnect(actorOf(req).orgId));
  app.put('/api/settings/screenconnect', authed, async (req) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    recent(req);
    const saved = await settings.saveScreenConnect(actor.orgId, req.body);
    await db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'ScreenConnect settings changed',
      detail: saved.url ? `${saved.url} · ${saved.group}` : 'Connect turned off',
      ip: req.ip,
    });
    return saved;
  });
}
