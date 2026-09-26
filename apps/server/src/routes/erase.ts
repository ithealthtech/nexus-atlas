import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { eraseConfirmSchema, eraseRequestSchema } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';
import type { BackupService } from '../backup/service.js';
import { ERASE_WAIT_MS, ERASE_WINDOW_MS, eraseDocumentation, eraseStatus, requireOwner } from '../services/erase.js';
import type { MailService } from '../services/mail.js';
import type { SettingsService } from '../services/settings.js';
import type { FileStorage } from '../services/storage.js';

/**
 * Erase all data: owner only, in two steps. The request needs the owner's password, a fresh authenticator code,
 * and the organization's name typed exactly; it starts a wait every administrator is emailed about and can cancel.
 * After the wait the owner confirms (name again, password recently confirmed); a full backup is taken first, and
 * nothing is erased if it fails.
 */
export function registerEraseRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    identity: IdentityService;
    settings: SettingsService;
    mail: MailService;
    backups: BackupService;
    storage: FileStorage;
  },
) {
  const { db, authed, settings } = deps;
  const event = (req: FastifyRequest, action: string, detail = '') =>
    db.insert(schema.securityEvents).values({
      orgId: req.session!.actor.orgId,
      userId: req.session!.actor.id,
      actor: req.session!.actor.name,
      action,
      detail: detail.slice(0, 300),
      ip: req.ip,
    });
  const nameMatches = (req: FastifyRequest, typed: string) => {
    if (typed.trim() !== req.session!.organization.name.trim())
      throw new HttpError(400, 'Type the organization’s name exactly as shown.', undefined, {
        confirmName: 'Type the organization’s name exactly as shown.',
      });
  };
  /** Tells every administrator; email trouble never blocks the safeguard it reports on. */
  const tellAdmins = async (req: FastifyRequest, subject: string, paragraphs: string[]) => {
    const { orgId } = req.session!.actor;
    const org = req.session!.organization;
    const admins = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.orgId, orgId),
          eq(schema.users.disabled, false),
          inArray(schema.users.role, ['owner', 'admin']),
        ),
      );
    for (const a of admins)
      await deps.mail.send(orgId, org.name, { to: a.email, subject, paragraphs }).catch(() => undefined);
  };

  app.get('/api/org/erase', authed, async (req) => {
    requireAdmin(req.session!.actor);
    return eraseStatus(await settings.eraseRequest(req.session!.actor.orgId));
  });

  app.post('/api/org/erase/request', authed, async (req) => {
    const { actor, user } = req.session!;
    requireOwner(actor.role);
    const body = eraseRequestSchema.parse(req.body ?? {});
    nameMatches(req, body.confirmName);
    if (eraseStatus(await settings.eraseRequest(actor.orgId)).pending)
      throw new HttpError(409, 'An erase is already pending. Cancel it first.');
    await deps.identity.reauthenticate(req.session!, body.password, req.ip);
    await deps.identity.confirmCode(user, body.code, req.ip);
    const now = Date.now();
    const request = {
      requestedAt: new Date(now).toISOString(),
      confirmableAt: new Date(now + ERASE_WAIT_MS).toISOString(),
      expiresAt: new Date(now + ERASE_WAIT_MS + ERASE_WINDOW_MS).toISOString(),
      requestedBy: actor.id,
      requestedByName: actor.name,
    };
    await settings.saveEraseRequest(actor.orgId, request);
    await event(req, 'Erase all data requested', `Confirmable after ${request.confirmableAt}`);
    await tellAdmins(req, 'Atlas: erase all data was requested', [
      `${actor.name} asked to erase all documentation in Atlas: clients, assets, documents, and passwords.`,
      'Nothing is erased for at least 10 minutes. Any administrator can cancel it in Settings → Danger zone.',
      'If you did not expect this, cancel it now and change the owner’s password.',
    ]);
    return eraseStatus(request);
  });

  app.delete('/api/org/erase', authed, async (req) => {
    const { actor } = req.session!;
    requireAdmin(actor);
    if (!eraseStatus(await settings.eraseRequest(actor.orgId)).pending) return { pending: null };
    await settings.saveEraseRequest(actor.orgId, null);
    await event(req, 'Erase all data cancelled');
    await tellAdmins(req, 'Atlas: erase all data was cancelled', [
      `${actor.name} cancelled the request to erase all data. Nothing was erased.`,
    ]);
    return { pending: null };
  });

  app.post('/api/org/erase/confirm', authed, async (req) => {
    const { actor } = req.session!;
    requireOwner(actor.role);
    deps.recent(req);
    nameMatches(req, eraseConfirmSchema.parse(req.body ?? {}).confirmName);
    const { pending } = eraseStatus(await settings.eraseRequest(actor.orgId));
    if (!pending) throw new HttpError(409, 'There is no erase request to confirm. Request it again.');
    if (!pending.confirmable) throw new HttpError(409, `Wait until ${pending.confirmableAt} to confirm.`);
    // A backup first: if it fails, nothing is erased.
    const backup = await deps.backups.run('manual', `${actor.name} (before erasing all data)`).catch((error) => {
      throw new HttpError(502, `The backup before erasing failed, so nothing was erased: ${(error as Error).message}`);
    });
    if (backup.status !== 'done')
      throw new HttpError(
        502,
        `The backup before erasing failed, so nothing was erased: ${backup.error ?? 'unknown error'}`,
      );
    const counts = await eraseDocumentation(db, actor.orgId, deps.storage);
    await settings.saveEraseRequest(actor.orgId, null);
    // Company links pointed at clients that are gone; the connection itself is kept.
    if (await settings.cwRmmView(actor.orgId)) await settings.patchCwRmm(actor.orgId, { map: {}, lastSyncAt: null });
    const summary = `${counts.clients} clients, ${counts.documents} documents, ${counts.layouts} layouts, ${counts.files} files; backup ${backup.fileName}`;
    await event(req, 'All data erased', summary);
    await tellAdmins(req, 'Atlas: all data was erased', [
      `${actor.name} erased all documentation in Atlas (${summary}).`,
      `A full backup was taken first: ${backup.fileName}. Restoring it brings everything back.`,
    ]);
    return { ...counts, backup: backup.fileName };
  });
}
