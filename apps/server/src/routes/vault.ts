import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { z } from 'zod';
import type { VaultKeys } from '../crypto/vault-keys.js';
import { HttpError } from '../errors.js';
import { Scope } from '../services/scope.js';
import { SendService } from '../services/sends.js';
import type { FileStorage } from '../services/storage.js';
import { VaultService, openShare } from '../services/vault.js';

type Params = { id: string };
const archiveSchema = z.object({ archived: z.boolean() });
// Files in the vault and in Sends are held in memory while they're encrypted or decrypted, so they're capped.
const MAX_VAULT_FILE_BYTES = 25 * 1024 * 1024;
const fileHeaders = (filename: string) => ({
  'Content-Type': 'application/octet-stream',
  'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'private, no-store',
});

export function registerVaultRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    keys: VaultKeys;
    storage: FileStorage;
    maxUploadBytes: number;
    shareLimiter: { check(key: string): void; fail(key: string): void };
  },
) {
  const { db, authed } = deps;
  const maxBytes = Math.min(deps.maxUploadBytes, MAX_VAULT_FILE_BYTES);
  const vault = new VaultService(deps.keys, { storage: deps.storage, maxBytes });
  const sends = new SendService(db, deps.storage, maxBytes);
  const scopeOf = (req: FastifyRequest) => new Scope(db, req.session!.actor);

  app.get<{ Querystring: { client?: string; archived?: string } }>('/api/passwords', authed, async (req) =>
    vault.list(scopeOf(req), { clientId: req.query.client || undefined, archived: req.query.archived === 'true' }),
  );
  app.get('/api/passwords/rotation-due', authed, async (req) => vault.rotationDue(scopeOf(req)));
  // Folders: one client's, open to anyone with password access to it.
  app.get<{ Params: Params }>('/api/clients/:id/password-folders', authed, async (req) =>
    vault.folders(scopeOf(req), req.params.id),
  );
  app.post<{ Params: Params }>('/api/clients/:id/password-folders', authed, async (req, reply) =>
    reply.status(201).send(await vault.createFolder(scopeOf(req), req.params.id, req.body)),
  );
  app.patch<{ Params: Params }>('/api/password-folders/:id', authed, async (req) =>
    vault.renameFolder(scopeOf(req), req.params.id, req.body),
  );
  app.delete<{ Params: Params }>('/api/password-folders/:id', authed, async (req) =>
    vault.deleteFolder(scopeOf(req), req.params.id),
  );
  app.post<{ Params: Params }>('/api/clients/:id/passwords', authed, async (req, reply) =>
    reply.status(201).send(await vault.create(scopeOf(req), req.params.id, req.body, req.ip)),
  );
  app.get<{ Params: Params }>('/api/passwords/:id', authed, async (req) => vault.get(scopeOf(req), req.params.id));
  app.patch<{ Params: Params }>('/api/passwords/:id', authed, async (req) =>
    vault.update(scopeOf(req), req.params.id, req.body, req.ip),
  );
  app.post('/api/passwords/bulk', authed, async (req) => vault.bulk(scopeOf(req), req.body, req.ip));
  app.post<{ Params: Params }>('/api/passwords/:id/archive', authed, async (req) =>
    vault.setArchived(scopeOf(req), req.params.id, archiveSchema.parse(req.body).archived, req.ip),
  );
  // Favorites are personal: they change nothing for anyone else, so no audit entry.
  app.put<{ Params: Params }>('/api/passwords/:id/favorite', authed, async (req) =>
    vault.setFavorite(scopeOf(req), req.params.id, true),
  );
  app.delete<{ Params: Params }>('/api/passwords/:id/favorite', authed, async (req) =>
    vault.setFavorite(scopeOf(req), req.params.id, false),
  );
  app.post<{ Params: Params }>('/api/passwords/:id/reveal', authed, async (req) =>
    vault.reveal(scopeOf(req), req.params.id, req.body, req.ip),
  );
  app.get<{ Params: Params }>('/api/passwords/:id/history', authed, async (req) =>
    vault.history(scopeOf(req), req.params.id),
  );
  app.post<{ Params: Params & { historyId: string } }>(
    '/api/passwords/:id/history/:historyId/reveal',
    authed,
    async (req) => vault.revealHistory(scopeOf(req), req.params.id, req.params.historyId, req.body, req.ip),
  );
  app.get<{ Params: Params }>('/api/passwords/:id/access', authed, async (req) =>
    vault.access(scopeOf(req), req.params.id),
  );
  app.put<{ Params: Params }>('/api/passwords/:id/access', authed, async (req) =>
    vault.setAccess(scopeOf(req), req.params.id, req.body, req.ip),
  );
  app.get<{ Params: Params }>('/api/passwords/:id/audit', authed, async (req) =>
    vault.auditFor(scopeOf(req), req.params.id),
  );
  app.get('/api/vault/audit', authed, async (req) => vault.auditAll(scopeOf(req)));
  app.get<{ Params: Params }>('/api/passwords/:id/shares', authed, async (req) =>
    vault.shares(scopeOf(req), req.params.id),
  );
  app.post<{ Params: Params }>('/api/passwords/:id/shares', authed, async (req, reply) =>
    reply.status(201).send(await vault.createShare(scopeOf(req), req.params.id, req.body, req.ip)),
  );
  app.delete<{ Params: Params & { shareId: string } }>('/api/passwords/:id/shares/:shareId', authed, async (req) => {
    await vault.revokeShare(scopeOf(req), req.params.id, req.params.shareId, req.ip);
    return { ok: true };
  });

  // Files on an entry: encrypted at rest; a download is checked and recorded like a reveal.
  app.get<{ Params: Params }>('/api/passwords/:id/attachments', authed, async (req) =>
    vault.attachments(scopeOf(req), req.params.id),
  );
  app.post<{ Params: Params }>('/api/passwords/:id/attachments', authed, async (req, reply) =>
    reply.status(201).send(await vault.attach(scopeOf(req), req.params.id, await req.file(), req.ip)),
  );
  app.post<{ Params: Params & { attachmentId: string } }>(
    '/api/passwords/:id/attachments/:attachmentId/download',
    authed,
    async (req, reply) => {
      const { filename, data } = await vault.downloadAttachment(
        scopeOf(req),
        req.params.id,
        req.params.attachmentId,
        req.body,
        req.ip,
      );
      return reply.headers(fileHeaders(filename)).send(data);
    },
  );
  app.delete<{ Params: Params & { attachmentId: string } }>(
    '/api/passwords/:id/attachments/:attachmentId',
    authed,
    async (req) => {
      await vault.removeAttachment(scopeOf(req), req.params.id, req.params.attachmentId, req.ip);
      return { ok: true };
    },
  );

  // Sends: one-time text and files, encrypted in the browser.
  app.get<{ Querystring: { all?: string } }>('/api/sends', authed, async (req) =>
    sends.list(scopeOf(req), req.query.all === 'true'),
  );
  app.post('/api/sends', authed, async (req, reply) =>
    reply.status(201).send(await sends.createText(scopeOf(req), req.body, req.ip)),
  );
  app.post('/api/sends/file', authed, async (req, reply) =>
    reply.status(201).send(await sends.createFile(scopeOf(req), await req.file(), req.ip)),
  );
  app.delete<{ Params: Params }>('/api/sends/:id', authed, async (req) => {
    await sends.revoke(scopeOf(req), req.params.id, req.ip);
    return { ok: true };
  });
  // Opening a Send needs no account. A file comes back as the encrypted bytes, with its encrypted name in a header.
  app.post<{ Params: { token: string } }>('/api/sends/:token/open', async (req, reply) => {
    deps.shareLimiter.check(req.ip);
    let opened;
    try {
      opened = await sends.open(req.params.token, req.ip);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) deps.shareLimiter.fail(req.ip);
      throw error;
    }
    reply.header('Referrer-Policy', 'no-referrer');
    if (opened.kind === 'text') return reply.send(opened);
    return reply
      .headers({
        ...fileHeaders('send.bin'),
        'X-Send-Meta': opened.meta,
        'X-Send-Remaining-Views': String(opened.remainingViews),
      })
      .send(opened.data);
  });

  // Opening a share link needs no account; failures count toward the per-address limit.
  app.post<{ Params: { token: string } }>('/api/shares/:token/open', async (req, reply) => {
    deps.shareLimiter.check(req.ip);
    try {
      return reply.header('Referrer-Policy', 'no-referrer').send(await openShare(db, req.params.token, req.ip));
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) deps.shareLimiter.fail(req.ip);
      throw error;
    }
  });
  return { vault, sends };
}
