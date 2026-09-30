import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  APP_SESSION_LIMITS,
  NATIVE_CLIENTS,
  ROLE_INFO,
  nativeDecisionSchema,
  nativeTokenSchema,
  type AppScope,
  type NativeClientId,
  type NativeTokenResponse,
  type Role,
} from '@atlas/shared';
import { HttpError, fail } from '../errors.js';
import { API_ROUTES } from '../services/api-keys.js';
import { actorFor, sameSecret, tokenHash, type IdentityService, type SessionContext } from './service.js';

const CODE_MS = 2 * 60_000;
const DAY = 86_400_000;
const IDLE_MS = APP_SESSION_LIMITS.idleDays * DAY;
const ABSOLUTE_MS = APP_SESSION_LIMITS.absoluteDays * DAY;
const TOKEN = /^Bearer (atlasd_[A-Za-z0-9_-]{43})$/;
// Reading and changing a password's secret: these need "reveal", never just "write".
const REVEAL_ROUTE = /^\/api\/passwords\/[^/]+\/(reveal|history\/[^/]+\/reveal)$/;
// The app's own session (who am I, sign out) is always available to it.
const OWN_SESSION = '/api/native/session';

/** True when an Authorization header carries a desktop app's token rather than an API key. */
export const isAppToken = (header: string | undefined) => /^Bearer atlasd_/.test(header ?? '');

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/**
 * Sign-in for native apps (Atlas for Windows): the authorization code flow with PKCE and a loopback redirect
 * (RFC 8252). The person signs in in their browser as usual (password and MFA, or a passkey) and approves the app;
 * the app exchanges the one-time code for an app session, which is a row in the sessions table. That is deliberate:
 * locking, resetting, disabling, or signing someone out everywhere deletes their sessions, and with them their apps.
 */
