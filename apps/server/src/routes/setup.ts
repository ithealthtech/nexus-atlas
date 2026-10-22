import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import { and, count, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { SetupStatus } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { SettingsService } from '../services/settings.js';

/**
 * Administration → Set up Atlas: whether each part of a new installation is done, read from what's really there
 * (an email server saved, a client added, a backup taken), so a step ticks itself off however it was done.
 */
export function registerSetupRoutes(
  app: FastifyInstance,
  deps: { db: Database; authed: { onRequest: onRequestHookHandler }; settings: SettingsService },
) {
  const { db, authed, settings } = deps;
  app.get('/api/admin/setup', authed, async (req): Promise<SetupStatus> => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    const orgId = actor.orgId;
    const total = async (query: Promise<{ n: number }[]>) => ((await query)[0]?.n ?? 0) > 0;
    const [branding, smtp, rmm, microsoft, client, team, imported, backedUp] = await Promise.all([
      settings.branding(orgId),
      settings.smtpConfig(orgId),
      settings.cwRmm(orgId),
      settings.m365(orgId),
      total(db.select({ n: count() }).from(schema.clients).where(eq(schema.clients.orgId, orgId))),
      db.select({ n: count() }).from(schema.users).where(eq(schema.users.orgId, orgId)),
      total(
        db
          .select({ n: count() })
          .from(schema.importJobs)
          .where(and(eq(schema.importJobs.orgId, orgId), eq(schema.importJobs.status, 'done'))),
      ),
      // Backups cover the whole installation.
      total(db.select({ n: count() }).from(schema.backupRuns).where(eq(schema.backupRuns.status, 'done'))),
    ]);
    return {
      branding: !!(branding.brandName || branding.logo || branding.accent || branding.favicon),
      email: smtp !== null,
      client,
      import: imported,
      rmm: rmm !== null,
      microsoft: microsoft !== null,
      team: (team[0]?.n ?? 0) > 1,
      backup: backedUp,
    };
  });
}
