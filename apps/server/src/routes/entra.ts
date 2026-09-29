import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, type Role } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';
import { EntraService } from '../services/entra.js';
import { isUuid } from '../services/scope.js';
import type { SettingsService } from '../services/settings.js';

const STATE_COOKIE = 'atlas_sso';

/** Where a failed sign-in sends the person back to; the sign-in page turns the code into a message. */
type Outcome = 'off' | 'expired' | 'denied' | 'failed' | 'pending' | 'unknown' | 'disabled' | 'staff' | 'conflict';

/**
 * Staff sign in with Microsoft Entra ID. Accounts are never created here: an Entra account must match an Atlas
 * user, by object ID once linked. The first match is by email and waits for an administrator to confirm it, so
 * owning a look-alike email address in the directory isn't enough.
 */
export function registerEntraRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    identity: IdentityService;
    settings: SettingsService;
    entra: EntraService;
    publicOrigin: string;
    secureCookies: boolean;
    sessionToken: (reply: FastifyReply, token: string) => void;
    currentSession: (req: FastifyRequest) => Promise<Parameters<IdentityService['signOut']>[0] | null>;
    fetcher?: typeof fetch;
  },
) {
  const { db, authed, settings, entra, identity } = deps;
  const redirectUri = `${deps.publicOrigin}/api/auth/entra/callback`;
  const cookieOptions = {
    httpOnly: true,
    // Lax, not Strict: the return trip from Microsoft is a cross-site navigation, and the state must arrive with it.
    sameSite: 'lax' as const,
    path: '/api/auth/entra',
    secure: deps.secureCookies,
  };
  const actorOf = (req: FastifyRequest) => req.session!.actor;
  const event = (req: FastifyRequest, action: string, detail = '') =>
    db.insert(schema.securityEvents).values({
      orgId: actorOf(req).orgId,
      userId: actorOf(req).id,
      actor: actorOf(req).name,
      action,
      detail: detail.slice(0, 300),
      ip: req.ip,
    });
  const back = (reply: FastifyReply, outcome?: Outcome) => {
    reply.clearCookie(STATE_COOKIE, cookieOptions);
    return reply.redirect(outcome ? `/?sso=${outcome}` : '/', 302);
  };

  // ---- sign-in ----
  // Tells the sign-in page whether to offer the Microsoft button.
  app.get('/api/auth/entra', async () => {
    const found = await settings.entraOrg();
    return { enabled: !!found, requireSso: !!found?.settings.requireSso };
  });

  app.get('/api/auth/entra/start', async (req, reply) => {
    const found = await settings.entraOrg();
    if (!found) return back(reply, 'off');
    const full = (await settings.entra(found.orgId))!;
    const { url, cookie } = entra.begin(full, redirectUri);
    reply.setCookie(STATE_COOKIE, cookie, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(url, 302);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/entra/callback',
    async (req, reply) => {
      const found = await settings.entraOrg();
      if (!found) return back(reply, 'off');
      const full = (await settings.entra(found.orgId))!;
      const meta = { ip: req.ip, userAgent: req.headers['user-agent'] ?? '' };
      let who;
      try {
        who = await entra.complete(full, redirectUri, req.query, req.cookies[STATE_COOKIE]);
      } catch (error) {
        const code = error instanceof HttpError ? error.code : undefined;
        await identity.event(null, 'Microsoft sign-in failed', code ?? 'unknown', req.ip);
        return back(reply, code === 'sso_expired' ? 'expired' : code === 'sso_denied' ? 'denied' : 'failed');
      }

      const orgUsers = eq(schema.users.orgId, found.orgId);
      let [user] = await db
        .select()
        .from(schema.users)
        .where(and(orgUsers, eq(schema.users.entraOid, who.oid)));
      if (!user) {
        const [byEmail] = who.email
          ? await db
              .select()
              .from(schema.users)
              .where(and(orgUsers, eq(schema.users.email, who.email)))
          : [];
        if (!byEmail) {
          await identity.event(
            null,
            'Microsoft sign-in refused',
            `No Atlas account for ${who.email || who.oid}`,
            req.ip,
          );
          return back(reply, 'unknown');
        }
        if (byEmail.entraOid) {
          await identity.event(
            byEmail,
            'Microsoft sign-in refused',
            'The Atlas account is linked to another Microsoft account',
            req.ip,
          );
          return back(reply, 'conflict');
        }
        // A match by email only: an administrator has to confirm before it can sign in.
        await db
          .update(schema.users)
          .set({
            entraPendingOid: who.oid,
            entraPendingEmail: who.email.slice(0, 254),
            entraPendingName: who.name.slice(0, 200),
          })
          .where(eq(schema.users.id, byEmail.id));
        await identity.event(
          byEmail,
          'Microsoft sign-in awaiting confirmation',
          `Matched by email ${who.email}; Microsoft account ${who.oid}`,
          req.ip,
        );
        return back(reply, 'pending');
      }
      if (user.disabled) {
        await identity.event(user, 'Sign-in blocked', 'Account is disabled', req.ip);
        return back(reply, 'disabled');
      }
      if (!ROLE_INFO[user.role as Role].staff) {
        await identity.event(user, 'Microsoft sign-in refused', 'Not a staff account', req.ip);
        return back(reply, 'staff');
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await identity.event(user, 'Sign-in blocked', 'Account is temporarily locked', req.ip);
        return back(reply, 'denied');
      }
      // People who sign in with Microsoft don't use the temporary password they were created with.
      if (full.requireSso && user.mustChangePassword) {
        await db.update(schema.users).set({ mustChangePassword: false }).where(eq(schema.users.id, user.id));
        user = { ...user, mustChangePassword: false };
      }
      const previous = await deps.currentSession(req);
      if (previous) await identity.signOut(previous, req.ip);
      const mfa = full.trustMfa && who.mfa;
      const { token } = await identity.createSession(
        user,
        meta,
        mfa,
        mfa ? 'Microsoft Entra ID (Microsoft MFA)' : 'Microsoft Entra ID',
      );
      deps.sessionToken(reply, token);
      return back(reply);
    },
  );

  // ---- settings (administrators) ----
  app.get('/api/settings/entra', authed, async (req) => {
    requireAdmin(actorOf(req));
    return (await settings.entraView(actorOf(req).orgId, deps.publicOrigin)) ?? { redirectUri };
  });

  app.put('/api/settings/entra', authed, async (req) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    deps.recent(req);
    await settings.saveEntra(actor.orgId, req.body);
    const view = await settings.entraView(actor.orgId, deps.publicOrigin);
    await event(
      req,
      'Microsoft Entra sign-in settings changed',
      `${view?.enabled ? 'On' : 'Off'} for tenant ${view?.tenantId}`,
    );
    return view;
  });

  app.delete('/api/settings/entra', authed, async (req) => {
    requireAdmin(actorOf(req));
    deps.recent(req);
    await settings.forgetEntra(actorOf(req).orgId);
    await event(req, 'Microsoft Entra sign-in removed');
    return { ok: true };
  });

  // Checks the tenant exists, before anyone is sent there to sign in.
  app.post('/api/settings/entra/test', authed, async (req) => {
    requireAdmin(actorOf(req));
    const saved = await settings.entra(actorOf(req).orgId);
    if (!saved) throw new HttpError(400, 'Save the Microsoft Entra settings first.');
    let res: Response;
    try {
      res = await (deps.fetcher ?? fetch)(
        `https://login.microsoftonline.com/${encodeURIComponent(saved.tenantId)}/v2.0/.well-known/openid-configuration`,
        { signal: AbortSignal.timeout(15_000) },
      );
    } catch {
      throw new HttpError(502, 'Microsoft could not be reached from this server.');
    }
    if (!res.ok)
      throw new HttpError(
        400,
        'Microsoft does not know that Directory (tenant) ID. Check it on the app’s Overview page.',
      );
    return { ok: true };
  });

  // ---- linking people (administrators) ----
  const targetUser = async (req: FastifyRequest) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const { id } = req.params as { id: string };
    const [user] = isUuid(id)
      ? await db
          .select()
          .from(schema.users)
          .where(and(eq(schema.users.id, id), eq(schema.users.orgId, actor.orgId)))
      : [];
    if (!user) throw new HttpError(404, 'That person was not found.');
    return user;
  };

  app.post('/api/users/:id/entra/confirm', authed, async (req) => {
    const user = await targetUser(req);
    deps.recent(req);
    if (!user.entraPendingOid) throw new HttpError(409, 'There is no Microsoft account waiting to be confirmed.');
    // Confirming approves the account the administrator looked at. If another sign-in has replaced it since,
    // they have to look again.
    const { oid } = z.object({ oid: z.string().min(1).max(100) }).parse(req.body ?? {});
    if (oid !== user.entraPendingOid)
      throw new HttpError(409, 'A different Microsoft account is waiting now. Review it, then confirm again.');
    try {
      await db
        .update(schema.users)
        .set({ entraOid: user.entraPendingOid, entraPendingOid: null, entraPendingEmail: null, entraPendingName: null })
        .where(eq(schema.users.id, user.id));
    } catch {
      throw new HttpError(409, 'That Microsoft account is already linked to another person.');
    }
    await event(
      req,
      'Microsoft account linked',
      `${user.email}: ${user.entraPendingName ?? ''} <${user.entraPendingEmail ?? ''}> (${user.entraPendingOid})`,
    );
    return { ok: true };
  });

  app.delete('/api/users/:id/entra', authed, async (req) => {
    const user = await targetUser(req);
    deps.recent(req);
    await db
      .update(schema.users)
      .set({ entraOid: null, entraPendingOid: null, entraPendingEmail: null, entraPendingName: null })
      .where(eq(schema.users.id, user.id));
    // Sessions stay: unlinking removes Microsoft as a way in, it doesn't sign anyone out.
    await event(req, 'Microsoft account unlinked', user.email);
    return { ok: true };
  });
}
