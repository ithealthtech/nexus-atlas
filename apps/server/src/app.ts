import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { sql } from 'drizzle-orm';
import type { DatabaseHandle } from '@atlas/db';
import { changePasswordSchema, mfaSchema, signInSchema, type SessionView } from '@atlas/shared';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import type { KeyProvider } from './crypto/keys.js';
import { IdentityService, sameSecret, type SessionContext } from './identity/service.js';
import { ClientService } from './services/clients.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionContext | null;
  }
}

export interface AppOptions {
  config: Config;
  database: DatabaseHandle;
  keys: KeyProvider;
  setupCode?: string;
}

// Paths an account may use before it finishes MFA, a required password change, or MFA enrollment.
const STAGE_ROUTES: Record<string, string[]> = {
  mfa: ['POST /api/session/mfa'],
  password: ['POST /api/account/password'],
  'mfa-setup': ['POST /api/account/mfa/setup', 'POST /api/account/mfa/confirm'],
};

/** Per-address failure counter for unauthenticated endpoints (sign-in, setup, MFA). */
function failureLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return {
    check(key: string) {
      const entry = hits.get(key);
      if (entry && entry.reset > Date.now() && entry.count >= max)
        throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
    },
    fail(key: string) {
      const now = Date.now();
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      const entry = hits.get(key);
      if (!entry || entry.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
      else entry.count++;
    },
  };
}

