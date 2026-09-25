import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { ITEM_TYPES, type ItemType } from '@atlas/shared';
import type { Database } from '@atlas/db';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { listActivity } from '../services/activity.js';
import { AssetService } from '../services/assets.js';
import { AttachmentService } from '../services/attachments.js';
import type { DomainLookup } from '../services/domain-lookup.js';
import { DocumentService } from '../services/documents.js';
import { LayoutService, ensureDefaultLayouts } from '../services/layouts.js';
import { contacts, locations } from '../services/people.js';
import { RelationService } from '../services/relations.js';
import { Scope, isUuid } from '../services/scope.js';
import { search } from '../services/search.js';
import type { FileStorage } from '../services/storage.js';

type Params = { id: string };
const restoreSchema = z.object({ version: z.number().int().positive(), expectedVersion: z.number().int().positive() });
const archiveSchema = z.object({ archived: z.boolean() });
const itemType = (value: string): ItemType => {
  if (!(ITEM_TYPES as readonly string[]).includes(value)) throw new HttpError(404, 'Not found.');
  return value as ItemType;
};
const flag = (value: unknown) => value === 'true' || value === '1';

export function registerDocumentationRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    storage: FileStorage;
    maxUploadBytes: number;
    domains?: DomainLookup;
  },
) {
  const { db, authed } = deps;
  const layouts = new LayoutService(db);
  // Saves from the app fill blank Domains fields from the domain itself; imports don't look anything up.
  const assets = new AssetService(layouts, deps.domains);
  const documents = new DocumentService();
  const relations = new RelationService();
  const attachments = new AttachmentService(deps.storage, deps.maxUploadBytes);
  const scopeOf = (req: FastifyRequest) => new Scope(db, req.session!.actor);

  // ---- asset layouts ----
  app.get('/api/layouts', authed, async (req) => {
    await ensureDefaultLayouts(db, req.session!.actor.orgId);
    return layouts.list(req.session!.actor);
  });
  app.post('/api/layouts', authed, async (req, reply) =>
    reply.status(201).send(await layouts.create(req.session!.actor, req.body)),
  );
  app.patch<{ Params: Params }>('/api/layouts/:id', authed, async (req) =>
    layouts.update(req.session!.actor, req.params.id, req.body),
  );

  // ---- assets ----
  app.get<{ Querystring: { client?: string; layout?: string; archived?: string } }>(
    '/api/assets',
    authed,
    async (req) =>
      assets.list(scopeOf(req), {
        clientId: req.query.client,
        layoutId: req.query.layout,
        archived: flag(req.query.archived),
      }),
  );
  app.post<{ Params: Params }>('/api/clients/:id/assets', authed, async (req, reply) =>
    reply.status(201).send(await assets.create(scopeOf(req), req.params.id, req.body)),
  );
  // "Refresh from domain" in the asset form: looks the domain up without saving anything.
  app.post<{ Body: { domain?: unknown } }>('/api/domains/lookup', authed, async (req) => {
    const domain = req.body?.domain;
    if (typeof domain !== 'string' || domain.length > 300) throw new HttpError(400, 'Enter a domain name.');
    if (!deps.domains) throw new HttpError(503, 'Domain lookups are not available on this server.');
    const details = await deps.domains.lookup(domain);
    if (!details) throw new HttpError(400, 'That is not a domain name, for example example.com.');
    return details;
  });
  app.get<{ Params: Params }>('/api/assets/:id', authed, async (req) => assets.get(scopeOf(req), req.params.id));
  app.patch<{ Params: Params }>('/api/assets/:id', authed, async (req) =>
    assets.update(scopeOf(req), req.params.id, req.body),
  );
  app.post<{ Params: Params }>('/api/assets/:id/archive', authed, async (req) =>
    assets.setArchived(scopeOf(req), req.params.id, archiveSchema.parse(req.body).archived),
  );
  app.get<{ Params: Params }>('/api/assets/:id/revisions', authed, async (req) =>
    assets.revisions(scopeOf(req), req.params.id),
  );
  app.get<{ Params: Params & { version: string } }>('/api/assets/:id/revisions/:version', authed, async (req) =>
    assets.revision(scopeOf(req), req.params.id, Number(req.params.version)),
  );
  app.post<{ Params: Params }>('/api/assets/:id/restore', authed, async (req) => {
    const body = restoreSchema.parse(req.body);
    return assets.restore(scopeOf(req), req.params.id, body.version, body.expectedVersion);
  });

  // ---- documents and folders ----
  app.get<{ Querystring: { client?: string; folder?: string; archived?: string; status?: string } }>(
    '/api/documents',
    authed,
    async (req) =>
      documents.list(scopeOf(req), {
        clientId: req.query.client,
        folderId: req.query.folder,
        archived: flag(req.query.archived),
        status: req.query.status,
      }),
  );
  app.post('/api/documents', authed, async (req, reply) =>
    reply.status(201).send(await documents.create(scopeOf(req), req.body)),
  );
  app.get<{ Params: Params }>('/api/documents/:id', authed, async (req) => documents.get(scopeOf(req), req.params.id));
  app.patch<{ Params: Params }>('/api/documents/:id', authed, async (req) =>
    documents.update(scopeOf(req), req.params.id, req.body),
  );
  app.post<{ Params: Params }>('/api/documents/:id/archive', authed, async (req) =>
    documents.setArchived(scopeOf(req), req.params.id, archiveSchema.parse(req.body).archived),
  );
  app.get<{ Params: Params }>('/api/documents/:id/revisions', authed, async (req) =>
    documents.revisions(scopeOf(req), req.params.id),
  );
  app.get<{ Params: Params & { version: string } }>('/api/documents/:id/revisions/:version', authed, async (req) =>
    documents.revision(scopeOf(req), req.params.id, Number(req.params.version)),
  );
  app.post<{ Params: Params }>('/api/documents/:id/restore', authed, async (req) => {
    const body = restoreSchema.parse(req.body);
    return documents.restore(scopeOf(req), req.params.id, body.version, body.expectedVersion);
  });
  app.get<{ Querystring: { client?: string } }>('/api/folders', authed, async (req) =>
    documents.folders(scopeOf(req), req.query.client || null),
  );
  app.post('/api/folders', authed, async (req, reply) =>
    reply.status(201).send(await documents.createFolder(scopeOf(req), req.body)),
  );
  app.delete<{ Params: Params }>('/api/folders/:id', authed, async (req) => {
    await documents.deleteFolder(scopeOf(req), req.params.id);
    return { ok: true };
  });

  // ---- contacts and locations ----
  for (const [path, service] of [
    ['contacts', contacts],
    ['locations', locations],
  ] as const) {
    app.get<{ Params: Params }>(`/api/clients/:id/${path}`, authed, async (req) =>
      service.list(scopeOf(req), req.params.id),
    );
    app.post<{ Params: Params }>(`/api/clients/:id/${path}`, authed, async (req, reply) =>
      reply.status(201).send(await service.create(scopeOf(req), req.params.id, req.body)),
    );
    app.patch<{ Params: Params }>(`/api/${path}/:id`, authed, async (req) =>
      service.update(scopeOf(req), req.params.id, req.body),
    );
    app.delete<{ Params: Params }>(`/api/${path}/:id`, authed, async (req) => {
      await service.remove(scopeOf(req), req.params.id);
      return { ok: true };
    });
  }

  // ---- relationships and attachments (any item type) ----
  app.get<{ Params: { type: string; id: string } }>('/api/items/:type/:id/relations', authed, async (req) =>
    relations.list(scopeOf(req), itemType(req.params.type), req.params.id),
  );
  app.post<{ Params: { type: string; id: string } }>('/api/items/:type/:id/relations', authed, async (req) =>
    relations.add(scopeOf(req), itemType(req.params.type), req.params.id, req.body),
  );
  app.delete<{ Params: { type: string; id: string; relationId: string } }>(
    '/api/items/:type/:id/relations/:relationId',
    authed,
    async (req) => {
      if (!isUuid(req.params.relationId)) throw new HttpError(404, 'Link not found.');
      return relations.remove(scopeOf(req), itemType(req.params.type), req.params.id, req.params.relationId);
    },
  );
  app.get<{ Params: { type: string; id: string } }>('/api/items/:type/:id/attachments', authed, async (req) =>
    attachments.list(scopeOf(req), itemType(req.params.type), req.params.id),
  );
  app.post<{ Params: { type: string; id: string } }>('/api/items/:type/:id/attachments', authed, async (req, reply) =>
    reply
      .status(201)
      .send(await attachments.upload(scopeOf(req), itemType(req.params.type), req.params.id, await req.file())),
  );
  app.get<{ Params: Params; Querystring: { inline?: string } }>(
    '/api/attachments/:id/content',
    authed,
    async (req, reply) => {
      const { row, stream } = await attachments.open(scopeOf(req), req.params.id);
      const inline = flag(req.query.inline) && row.contentType.startsWith('image/');
      return reply
        .header('Content-Type', row.contentType)
        .header('Content-Length', String(row.size))
        .header(
          'Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        )
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, no-store')
        .send(stream);
    },
  );
  app.delete<{ Params: Params }>('/api/attachments/:id', authed, async (req) => {
    await attachments.remove(scopeOf(req), req.params.id);
    return { ok: true };
  });

  // ---- search and activity ----
  app.get<{ Querystring: { q?: string; client?: string } }>('/api/search', authed, async (req) =>
    search(scopeOf(req), String(req.query.q ?? ''), { clientId: req.query.client || undefined }),
  );
  app.get<{ Querystring: { client?: string; item?: string; limit?: string } }>('/api/activity', authed, async (req) =>
    listActivity(scopeOf(req), {
      clientId: req.query.client || undefined,
      entityId: isUuid(req.query.item) ? req.query.item : undefined,
      limit: Number(req.query.limit) || 50,
    }),
  );
}
