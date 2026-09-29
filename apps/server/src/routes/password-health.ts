import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { PasswordHealthService } from '../services/password-health.js';
import { Scope } from '../services/scope.js';
import type { SettingsService } from '../services/settings.js';

/** The password health report (for staff with vault access), and the breach-check switch and manual run (admins). */
export function registerPasswordHealthRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    health: PasswordHealthService;
  },
) {
  const { db, authed, settings, health } = deps;
  const actorOf = (req: FastifyRequest) => req.session!.actor;

  app.get('/api/password-health', authed, async (req) => {
    const actor = actorOf(req);
    // Client accounts see the passwords shared with them, not a health report.
    if (req.session!.actor.role === 'client_editor' || req.session!.actor.role === 'client_viewer')
      throw new HttpError(403, 'The password health report is for staff.');
    return health.report(new Scope(db, actor));
  });

  app.put('/api/password-health/settings', authed, async (req) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    return settings.savePasswordHealth(actor.orgId, req.body);
  });

  // Runs the check now instead of waiting for the nightly one.
  app.post('/api/password-health/check', authed, async (req) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    if (!(await health.enabled(actor.orgId)))
      throw new HttpError(409, 'Breach checks are turned off. Turn them on first.');
    const result = await health.checkBreaches(actor.orgId, 500);
    if (result.failed && !result.checked)
      throw new HttpError(
        502,
        'Have I Been Pwned could not be reached. Check this server’s internet access, or turn breach checks off.',
      );
    await settings.saveHealthRun(actor.orgId, new Date().toISOString());
    return result;
  });
}
