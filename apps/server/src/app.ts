import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ZodError } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { schema, type DatabaseHandle } from '@atlas/db';
import {
  DEFAULT_BRANDING,
  changePasswordSchema,
  mfaSchema,
  reauthSchema,
  recoveryCodeSchema,
  signInSchema,
  type SessionView,
} from '@atlas/shared';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import type { KeyProvider } from './crypto/keys.js';
import { IdentityService, hasMfa, sameSecret, type SessionContext } from './identity/service.js';
import { requireAdmin } from './authz.js';
import { ClientService } from './services/clients.js';
import { ensureDefaultLayouts } from './services/layouts.js';
import { LocalStorage, type FileStorage } from './services/storage.js';
import { registerDocumentationRoutes } from './routes/docs.js';
import { DomainLookup } from './services/domain-lookup.js';
import { registerVaultRoutes } from './routes/vault.js';
import { VaultKeys } from './crypto/vault-keys.js';
import { AccountSecurity, DEVICE_DAYS, type RelyingParty } from './identity/account.js';
import { MailService, defaultTransport, type MailTransport } from './services/mail.js';
import { SettingsService } from './services/settings.js';
import { AuditService } from './services/audit.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerDataRoutes } from './routes/data.js';
import { CwRmmScheduler, registerIntegrationRoutes } from './routes/integrations.js';
import { ApiKeyService } from './services/api-keys.js';
import { BackupService } from './backup/service.js';
import { registerOpsRoutes } from './routes/ops.js';
import { StatusService } from './services/status.js';
import { registerUpdateRoutes } from './routes/updates.js';
import { UpdateService } from './services/updates.js';
import { APP_VERSION } from './version.js';
import { openApiSpec } from './openapi.js';

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
  storage?: FileStorage;
  /** Replaces SMTP delivery (tests capture messages instead of sending them). */
  mailTransport?: MailTransport;
  /** Replaces fetch for Hudu imports (tests use a fake Hudu). */
  huduFetch?: typeof fetch;
  /** Replaces fetch for ConnectWise RMM (tests use a fake Asio API). */
  cwRmmFetch?: typeof fetch;
  /** Replaces RDAP/DNS lookups for Domains assets. Tests leave it out, so nothing is looked up. */
  domainLookup?: DomainLookup;
  /** Replaces fetch for the GitHub release check (tests use fake releases). */
  updateFetch?: typeof fetch;
}

