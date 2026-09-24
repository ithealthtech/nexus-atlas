import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import { requireAdmin } from '../authz.js';
import type { KeyProvider } from '../crypto/keys.js';
import { HttpError } from '../errors.js';
import { exportClient } from '../services/export.js';
import { getJob, ImportRun, listJobs } from '../services/importers/common.js';
import { importCsv } from '../services/importers/csv.js';
import { HuduClient, previewHudu, runHuduImport } from '../services/importers/hudu.js';
import type { SettingsService } from '../services/settings.js';
import type { FileStorage } from '../services/storage.js';
import type { VaultService } from '../services/vault.js';

/** Imports (Hudu, CSV) and per-client exports. */
export function registerDataRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    keys: KeyProvider;
    vault: VaultService;
    storage: FileStorage;
    huduFetch?: typeof fetch;
  },
) {
  const { db, authed, recent, settings, vault } = deps;
  const actorOf = (req: FastifyRequest) => req.session!.actor;
  const admin = (req: FastifyRequest) => {
    requireAdmin(actorOf(req));
    return actorOf(req);
  };
  const event = (req: FastifyRequest, action: string, detail: string) =>
    db.insert(schema.securityEvents).values({
      orgId: actorOf(req).orgId,
      userId: actorOf(req).id,
      actor: actorOf(req).name,
      action,
      detail: detail.slice(0, 300),
      ip: req.ip,
    });
  const huduClient = async (orgId: string) => {
    const saved = await settings.hudu(orgId);
    if (!saved) throw new HttpError(400, 'Connect Hudu first: enter its address and an API key.');
    return new HuduClient(saved.url, saved.apiKey, deps.huduFetch);
  };

  // ---- Hudu ----
  app.get(
    '/api/import/hudu',
    authed,
    async (req) => (await settings.huduView(admin(req).orgId)) ?? { url: '', hasKey: false },
  );
  app.put('/api/import/hudu', authed, async (req) => {
    const actor = admin(req);
    recent(req);
    await settings.saveHudu(actor.orgId, req.body);
    const view = await settings.huduView(actor.orgId);
    await event(req, 'Hudu connection saved', view?.url ?? '');
    return view;
  });
  app.delete('/api/import/hudu', authed, async (req) => {
    const actor = admin(req);
    await settings.forgetHudu(actor.orgId);
    await event(req, 'Hudu connection removed', '');
    return { ok: true };
  });
  app.post('/api/import/hudu/preview', authed, async (req) => previewHudu(await huduClient(admin(req).orgId)));
  app.post('/api/import/hudu/run', authed, async (req, reply) => {
    const actor = admin(req);
    recent(req);
    const client = await huduClient(actor.orgId);
    const run = await ImportRun.start(db, actor, 'hudu');
    await event(req, 'Hudu import started', '');
    // Runs in the background; the page polls the job for progress.
    void runHuduImport(db, actor, client, run, vault)
      .then(() => run.flush('done'))
      .catch(async (error) => {
        run.note(error instanceof HttpError ? error.message : 'The import stopped unexpectedly.');
        req.log.error({ err: error }, 'Hudu import failed');
        await run.flush('failed');
      });
    return reply.status(202).send({ id: run.jobId });
  });

  // ---- jobs ----
  app.get('/api/import/jobs', authed, async (req) => listJobs(db, admin(req).orgId));
  app.get<{ Params: { id: string } }>('/api/import/jobs/:id', authed, async (req) =>
    getJob(db, admin(req).orgId, req.params.id),
  );

  // ---- CSV ----
  // Larger body limit: a sheet of a few thousand rows.
  app.post('/api/import/csv', { ...authed, bodyLimit: 10 * 1024 * 1024 }, async (req) =>
    importCsv(db, actorOf(req), req.body, vault),
  );

  // ---- export ----
  app.get<{ Params: { id: string }; Querystring: { passwords?: string } }>(
    '/api/clients/:id/export',
    authed,
    async (req, reply) => {
      const withPasswords = req.query.passwords === 'true';
      if (withPasswords) {
        admin(req);
        recent(req);
      }
      const { filename, data } = await exportClient(db, actorOf(req), req.params.id, {
        passwords: withPasswords,
        ip: req.ip,
        storage: deps.storage,
        vault,
      });
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`)
        .send(Buffer.from(data));
    },
  );
}
