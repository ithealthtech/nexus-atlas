import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { restoreCheckSchema, restoreRequestSchema, type BackupRunView, type RestoreCheck } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { BackupService } from '../backup/service.js';
import { RESTORE_UPLOAD_BYTES, type RestoreService } from '../backup/staged.js';
import type { IdentityService } from '../identity/service.js';
import { isUuid } from '../services/scope.js';
import { HttpError } from '../errors.js';
import type { StatusService } from '../services/status.js';
import { securityEvent } from '../services/security-log.js';

/** The system status page and backups (administrators only). */
export function registerOpsRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    identity: IdentityService;
    status: StatusService;
    backups: BackupService;
    restores: RestoreService;
    restart: () => void;
  },
) {
  const { db, authed, recent, status, backups, restores } = deps;
  const admin = (req: FastifyRequest) => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    return actor;
  };
  const event = (req: FastifyRequest, action: string, detail: string) =>
    securityEvent(db, {
      orgId: req.session!.actor.orgId,
      userId: req.session!.actor.id,
      actor: req.session!.actor.name,
      action,
      detail,
      ip: req.ip,
    });

  app.get('/api/status', authed, async (req) => status.status(admin(req)));

  app.get('/api/backups', authed, async (req) => {
    admin(req);
    return backups.list();
  });

  // Starts a backup and answers as soon as it's under way; the status page follows its progress.
  app.post('/api/backups', authed, async (req, reply) => {
    const actor = admin(req);
    const started = await new Promise<BackupRunView>((resolve, reject) => {
      backups.run('manual', actor.name, resolve).catch(reject);
    });
    await event(req, 'Backup started', started.id);
    return reply.status(202).send(started);
  });

  // Backups are encrypted, but they hold everything, so downloading one needs a fresh password confirmation.
  app.get<{ Params: { id: string } }>('/api/backups/:id/download', authed, async (req, reply) => {
    admin(req);
    recent(req);
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Backup not found.');
    const file = await backups.file(req.params.id);
    await event(req, 'Backup downloaded', file.name);
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(file.size))
      .header('Content-Disposition', `attachment; filename="${file.name}"`)
      .send(createReadStream(file.path));
  });

  // Restoring a backup replaces or adds to everyone's data, so only the owner can, and only after confirming.
  const owner = (req: FastifyRequest) => {
    const actor = admin(req);
    if (actor.role !== 'owner') throw new HttpError(403, 'Only the owner can restore a backup.');
    return actor;
  };

  app.get('/api/backups/restore', authed, async (req) => {
    admin(req);
    return restores.status();
  });

  app.post('/api/backups/restore/upload', authed, async (req, reply) => {
    owner(req);
    const saved = await restores.upload(await req.file({ limits: { fileSize: RESTORE_UPLOAD_BYTES } }));
    await event(req, 'Backup uploaded for restore', saved.name);
    return reply.status(201).send(saved);
  });

  app.post('/api/backups/restore/check', authed, async (req): Promise<RestoreCheck> => {
    owner(req);
    const body = restoreCheckSchema.parse(req.body ?? {});
    return restores.check(body.source, body.masterKey);
  });

  // Checks everything, takes a safety backup before an overwrite, then restarts Atlas, which installs the backup
  // as it starts, before anyone can sign in or any scheduled job runs.
  app.post('/api/backups/restore', authed, async (req, reply) => {
    const actor = owner(req);
    const body = restoreRequestSchema.parse(req.body ?? {});
    await deps.identity.reauthenticate(req.session!, body.password, req.ip);
    if (body.overwrite && (body.confirmName ?? '').trim() !== req.session!.organization.name.trim())
      throw new HttpError(400, 'Type the organization’s name exactly as shown.', undefined, {
        confirmName: 'Type the organization’s name exactly as shown.',
      });
    const staged = await restores.stage({
      source: body.source,
      masterKey: body.masterKey,
      overwrite: body.overwrite,
      requestedByName: actor.name,
    });
    await event(
      req,
      'Backup restore requested',
      `${staged.mode === 'overwrite' ? 'Overwrite' : 'Add back'}: backup of ${staged.backupCreatedAt}`,
    );
    // Only once the answer has reached the browser.
    reply.raw.once('finish', deps.restart);
    return reply.status(202).send({ ...staged, restarting: true });
  });
}
