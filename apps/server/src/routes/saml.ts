import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, type Role } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';
import type { SamlService } from '../services/saml.js';
import { isUuid } from '../services/scope.js';
import type { SettingsService } from '../services/settings.js';

const REQUEST_COOKIE = 'atlas_saml';

/** Where a failed sign-in sends the person back to; the sign-in page turns the code into a message. */
type Outcome = 'off' | 'expired' | 'failed' | 'pending' | 'unknown' | 'disabled' | 'staff' | 'conflict' | 'denied';

/**
 * Staff sign in through a SAML 2.0 identity provider (Okta, Google Workspace, Duo, JumpCloud, and the like). As
 * with Microsoft sign-in, accounts are never created here: the identity provider's account must match an Atlas
 * user, by its name ID once linked. The first match is by email and waits for an administrator to confirm it.
 */
export async function registerSamlRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    identity: IdentityService;
    settings: SettingsService;
    saml: SamlService;
    publicOrigin: string;
    secureCookies: boolean;
    sessionToken: (reply: FastifyReply, token: string) => void;
    currentSession: (req: FastifyRequest) => Promise<Parameters<IdentityService['signOut']>[0] | null>;
  },
) {
  const { db, authed, settings, saml, identity } = deps;
  const sp = saml.serviceProvider(deps.publicOrigin);
  const cookieOptions = {
    httpOnly: true,
    // The identity provider posts its response from its own site, and a cookie only goes with a cross-site post
    // when it is SameSite=None (which browsers accept only over HTTPS). It holds nothing but which request was made.
    sameSite: deps.secureCookies ? ('none' as const) : ('lax' as const),
    path: '/api/auth/saml',
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
    reply.clearCookie(REQUEST_COOKIE, cookieOptions);
    // 303: the browser arrived by POST and must fetch the page with GET.
    return reply.redirect(outcome ? `/?sso=${outcome}` : '/', 303);
  };

  // ---- sign-in ----
  // Tells the sign-in page whether to offer the button, and what to call it.
  app.get('/api/auth/saml', async () => {
    const found = await settings.samlOrg();
    return { enabled: !!found, name: found?.settings.name ?? '', requireSso: !!found?.settings.requireSso };
  });

  app.get('/api/auth/saml/metadata', async (_req, reply) =>
    reply.header('Content-Type', 'application/samlmetadata+xml; charset=utf-8').send(saml.metadata(sp)),
  );

  app.get('/api/auth/saml/start', async (_req, reply) => {
    const found = await settings.samlOrg();
    if (!found) return reply.clearCookie(REQUEST_COOKIE, cookieOptions).redirect('/?sso=off', 302);
    const { url, cookie } = await saml.begin(found.settings, sp);
    reply.setCookie(REQUEST_COOKIE, cookie, { ...cookieOptions, maxAge: 600 });
    return reply.redirect(url, 302);
  });

  // The identity provider's response arrives as a form post. Only this route reads form bodies.
  await app.register(async (form) => {
    form.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    form.post('/api/auth/saml/acs', { bodyLimit: 512 * 1024 }, async (req, reply) => {
      const found = await settings.samlOrg();
      if (!found) return back(reply, 'off');
      const full = found.settings;
      const meta = { ip: req.ip, userAgent: req.headers['user-agent'] ?? '' };
      let who;
      try {
        who = await saml.complete(
          full,
          sp,
          (req.body as Record<string, string> | undefined)?.SAMLResponse,
          req.cookies[REQUEST_COOKIE],
        );
      } catch (error) {
        const code = error instanceof HttpError ? error.code : undefined;
        await identity.event(null, 'Single sign-on failed', code ?? 'unknown', req.ip);
        return back(reply, code === 'sso_expired' ? 'expired' : 'failed');
      }

      const orgUsers = eq(schema.users.orgId, found.orgId);
      let [user] = await db
        .select()
        .from(schema.users)
        .where(and(orgUsers, eq(schema.users.samlSubject, who.subject)));
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
            'Single sign-on refused',
            `No Atlas account for ${who.email || who.subject}`,
            req.ip,
          );
          return back(reply, 'unknown');
        }
        if (byEmail.samlSubject) {
          await identity.event(
            byEmail,
            'Single sign-on refused',
            'The Atlas account is linked to another identity provider account',
            req.ip,
          );
          return back(reply, 'conflict');
        }
        // A match by email only: an administrator has to confirm before it can sign in.
        await db
          .update(schema.users)
          .set({ samlPendingSubject: who.subject, samlPendingEmail: who.email, samlPendingName: who.name })
          .where(eq(schema.users.id, byEmail.id));
        await identity.event(
          byEmail,
          'Single sign-on awaiting confirmation',
          `Matched by email ${who.email}; ${full.name} account ${who.subject}`,
          req.ip,
        );
        return back(reply, 'pending');
      }
      if (user.disabled) {
        await identity.event(user, 'Sign-in blocked', 'Account is disabled', req.ip);
        return back(reply, 'disabled');
      }
      if (!ROLE_INFO[user.role as Role].staff) {
        await identity.event(user, 'Single sign-on refused', 'Not a staff account', req.ip);
        return back(reply, 'staff');
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await identity.event(user, 'Sign-in blocked', 'Account is temporarily locked', req.ip);
        return back(reply, 'denied');
      }
      // People who use single sign-on don't use the temporary password they were created with.
      if (full.requireSso && user.mustChangePassword) {
        await db.update(schema.users).set({ mustChangePassword: false }).where(eq(schema.users.id, user.id));
        user = { ...user, mustChangePassword: false };
      }
      const previous = await deps.currentSession(req);
      if (previous) await identity.signOut(previous, req.ip);
      const { token } = await identity.createSession(
        user,
        meta,
        full.trustMfa,
        full.trustMfa ? `${full.name} (SAML, provider's MFA)` : `${full.name} (SAML)`,
      );
      deps.sessionToken(reply, token);
      return back(reply);
    });
  });

  // ---- settings (administrators) ----
  app.get('/api/settings/saml', authed, async (req) => {
    requireAdmin(actorOf(req));
    const saved = await settings.saml(actorOf(req).orgId);
    return { serviceProvider: sp, settings: saved ? saml.view(saved) : null };
  });

  app.put('/api/settings/saml', authed, async (req) => {
    const actor = actorOf(req);
    requireAdmin(actor);
    deps.recent(req);
    const before = await settings.saml(actor.orgId);
    const next = saml.settingsFrom(req.body, before);
    // Name IDs mean something only to the provider that issued them. With a different provider, an old link could
    // point at somebody else's account there, so every link is dropped and confirmed again.
    const reset = !!before && before.idpIssuer !== next.idpIssuer;
    if (reset)
      await db
        .update(schema.users)
        .set({ samlSubject: null, samlPendingSubject: null, samlPendingEmail: null, samlPendingName: null })
        .where(eq(schema.users.orgId, actor.orgId));
    await settings.saveSaml(actor.orgId, next);
    await event(
      req,
      'SAML sign-in settings changed',
      `${next.enabled ? 'On' : 'Off'} for ${next.name} (${next.idpIssuer})${reset ? '; account links cleared' : ''}`,
    );
    return { serviceProvider: sp, settings: saml.view(next), linksCleared: reset };
  });

  app.delete('/api/settings/saml', authed, async (req) => {
    requireAdmin(actorOf(req));
    deps.recent(req);
    await settings.forgetSaml(actorOf(req).orgId);
    await event(req, 'SAML sign-in removed');
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

  app.post('/api/users/:id/saml/confirm', authed, async (req) => {
    const user = await targetUser(req);
    deps.recent(req);
    if (!user.samlPendingSubject) throw new HttpError(409, 'There is no account waiting to be confirmed.');
    // Confirming approves the account the administrator looked at. If another sign-in has replaced it since,
    // they have to look again.
    const { subject } = z.object({ subject: z.string().min(1).max(500) }).parse(req.body ?? {});
    if (subject !== user.samlPendingSubject)
      throw new HttpError(409, 'A different account is waiting now. Review it, then confirm again.');
    try {
      await db
        .update(schema.users)
        .set({
          samlSubject: user.samlPendingSubject,
          samlPendingSubject: null,
          samlPendingEmail: null,
          samlPendingName: null,
        })
        .where(eq(schema.users.id, user.id));
    } catch {
      throw new HttpError(409, 'That account is already linked to another person.');
    }
    await event(
      req,
      'Single sign-on account linked',
      `${user.email}: ${user.samlPendingName ?? ''} <${user.samlPendingEmail ?? ''}> (${user.samlPendingSubject})`,
    );
    return { ok: true };
  });

  app.delete('/api/users/:id/saml', authed, async (req) => {
    const user = await targetUser(req);
    deps.recent(req);
    await db
      .update(schema.users)
      .set({ samlSubject: null, samlPendingSubject: null, samlPendingEmail: null, samlPendingName: null })
      .where(eq(schema.users.id, user.id));
    // Sessions stay: unlinking removes single sign-on as a way in, it doesn't sign anyone out.
    await event(req, 'Single sign-on account unlinked', user.email);
    return { ok: true };
  });
}