export class NativeAppService {
  private readonly hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly db: Database,
    private readonly identity: IdentityService,
    private readonly perMinute = 600,
  ) {}

  /** The browser half: the signed-in person approves (or refuses) the app. Returns where to send the browser. */
  async decide(context: SessionContext, input: unknown, ip: string): Promise<{ redirect: string }> {
    const body = nativeDecisionSchema.parse(input);
    const back = (params: Record<string, string>) =>
      `${body.redirect_uri}?${new URLSearchParams({ ...params, state: body.state })}`;
    if (!body.approve) return { redirect: back({ error: 'access_denied' }) };
    if (!ROLE_INFO[context.actor.role].staff)
      throw new HttpError(403, `${NATIVE_CLIENTS[body.client_id].name} is for staff accounts.`, 'native_staff');
    const code = randomBytes(32).toString('base64url');
    await this.db.insert(schema.nativeAuthCodes).values({
      codeHash: tokenHash(code),
      userId: context.user.id,
      client: body.client_id,
      redirectUri: body.redirect_uri,
      codeChallenge: body.code_challenge,
      scopes: body.scope,
      deviceName: body.device_name,
      expiresAt: new Date(Date.now() + CODE_MS),
    });
    await this.identity.event(
      context.user,
      'Desktop app approved',
      `${NATIVE_CLIENTS[body.client_id].name} on ${body.device_name} · ${body.scope.join(', ')}`,
      ip,
    );
    return { redirect: back({ code }) };
  }

  /** The app half: trades a one-time code and its PKCE verifier for an app session token. */
  async exchange(input: unknown, meta: { ip: string; userAgent?: string }): Promise<NativeTokenResponse> {
    const invalid = () =>
      new HttpError(400, 'This sign-in has expired or is not valid. Start again from the app.', 'invalid_grant');
    const parsed = nativeTokenSchema.safeParse(input ?? {});
    if (!parsed.success) throw invalid();
    const body = parsed.data;
    // Deleting the code as it is read means it works at most once, even for two requests at the same moment,
    // and a wrong verifier burns it.
    const [code] = await this.db
      .delete(schema.nativeAuthCodes)
      .where(eq(schema.nativeAuthCodes.codeHash, tokenHash(body.code)))
      .returning();
    if (
      !code ||
      code.expiresAt.getTime() < Date.now() ||
      code.client !== body.client_id ||
      code.redirectUri !== body.redirect_uri ||
      !sameSecret(s256(body.code_verifier), code.codeChallenge)
    )
      throw invalid();
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, code.userId));
    if (!user || user.disabled || (user.lockedUntil && user.lockedUntil.getTime() > Date.now())) throw invalid();

    const token = `atlasd_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const clientName = NATIVE_CLIENTS[code.client as NativeClientId].name;
    const id = await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.sessions)
        .where(
          and(
            eq(schema.sessions.kind, 'app'),
            or(
              lt(schema.sessions.lastSeenAt, new Date(now - IDLE_MS)),
              lt(schema.sessions.createdAt, new Date(now - ABSOLUTE_MS)),
            ),
          ),
        );
      const existing = await tx
        .select({ tokenHash: schema.sessions.tokenHash })
        .from(schema.sessions)
        .where(and(eq(schema.sessions.userId, user.id), eq(schema.sessions.kind, 'app')))
        .orderBy(desc(schema.sessions.lastSeenAt))
        .offset(APP_SESSION_LIMITS.perUser - 1);
      for (const row of existing) await tx.delete(schema.sessions).where(eq(schema.sessions.tokenHash, row.tokenHash));
      const [row] = await tx
        .insert(schema.sessions)
        .values({
          tokenHash: tokenHash(token),
          userId: user.id,
          kind: 'app',
          client: code.client,
          deviceName: code.deviceName,
          scopes: code.scopes,
          // Unused by bearer tokens, but the column is required; a random value can't be matched by anyone.
          csrf: randomBytes(32).toString('base64url'),
          // The person completed their second step in the browser to approve the app.
          mfaVerified: true,
          ip: meta.ip.slice(0, 64),
          userAgent: (meta.userAgent ?? '').slice(0, 200),
        })
        .returning({ id: schema.sessions.id });
      await tx.insert(schema.securityEvents).values({
        orgId: user.orgId,
        userId: user.id,
        actor: user.name,
        action: 'Desktop app signed in',
        detail: `${clientName} on ${code.deviceName} · ${code.scopes.join(', ')}`,
        ip: meta.ip.slice(0, 64),
      });
      return row!.id;
    });
    return {
      access_token: token,
      token_type: 'Bearer',
      scope: code.scopes.join(' '),
      expires_in: IDLE_MS / 1000,
      session_id: id,
      user: { name: user.name, email: user.email },
    };
  }

  /** Resolves an app's bearer token and checks it may call this method and path. */
  async authenticate(header: string | undefined, method: string, url: string, ip: string): Promise<SessionContext> {
    const token = TOKEN.exec(header ?? '')?.[1];
    const signIn = () => new HttpError(401, 'Sign in to Atlas again from the app.', 'session');
    if (!token) throw signIn();
    const hash = tokenHash(token);
    const [row] = await this.db
      .select({ session: schema.sessions, user: schema.users, org: schema.orgs })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.users.orgId))
      .where(and(eq(schema.sessions.tokenHash, hash), eq(schema.sessions.kind, 'app')));
    if (!row) throw signIn();
    const { session, user, org } = row;
    const now = Date.now();
    if (
      user.disabled ||
      !ROLE_INFO[user.role as Role].staff ||
      session.lastSeenAt.getTime() < now - IDLE_MS ||
      session.createdAt.getTime() < now - ABSOLUTE_MS
    ) {
      await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hash));
      throw signIn();
    }
    // A temporary password set by an administrator has to be replaced in the browser first.
    if (this.identity.stageFor(user, session) !== 'active')
      throw new HttpError(403, 'Finish signing in to Atlas in your browser, then try again.', 'stage');

    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    const bucket = this.hits.get(session.id);
    if (!bucket || bucket.reset < now) this.hits.set(session.id, { count: 1, reset: now + 60_000 });
    else if (++bucket.count > this.perMinute)
      throw new HttpError(429, `Rate limit reached (${this.perMinute} requests a minute). Slow down and retry.`);

    const path = url.split('?')[0]!;
    if (path !== OWN_SESSION) {
      if (!API_ROUTES.some((r) => r.test(path)))
        throw new HttpError(403, 'This endpoint is not available to desktop apps.', 'api_scope');
      const scopes = session.scopes as AppScope[];
      const needed: AppScope = REVEAL_ROUTE.test(path)
        ? 'reveal'
        : method === 'GET' || method === 'HEAD'
          ? 'read'
          : 'write';
      if (!scopes.includes(needed))
        throw new HttpError(403, `The app was not given permission to do this ("${needed}").`, 'api_scope');
    }

    if (now - session.lastSeenAt.getTime() > 60_000)
      await this.db
        .update(schema.sessions)
        .set({ lastSeenAt: new Date(now), ip: ip.slice(0, 64) })
        .where(eq(schema.sessions.tokenHash, hash));
    const actor = actorFor(user);
    const clientName = NATIVE_CLIENTS[session.client as NativeClientId]?.name ?? 'Desktop app';
    return {
      hash,
      session,
      user,
      // Audit and activity entries name the app and computer as well as the person.
      actor: { ...actor, name: `${actor.name} (${clientName} on ${session.deviceName})`.slice(0, 120) },
      stage: 'active',
      organization: { id: org.id, name: org.name },
    };
  }

  /** What the app shows about its own sign-in. */
  describe(context: SessionContext) {
    return {
      user: { name: context.user.name, email: context.user.email, role: context.user.role },
      organization: context.organization,
      deviceName: context.session.deviceName,
      scopes: context.session.scopes as AppScope[],
      createdAt: context.session.createdAt.toISOString(),
    };
  }

  /** The app signs itself out. */
  async signOut(context: SessionContext, ip: string) {
    const removed = await this.db
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.tokenHash, context.hash), eq(schema.sessions.kind, 'app')))
      .returning({ id: schema.sessions.id });
    if (!removed.length) fail(401, 'Sign in to Atlas again from the app.', 'session');
    const clientName = NATIVE_CLIENTS[context.session.client as NativeClientId]?.name ?? 'Desktop app';
    await this.identity.event(
      context.user,
      'Desktop app signed out',
      `${clientName} on ${context.session.deviceName}`,
      ip,
    );
  }
}
