import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { schema, type Database } from '@atlas/db';
import { z } from 'zod';
import { licenseAssignmentSchema } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { LicenseService } from '../services/licenses.js';
import { Scope } from '../services/scope.js';
import type { SettingsService } from '../services/settings.js';
import { gdapClient } from './m365-gdap.js';

export function registerLicenseRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    fetcher?: typeof fetch;
  },
) {
  const { db, authed, settings } = deps;
  const service = new LicenseService();
  const scopeOf = (req: FastifyRequest) => new Scope(db, req.session!.actor);
  type Params = { clientId: string; id: string };
  const base = '/api/clients/:clientId/licenses';
  app.get<{ Params: Params }>(base, authed, async (req) => {
    const scope = scopeOf(req);
    const licenses = await service.list(scope, req.params.clientId);
    const saved = await settings.m365(scope.actor.orgId);
    const link = saved?.tenants[req.params.clientId];
    return {
      licenses,
      microsoft: link
        ? { tenantId: link.tenantId, name: link.tenantName, mode: saved?.authMode ?? 'application' }
        : null,
    };
  });
  app.post<{ Params: Params }>(base, authed, async (req, reply) =>
    reply.status(201).send(await service.create(scopeOf(req), req.params.clientId, req.body)),
  );
  app.put<{ Params: Params }>(base + '/:id', authed, async (req) =>
    service.update(scopeOf(req), req.params.clientId, req.params.id, req.body),
  );
  app.delete<{ Params: Params }>(base + '/:id', authed, async (req) => {
    const { version } = z.object({ version: z.number().int().positive() }).parse(req.body);
    await service.remove(scopeOf(req), req.params.clientId, req.params.id, version);
    return { ok: true };
  });
  const connected = async (req: FastifyRequest<{ Params: Params }>, write: boolean) => {
    const scope = scopeOf(req);
    await scope.require(req.params.clientId, write ? 'edit' : 'read', 'Client');
    if (write) {
      requireAdmin(scope.actor);
      deps.recent(req);
    }
    const saved = await settings.m365(scope.actor.orgId);
    const link = saved?.tenants[req.params.clientId];
    if (!link) throw new HttpError(404, 'No Microsoft 365 tenant is linked to this client.');
    if (saved?.authMode !== 'gdap')
      throw new HttpError(409, 'Connect Microsoft 365 through GDAP to manage this client’s licenses.');
    return {
      scope,
      tenantId: link.tenantId,
      client: await gdapClient(settings, scope.actor.orgId, deps.fetcher, true),
    };
  };
  app.get<{ Params: Params }>(base + '/microsoft', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const { client, tenantId } = await connected(req, false);
    return client.licenses(tenantId);
  });
  app.post<{ Params: Params }>(base + '/microsoft/assignments', authed, async (req) => {
    const { scope, client, tenantId } = await connected(req, true);
    const body = licenseAssignmentSchema.parse(req.body);
    const current = await client.licenses(tenantId);
    const user = current.users.find((u) => u.id.toLowerCase() === body.userId.toLowerCase());
    const sku = current.skus.find((s) => s.id.toLowerCase() === body.skuId.toLowerCase());
    if (!user || !sku) throw new HttpError(404, 'User or license not found in this client’s tenant.');
    if (body.action === 'assign' && user.skuIds.includes(body.skuId))
      throw new HttpError(409, 'This user already has that license.');
    if (body.action === 'assign' && (sku.assigned >= sku.enabled || sku.status !== 'Enabled'))
      throw new HttpError(409, 'There are no active seats available.');
    if (body.action === 'remove' && !user.skuIds.includes(body.skuId))
      throw new HttpError(409, 'This user does not have that license.');
    if (body.action === 'remove' && user.groupSkuIds.includes(body.skuId))
      throw new HttpError(
        409,
        'This license is assigned through a group. Manage its group membership in Microsoft Entra.',
      );
    const event = async (action: string) =>
      db.insert(schema.securityEvents).values({
        orgId: scope.actor.orgId,
        userId: scope.actor.id,
        actor: scope.actor.name,
        action,
        detail: `Client ${req.params.clientId}; tenant ${tenantId}; user ${body.userId}; SKU ${body.skuId}; ${body.action}`,
        ip: req.ip,
      });
    // Record intent before Microsoft is called; a failed local audit write must prevent the external change.
    await event('Microsoft 365 license change requested via GDAP');
    try {
      await client.assignLicense(tenantId, body.userId, body.skuId, body.action);
    } catch (error) {
      await event('Microsoft 365 license change not confirmed via GDAP');
      throw error;
    }
    await event('Microsoft 365 license change confirmed via GDAP');
    return { ok: true };
  });
}
