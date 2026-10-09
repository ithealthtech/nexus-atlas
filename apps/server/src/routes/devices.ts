import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { deviceCopySchema } from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { DeviceContext, DeviceService, SignedRequest } from '../identity/devices.js';
import { Scope } from '../services/scope.js';
import type { PersonalVaultService } from '../services/personal-vault.js';
import type { VaultService } from '../services/vault.js';

declare module 'fastify' {
  interface FastifyRequest {
    device?: DeviceContext;
    rawBody?: string;
  }
}

type Limiter = { check(key: string): void; fail(key: string): void };

/**
 * Routes for apps signed in through Atlas on a person's device (the browser extension), and the account-page routes
 * that approve and sign them out. Device routes never read cookies: each request carries the device's token and is
 * signed with its key, so they are exempt from the browser's origin checks.
 */
export function registerDeviceRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    devices: DeviceService;
    vault: VaultService;
    personal: PersonalVaultService;
    limiter: Limiter;
  },
) {
  const { db, authed, devices, vault, personal, limiter } = deps;

  // ---- in Atlas: approve a device, sign one out ----
  app.get<{ Params: { code: string } }>('/api/account/apps/pairing/:code', authed, async (req) =>
    devices.pairing(req.session!.actor, req.params.code),
  );
  app.post<{ Params: { code: string } }>('/api/account/apps/pairing/:code/approve', authed, async (req) => {
    await devices.approve(req.session!, req.params.code, req.ip);
    return { ok: true };
  });
  app.delete<{ Params: { code: string } }>('/api/account/apps/pairing/:code', authed, async (req) => {
    await devices.deny(req.session!.actor, req.params.code);
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/api/account/apps/:id', authed, async (req) => {
    await devices.remove(req.session!, req.params.id, req.ip);
    return { ok: true };
  });

  // ---- on the device ----
  return app.register(async (device) => {
    // Signatures cover the body exactly as sent, so keep it before parsing.
    device.removeContentTypeParser('application/json');
    const json = device.getDefaultJsonParser('error', 'error');
    device.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      req.rawBody = body as string;
      json(req, body as string, done);
    });

    const signedRequest = (req: FastifyRequest): SignedRequest => {
      // Only the device paths themselves, not the /api/v1 copies API keys use.
      if ((req.raw as { atlasApi?: boolean }).atlasApi) throw new HttpError(404, 'Not found.');
      return {
        method: req.method,
        url: req.originalUrl,
        headers: req.headers,
        body: req.rawBody ?? '',
        ip: req.ip,
        userAgent: String(req.headers['user-agent'] ?? ''),
      };
    };
    const signed = {
      preHandler: async (req: FastifyRequest) => {
        req.device = await devices.authenticate(signedRequest(req));
      },
    };
    const scopeOf = (req: FastifyRequest) => new Scope(db, req.device!.actor);

    // Asking to sign in needs no account, so every request counts toward the per-address limit.
    device.post('/api/device/pair', async (req, reply) => {
      limiter.check(req.ip);
      limiter.fail(req.ip);
      const pairing = await devices.pair(req.body, { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
      return reply.status(201).send(pairing);
    });
    device.post<{ Params: { id: string } }>('/api/device/pair/:id/session', async (req, reply) => {
      limiter.check(req.ip);
      try {
        const result = await devices.collect(req.params.id, signedRequest(req));
        return reply.status(result.status === 'pending' ? 202 : 200).send(result);
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) limiter.fail(req.ip);
        throw error;
      }
    });

    device.get('/api/device/session', signed, async (req) => {
      const { device: row, user, organization } = req.device!;
      return devices.info(row, user, organization);
    });
    device.delete('/api/device/session', signed, async (req) => {
      await devices.signOut(req.device!, req.ip);
      return { ok: true };
    });
    // The person's own logins come first, then the shared vault's. Each id belongs to exactly one of the two.
    device.get<{ Querystring: { url?: string } }>('/api/device/logins', signed, async (req) => {
      const scope = scopeOf(req);
      const url = String(req.query.url ?? '').slice(0, 2048);
      const [own, shared] = await Promise.all([personal.matchingLogins(scope, url), vault.matchingLogins(scope, url)]);
      const rank = { exact: 0, domain: 1 } as const;
      return [...own, ...shared].sort((a, b) => rank[a.match ?? 'domain'] - rank[b.match ?? 'domain']).slice(0, 50);
    });
    device.get<{ Querystring: { q?: string } }>('/api/device/logins/search', signed, async (req) => {
      const scope = scopeOf(req);
      const q = String(req.query.q ?? '');
      const [own, shared] = await Promise.all([personal.searchLogins(scope, q), vault.searchLogins(scope, q)]);
      return [...own, ...shared].slice(0, 25);
    });
    device.post<{ Params: { id: string } }>('/api/device/logins/:id/fill', signed, async (req) => {
      const scope = scopeOf(req);
      return (await personal.owns(scope, req.params.id))
        ? personal.fill(scope, req.params.id, req.body)
        : vault.fill(scope, req.params.id, req.body, req.ip);
    });
    // Copying goes through the same reveal as the web app, so access, reasons, and the audit entry are identical.
    device.post<{ Params: { id: string } }>('/api/device/logins/:id/copy', signed, async (req) => {
      const body = deviceCopySchema.parse(req.body ?? {});
      const scope = scopeOf(req);
      if (await personal.owns(scope, req.params.id))
        return personal.reveal(scope, req.params.id, { field: body.field });
      return vault.reveal(scope, req.params.id, { ...body, copy: true }, req.ip);
    });
  });
}