// Paths an account may use before it finishes MFA, a required password change, or MFA enrollment.
const STAGE_ROUTES: Record<string, string[]> = {
  mfa: [
    'POST /api/session/mfa',
    'POST /api/session/recovery',
    'POST /api/session/passkey/options',
    'POST /api/session/passkey',
  ],
  password: ['POST /api/account/password'],
  'mfa-setup': [
    'POST /api/account/mfa/setup',
    'POST /api/account/mfa/confirm',
    'POST /api/account/passkeys/options',
    'POST /api/account/passkeys',
  ],
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

export async function buildApp({
  config,
  database,
  keys,
  setupCode = '',
  storage,
  mailTransport = defaultTransport,
  huduFetch,
  cwRmmFetch,
  domainLookup,
  updateFetch,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // The versioned REST API (/api/v1/…) serves the same routes as the app, authenticated by API key.
    rewriteUrl(req) {
      const url = req.url ?? '/';
      if (!url.startsWith('/api/v1/')) return url;
      (req as { atlasApi?: boolean }).atlasApi = true;
      return `/api/${url.slice('/api/v1/'.length)}`;
    },
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'req.headers["x-csrf-token"]',
              'res.headers["set-cookie"]',
            ],
          },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  });
  const { db } = database;
  const identity = new IdentityService(db, keys, { requireStaffMfa: config.ATLAS_REQUIRE_STAFF_MFA });
  const clients = new ClientService(db);
  const settings = new SettingsService(db, keys);
  const mail = new MailService(settings, mailTransport);
  const account = new AccountSecurity(db, identity, mail, { publicOrigin: config.publicOrigin, rpName: 'MSP Atlas' });
  const audit = new AuditService(db, keys, settings);
  const apiKeys = new ApiKeyService(db);
  const limiter = failureLimiter(10, 15 * 60_000);
  const cookieName = config.secureCookies ? '__Host-atlas_session' : 'atlas_session';
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, path: '/', secure: config.secureCookies };
  const deviceCookie = config.secureCookies ? '__Host-atlas_device' : 'atlas_device';
  const devHosts = config.NODE_ENV === 'production' ? [] : ['127.0.0.1', 'localhost'];

  await app.register(cookie);
  const maxUploadBytes = config.ATLAS_MAX_UPLOAD_MB * 1024 * 1024;
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1, fields: 5, parts: 6 } });

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
    // Routes may set a stricter policy (file downloads use a sandbox); keep theirs.
    if (!reply.hasHeader('Content-Security-Policy'))
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
      return reply.status(error.status).send({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
        ...(error.fields ? { fields: error.fields } : {}),
      });
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
    ...(c.stage === 'mfa' ? { methods: { totp: !!c.user.mfaSecret, passkey: c.user.passkeyCount > 0 } } : {}),
  });
  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: 12 * 3600 });
  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: req.headers['user-agent'] ?? '' });
  const rememberDevice = async (req: FastifyRequest, reply: FastifyReply) => {
    const token = await account.rememberDevice(req.session!.user, meta(req));
    reply.setCookie(deviceCookie, token, { ...cookieOptions, maxAge: DEVICE_DAYS * 86_400 });
  };
  const current = async (req: FastifyRequest) => view((await identity.resolve(req.cookies[cookieName]))!);
  // WebAuthn is bound to the site's host name. Outside production, loopback addresses (the dev server) also work.
  const relyingParty = (req: FastifyRequest): RelyingParty =>
    config.NODE_ENV === 'production'
      ? { id: new URL(config.publicOrigin).hostname, origin: config.publicOrigin }
      : { id: req.hostname.replace(/:\d+$/, ''), origin: new URL(`${req.protocol}://${req.host}`).origin };

  async function authenticate(req: FastifyRequest) {
    if ((req.raw as { atlasApi?: boolean }).atlasApi) {
      const key = await apiKeys.authenticate(req.headers.authorization, req.method, req.url, req.ip);
      const [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.id, key.user.orgId));
      const at = new Date();
      req.session = {
        hash: '',
        session: {
          tokenHash: '',
          id: key.keyId,
          userId: key.user.id,
          csrf: '',
          mfaVerified: true,
          reauthAt: null,
          challenge: null,
          createdAt: at,
          lastSeenAt: at,
          ip: req.ip,
          userAgent: String(req.headers['user-agent'] ?? ''),
        },
        user: key.user,
        // Audit and activity entries name the key as well as the person it acts for.
        actor: { ...key.actor, name: `${key.actor.name} (API key: ${key.keyName})`.slice(0, 120) },
        stage: 'active',
        organization: { id: org!.id, name: org!.name },
      };
      return;
    }
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
  app.get('/api/setup', async () => {
    const [org] = await db.select({ id: schema.orgs.id }).from(schema.orgs).limit(1);
    return { needed: !org, passwordReset: org ? await mail.enabled(org.id) : false };
  });
  app.post('/api/setup', async (req, reply) => {
    limiter.check(req.ip);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!(await identity.needsSetup())) throw new HttpError(409, 'Atlas is already set up. Sign in instead.');
    if (!setupCode || !sameSecret(String(body.setupCode ?? ''), setupCode)) {
      limiter.fail(req.ip);
      throw new HttpError(403, 'The setup code is incorrect. Copy it from the server console.');
    }
    const user = await identity.bootstrap(body, meta(req));
    await ensureDefaultLayouts(db, user.orgId);
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
    // A remembered device stands in for the second step on this browser.
    const trusted = hasMfa(user) && (await account.isTrusted(user, req.cookies[deviceCookie]));
    const { token } = await identity.createSession(
      user,
      meta(req),
      trusted,
      trusted ? 'Password on a remembered device' : '',
    );
    setSession(reply, token);
    return view((await identity.resolve(token))!);
  });
  app.get('/api/session', authed, async (req) => view(req.session!));
  app.delete('/api/session', authed, async (req, reply) => {
    await identity.signOut(req.session!, req.ip);
    reply.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  });
  const limited = async (req: FastifyRequest, work: () => Promise<unknown>) => {
    limiter.check(req.ip);
    try {
      await work();
    } catch (error) {
      if (error instanceof HttpError && (error.code === 'mfa_invalid' || error.status === 429)) limiter.fail(req.ip);
      throw error;
    }
  };
  const remember = (body: unknown) => (body as { remember?: unknown } | null)?.remember === true;
  app.post('/api/session/mfa', authed, async (req, reply) => {
    const { code } = mfaSchema.parse(req.body ?? {});
    await limited(req, () => identity.verifyMfa(req.session!, code, req.ip));
    if (remember(req.body)) await rememberDevice(req, reply);
    return current(req);
  });
  app.post('/api/session/recovery', authed, async (req, reply) => {
    const body = recoveryCodeSchema.parse(req.body ?? {});
    await limited(req, () => account.useRecoveryCode(req.session!, body.code, req.ip));
    if (body.remember) await rememberDevice(req, reply);
    return current(req);
  });
  app.post('/api/session/passkey/options', authed, async (req) =>
    account.secondFactorOptions(req.session!, relyingParty(req)),
  );
  app.post('/api/session/passkey', authed, async (req, reply) => {
    await limited(req, () => account.secondFactor(req.session!, req.body, relyingParty(req), req.ip));
    if (remember(req.body)) await rememberDevice(req, reply);
    return current(req);
  });
  // Passwordless: a passkey that verifies the person (PIN or biometrics) is both factors.
  app.post('/api/passkey/options', async (req) => {
    limiter.check(req.ip);
    return account.passwordlessOptions(relyingParty(req));
  });
  app.post('/api/passkey/sign-in', async (req, reply) => {
    limiter.check(req.ip);
    let user;
    try {
      user = await account.passwordless(req.body, relyingParty(req));
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) limiter.fail(req.ip);
      throw error;
    }
    const previous = await identity.resolve(req.cookies[cookieName]);
    if (previous) await identity.signOut(previous, req.ip);
    const { token } = await identity.createSession(user, meta(req), true, 'Passkey');
    setSession(reply, token);
    return view((await identity.resolve(token))!);
  });
  app.post('/api/session/reauth', authed, async (req) => {
    const { password } = reauthSchema.parse(req.body ?? {});
    await limited(req, async () => {
      try {
        await identity.reauthenticate(req.session!, password, req.ip);
      } catch (error) {
        if (error instanceof HttpError && error.code === 'reauth_invalid') limiter.fail(req.ip);
        throw error;
      }
    });
    return { ok: true };
  });

  // ---- password reset by email ----
  app.post('/api/password-reset', async (req) => {
    limiter.check(req.ip);
    limiter.fail(req.ip); // Every request counts, so the endpoint can't be used to flood a mailbox.
    await account.requestReset(req.body ?? {}, meta(req)).catch((error) => {
      // The response never says whether the account exists or whether sending worked.
      if (error instanceof ZodError) throw error;
      req.log.warn({ err: error }, 'Password reset email failed');
    });
    return { ok: true };
  });
  app.post('/api/password-reset/complete', async (req) => {
    limiter.check(req.ip);
    try {
      await account.completeReset(req.body ?? {}, req.ip);
    } catch (error) {
      if (error instanceof HttpError && error.code === 'reset_invalid') limiter.fail(req.ip);
      throw error;
    }
    return { ok: true };
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
    const { recoveryCodes } = await identity.confirmMfa(req.session!, code, req.ip);
    return { ...(await current(req)), recoveryCodes };
  });
  app.get('/api/account/security', authed, async (req) => account.overview(req.session!));
  app.patch('/api/account/preferences', authed, async (req) => {
    await account.setPreferences(req.session!, req.body);
    return account.overview(req.session!);
  });
  app.post('/api/account/recovery-codes', authed, async (req) => account.regenerateRecoveryCodes(req.session!, req.ip));
  app.post('/api/account/passkeys/options', authed, async (req) =>
    account.registrationOptions(req.session!, relyingParty(req)),
  );
  app.post('/api/account/passkeys', authed, async (req) => {
    const { recoveryCodes } = await account.register(req.session!, req.body, relyingParty(req), req.ip);
    return { ...(await current(req)), recoveryCodes };
  });
  app.delete<{ Params: { id: string } }>('/api/account/passkeys/:id', authed, async (req) => {
    await account.removePasskey(req.session!, req.params.id, req.ip);
    return current(req);
  });
  app.delete<{ Params: { id: string } }>('/api/account/sessions/:id', authed, async (req) => {
    await account.endSession(req.session!, req.params.id, req.ip);
    return { ok: true };
  });
  app.post('/api/account/sessions/end-others', authed, async (req) => account.endOtherSessions(req.session!, req.ip));
  app.delete<{ Params: { id: string } }>('/api/account/devices/:id', authed, async (req) => {
    await account.forgetDevice(req.session!, req.params.id, req.ip);
    return { ok: true };
  });

  // ---- administration ----
  // Changing who can do what needs a recent password confirmation.
  const recent = (req: FastifyRequest) => identity.requireRecentAuth(req.session!);
  app.get('/api/users', authed, async (req) => identity.listUsers(actorOf(req)));
  app.post('/api/users', authed, async (req, reply) => {
    recent(req);
    return reply.status(201).send(await identity.createUser(actorOf(req), req.body, req.ip));
  });
  app.patch<{ Params: { id: string } }>('/api/users/:id', authed, async (req) => {
    recent(req);
    return identity.updateUser(actorOf(req), req.params.id, req.body, req.ip);
  });
  app.post<{ Params: { id: string } }>('/api/users/:id/reset', authed, async (req) => {
    recent(req);
    return identity.resetUser(actorOf(req), req.params.id, req.body, req.ip);
  });
  app.post<{ Params: { id: string } }>('/api/users/:id/sign-out', authed, async (req) => {
    requireAdmin(actorOf(req));
    recent(req);
    await account.signOutUser(actorOf(req), req.params.id, req.ip);
    return { ok: true };
  });
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

  const files = storage ?? new LocalStorage(join(resolve(config.ATLAS_DATA_DIR), 'attachments'));
  registerDocumentationRoutes(app, {
    db,
    authed,
    storage: files,
    maxUploadBytes,
    domains: domainLookup ?? (config.NODE_ENV === 'test' ? undefined : new DomainLookup()),
  });

  const vault = registerVaultRoutes(app, {
    db,
    authed,
    keys: new VaultKeys(db, keys),
    shareLimiter: failureLimiter(30, 15 * 60_000),
  });

  const notifier = registerAdminRoutes(app, {
    db,
    authed,
    recent,
    settings,
    mail,
    audit,
    vault,
    publicOrigin: config.publicOrigin,
    sendHour: config.ATLAS_DIGEST_HOUR,
  });
  const backups = new BackupService(database, keys, files, {
    dir: config.ATLAS_BACKUP_DIR ?? join(resolve(config.ATLAS_DATA_DIR), 'backups'),
    keep: config.ATLAS_BACKUP_KEEP,
    hour: config.ATLAS_BACKUP_HOUR,
    enabled: config.ATLAS_BACKUP_ENABLED,
    appVersion: APP_VERSION,
  });
  registerOpsRoutes(app, {
    db,
    authed,
    recent,
    backups,
    status: new StatusService(database, { config, keys, backups, settings, notifier, version: APP_VERSION }),
  });
  registerUpdateRoutes(app, {
    db,
    authed,
    recent,
    updates: new UpdateService({
      repo: config.ATLAS_UPDATE_REPO,
      current: APP_VERSION,
      dir: config.ATLAS_UPDATER_DIR,
      fetch: updateFetch,
    }),
  });
  if (config.NODE_ENV !== 'test') {
    notifier.start();
    backups.start();
    const cwRmm = new CwRmmScheduler(db, settings, (err) => app.log.error({ err }, 'ConnectWise RMM sync'), cwRmmFetch);
    cwRmm.start();
    app.addHook('onClose', async () => {
      notifier.stop();
      backups.stop();
      cwRmm.stop();
    });
  }

  // ---- API keys, branding, imports, exports ----
  app.get('/api/openapi.json', async () => openApiSpec(config.publicOrigin));
  app.get('/api/api-keys', authed, async (req) => apiKeys.list(actorOf(req)));
  app.post('/api/api-keys', authed, async (req, reply) => {
    recent(req);
    return reply.status(201).send(await apiKeys.create(actorOf(req), req.body, req.ip));
  });
  app.delete<{ Params: { id: string } }>('/api/api-keys/:id', authed, async (req) => {
    await apiKeys.revoke(actorOf(req), req.params.id, req.ip);
    return { ok: true };
  });
  // Public: the sign-in pages are themed too (logo, colours, headline, background).
  app.get('/api/branding', async () => {
    const [org] = await db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs).limit(1);
    return org ? { name: org.name, ...(await settings.branding(org.id)) } : { name: 'MSP Atlas', ...DEFAULT_BRANDING };
  });
  // The theme carries its images inline (logos, favicon, sign-in background), so it may be larger than 1 MB.
  app.put('/api/branding', { ...authed, bodyLimit: 3 * 1024 * 1024 }, async (req) => {
    requireAdmin(actorOf(req));
    const saved = await settings.saveBranding(actorOf(req).orgId, req.body);
    await db.insert(schema.securityEvents).values({
      orgId: actorOf(req).orgId,
      userId: actorOf(req).id,
      actor: actorOf(req).name,
      action: 'Theme changed',
      detail: [saved.brandName || 'Default name', saved.accent ?? 'default colour', `${saved.density} layout`].join(
        ', ',
      ),
      ip: req.ip,
    });
    return saved;
  });
  registerDataRoutes(app, { db, authed, recent, settings, keys, vault, storage: files, huduFetch });
  registerIntegrationRoutes(app, { db, authed, recent, settings, cwRmmFetch });

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
