import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import type { BackupRunView } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { BackupService } from '../backup/service.js';
import { isUuid } from '../services/scope.js';
import { HttpError } from '../errors.js';
import type { StatusService } from '../services/status.js';

/** The system status page and backups (administrators only). */
export function registerOpsRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    status: StatusService;
    backups: BackupService;
  },
) {
  const { db, authed, recent, status, backups } = deps;
  const admin = (req: FastifyRequest) => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    return actor;
  };
  const event = (req: FastifyRequest, action: string, detail: string) =>
    db.insert(schema.securityEvents).values({
      orgId: req.session!.actor.orgId,
      userId: req.session!.actor.id,
      actor: req.session!.actor.name,
      action,
      detail: detail.slice(0, 300),
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
}