export async function buildApp({ config, database, keys, setupCode = '' }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  });
  const { db } = database;
  const identity = new IdentityService(db, keys, { requireStaffMfa: config.ATLAS_REQUIRE_STAFF_MFA });
  const clients = new ClientService(db);
  const limiter = failureLimiter(10, 15 * 60_000);
  const cookieName = config.secureCookies ? '__Host-atlas_session' : 'atlas_session';
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, path: '/', secure: config.secureCookies };
  const devHosts = config.NODE_ENV === 'production' ? [] : ['127.0.0.1', 'localhost'];

  await app.register(cookie);

  // ---- security headers and request checks ----
  app.addHook('onRequest', async (req) => {
    req.session = null;
    const host = req.host;
    const hostname = host.replace(/:\d+$/, '');
    // Host must match PUBLIC_URL (blocks DNS rebinding); loopback is also allowed outside production.
    if (req.url !== '/healthz' && host !== config.publicHost && !devHosts.includes(hostname))
      throw new HttpError(403, 'Unknown host.');
    const origin = req.headers.origin;
    if (origin && origin !== config.publicOrigin && !(devHosts.length && origin === `${req.protocol}://${host}`))
      throw new HttpError(403, 'Origin is not allowed.');
    if (req.headers['sec-fetch-site'] === 'cross-site')
      throw new HttpError(403, 'Cross-site requests are not allowed.');
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    if (error instanceof ZodError) {
      const fields = Object.fromEntries(error.issues.map((i) => [i.path.join('.') || 'body', i.message]));
      return reply.status(400).send({ error: error.issues[0]?.message ?? 'Check the highlighted fields.', fields });
    }
    if (error instanceof HttpError) {
      // Only an invalid session clears the cookie; a wrong password or code keeps the sign-in in progress.
      if (error.code === 'session' && req.cookies[cookieName]) reply.clearCookie(cookieName, cookieOptions);
      return reply.status(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    if (error.statusCode && error.statusCode < 500)
      return reply
        .status(error.statusCode)
        .send({ error: error.statusCode === 413 ? 'Request is too large.' : 'Invalid request.' });
    req.log.error(error);
    return reply.status(500).send({ error: 'Something went wrong. Please try again.' });
  });

  // ---- session helpers ----
  const view = (c: SessionContext): SessionView => ({
    actor: c.actor,
    csrf: c.session.csrf,
    stage: c.stage,
    organization: c.organization,
  });
  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: 12 * 3600 });
  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });

  async function authenticate(req: FastifyRequest) {
    const context = await identity.resolve(req.cookies[cookieName]);
    if (!context) throw new HttpError(401, 'Sign in to continue.', 'session');
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      !sameSecret(String(req.headers['x-csrf-token'] ?? ''), context.session.csrf)
    )
      throw new HttpError(403, 'Session verification failed. Reload the page.');
    const allowed = STAGE_ROUTES[context.stage];
    if (allowed && !allowed.includes(`${req.method} ${req.routeOptions.url}`))
      throw new HttpError(403, 'Finish signing in to continue.', 'stage');
    req.session = context;
  }
  const authed = { onRequest: authenticate };
  const actorOf = (req: FastifyRequest) => req.session!.actor;

  // ---- health ----
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  // ---- setup and sign-in ----
  app.get('/api/setup', async () => ({ needed: await identity.needsSetup() }));
  app.post('/api/setup', async (req, reply) => {
    limiter.check(req.ip);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!(await identity.needsSetup())) throw new HttpError(409, 'Atlas is already set up. Sign in instead.');
    if (!setupCode || !sameSecret(String(body.setupCode ?? ''), setupCode)) {
      limiter.fail(req.ip);
      throw new HttpError(403, 'The setup code is incorrect. Copy it from the server console.');
    }
    const user = await identity.bootstrap(body, meta(req));
    const { token } = await identity.createSession(user, meta(req));
    setSession(reply, token);
    return reply.status(201).send(view((await identity.resolve(token))!));
  });

  app.post('/api/session', async (req, reply) => {
    limiter.check(req.ip);
    const body = signInSchema.parse(req.body ?? {});
    let user;
    try {
      user = await identity.authenticate(body.email, body.password, meta(req));
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 429)) limiter.fail(req.ip);
      throw error;
    }
    const previous = await identity.resolve(req.cookies[cookieName]);
    if (previous) await identity.signOut(previous, req.ip);
    const { token } = await identity.createSession(user, meta(req));
    setSession(reply, token);
    return view((await identity.resolve(token))!);
  });
  app.get('/api/session', authed, async (req) => view(req.session!));
  app.delete('/api/session', authed, async (req, reply) => {
    await identity.signOut(req.session!, req.ip);
    reply.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  });
  app.post('/api/session/mfa', authed, async (req) => {
    limiter.check(req.ip);
    const { code } = mfaSchema.parse(req.body ?? {});
    try {
      await identity.verifyMfa(req.session!, code, req.ip);
    } catch (error) {
      if (error instanceof HttpError && (error.code === 'mfa_invalid' || error.status === 429)) limiter.fail(req.ip);
      throw error;
    }
    return view((await identity.resolve(req.cookies[cookieName]))!);
  });

  // ---- account ----
  app.post('/api/account/password', authed, async (req) => {
    const body = changePasswordSchema.parse(req.body ?? {});
    await identity.changePassword(req.session!, body.current, body.next, req.ip);
    return view((await identity.resolve(req.cookies[cookieName]))!);
  });
  app.post('/api/account/mfa/setup', authed, async (req) => identity.beginMfa(req.session!));
  app.post('/api/account/mfa/confirm', authed, async (req) => {
    const { code } = mfaSchema.parse(req.body ?? {});
    await identity.confirmMfa(req.session!, code, req.ip);
    return view((await identity.resolve(req.cookies[cookieName]))!);
  });

  // ---- administration ----
  app.get('/api/users', authed, async (req) => identity.listUsers(actorOf(req)));
  app.post('/api/users', authed, async (req, reply) =>
    reply.status(201).send(await identity.createUser(actorOf(req), req.body, req.ip)),
  );
  app.patch<{ Params: { id: string } }>('/api/users/:id', authed, async (req) =>
    identity.updateUser(actorOf(req), req.params.id, req.body, req.ip),
  );
  app.post<{ Params: { id: string } }>('/api/users/:id/reset', authed, async (req) =>
    identity.resetUser(actorOf(req), req.params.id, req.body, req.ip),
  );
  app.get('/api/security-events', authed, async (req) => identity.events(actorOf(req)));

  // ---- clients ----
  app.get('/api/clients', authed, async (req) => clients.list(actorOf(req)));
  app.post('/api/clients', authed, async (req, reply) =>
    reply.status(201).send(await clients.create(actorOf(req), req.body)),
  );
  app.get<{ Params: { id: string } }>('/api/clients/:id', authed, async (req) =>
    clients.get(actorOf(req), req.params.id),
  );
  app.patch<{ Params: { id: string } }>('/api/clients/:id', authed, async (req) =>
    clients.update(actorOf(req), req.params.id, req.body),
  );

  // The password vault and BitLocker collection stay closed until M2.
  app.all('/api/vault/*', async () => {
    throw new HttpError(501, 'The password vault is not available in this build.');
  });

  app.all('/api/*', async () => {
    throw new HttpError(404, 'Not found.');
  });

  // ---- web app ----
  if (config.WEB_DIST && existsSync(config.WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: config.WEB_DIST,
      wildcard: false,
      index: false,
      maxAge: '1h',
      immutable: false,
    });
    app.get('/assets/*', async (req, reply) => reply.callNotFound());
    // Client-side routes all load index.html.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/assets/'))
        return reply.status(404).send({ error: 'Not found.' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
