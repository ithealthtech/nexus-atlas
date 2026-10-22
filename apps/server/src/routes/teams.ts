import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { teamsPageSchema, teamsSettingsSchema } from '@atlas/shared';
import type { KeyProvider } from '../crypto/keys.js';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';
import { EntraService } from '../services/entra.js';
import { Scope } from '../services/scope.js';
import { securityEvent } from '../services/security-log.js';
import { TeamsSettingsStore, type StoredTeams } from '../services/teams/settings.js';
import { TeamsGraph } from '../services/teams/graph.js';
import type { TeamsAlerts } from '../services/teams/alerts.js';
import { teamsAppPackage } from '../services/teams/manifest.js';

const BASE = '/api/integrations/teams';
const SCOPES =
  'openid profile email offline_access https://graph.microsoft.com/ChannelMessage.Read.All https://graph.microsoft.com/ChannelMessage.Send https://graph.microsoft.com/ChannelMessage.ReadWrite';
export function teamsOidc(saved: StoredTeams) {
  if (!saved.appId || !saved.tenantId) throw new HttpError(409, 'Save the Teams application settings first.');
  return {
    enabled: true,
    tenantId: saved.tenantId,
    clientId: saved.appId,
    secretSealed: saved.secretSealed ?? '',
    trustMfa: false,
    requireSso: false,
  };
}
type Params = { clientId: string; messageId: string; replyId: string };
export function registerTeamsRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    keys: KeyProvider;
    settings: TeamsSettingsStore;
    graph: TeamsGraph;
    alerts: TeamsAlerts;
    identity: IdentityService;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    publicOrigin: string;
    cookieName: string;
    secureCookies: boolean;
    fetcher?: typeof fetch;
  },
) {
  const { authed, settings, graph, alerts, db } = deps;
  const admin = (req: FastifyRequest) => {
    requireAdmin(req.session!.actor);
    return req.session!.actor;
  };
  const scope = (req: FastifyRequest) => new Scope(db, req.session!.actor);
  const event = (req: FastifyRequest, action: string) =>
    securityEvent(db, {
      orgId: req.session!.actor.orgId,
      userId: req.session!.actor.id,
      actor: req.session!.actor.name,
      action,
      ip: req.ip,
    });
  app.get(BASE, authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return settings.view(admin(req).orgId);
  });
  app.get(BASE + '/app-package', authed, async (req, reply) => {
    const config = await settings.view(admin(req).orgId);
    return reply
      .header('cache-control', 'no-store')
      .header('content-disposition', 'attachment; filename="atlas-teams.zip"')
      .type('application/zip')
      .send(teamsAppPackage(config, deps.publicOrigin));
  });
  app.put(BASE, authed, async (req) => {
    const actor = admin(req);
    deps.recent(req);
    const body = teamsSettingsSchema.parse(req.body);
    for (const m of body.mappings) {
      const [client] = await db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(and(eq(schema.clients.id, m.clientId), eq(schema.clients.orgId, actor.orgId)));
      if (!client) throw new HttpError(404, 'Client not found.');
    }
    const result = await settings.save(actor.orgId, actor.id, body);
    await event(req, 'Teams integration settings changed');
    return result;
  });
  app.delete(BASE, authed, async (req) => {
    const actor = admin(req);
    deps.recent(req);
    await settings.disconnect(actor.orgId);
    await event(req, 'Teams integration disconnected');
    return { ok: true };
  });
  app.get(BASE + '/deliveries', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return alerts.history(admin(req).orgId);
  });
  app.post<{ Params: { id: string } }>(BASE + '/deliveries/:id/retry', authed, async (req) => {
    const actor = admin(req);
    deps.recent(req);
    const id = z.string().uuid().parse(req.params.id);
    const { confirmUncertain } = z.object({ confirmUncertain: z.boolean().default(false) }).parse(req.body ?? {});
    const result = await alerts.retry(actor.orgId, id, confirmUncertain);
    await event(req, 'Teams delivery retry requested');
    return result;
  });
  app.post(BASE + '/test/:clientId', authed, async (req) => {
    admin(req);
    deps.recent(req);
    const clientId = (req.params as Params).clientId;
    await graph.mapping(scope(req), clientId, true);
    const result = await alerts.test(req.session!.actor.orgId, clientId);
    await event(req, 'Teams test notification sent');
    return result;
  });
  app.get<{ Params: Params }>('/api/clients/:clientId/teams', authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const m = await graph.mapping(scope(req), req.params.clientId);
    return { name: m.channelName, canWrite: (await scope(req).level(req.params.clientId)) !== 'read' };
  });
  const posts = '/api/clients/:clientId/teams/posts';
  app.get<{ Params: Params; Querystring: { cursor?: string } }>(posts, authed, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return graph.list(scope(req), req.params.clientId, undefined, teamsPageSchema.parse(req.query).cursor);
  });
  app.post<{ Params: Params }>(posts, authed, async (req, reply) =>
    reply.status(201).send(await graph.create(scope(req), req.params.clientId, req.body, req.ip)),
  );
  app.patch<{ Params: Params }>(posts + '/:messageId', authed, async (req) =>
    graph.edit(scope(req), req.params.clientId, req.params.messageId, req.body, req.ip),
  );
  app.get<{ Params: Params; Querystring: { cursor?: string } }>(
    posts + '/:messageId/replies',
    authed,
    async (req, reply) => {
      reply.header('cache-control', 'no-store');
      return graph.list(scope(req), req.params.clientId, req.params.messageId, teamsPageSchema.parse(req.query).cursor);
    },
  );
  app.post<{ Params: Params }>(posts + '/:messageId/replies', authed, async (req, reply) =>
    reply.status(201).send(await graph.create(scope(req), req.params.clientId, req.body, req.ip, req.params.messageId)),
  );
  app.patch<{ Params: Params }>(posts + '/:messageId/replies/:replyId', authed, async (req) =>
    graph.edit(scope(req), req.params.clientId, req.params.replyId, req.body, req.ip, req.params.messageId),
  );
  app.post<{ Params: Params }>('/api/clients/:clientId/teams/infections', authed, async (req, reply) =>
    reply.status(202).send(await alerts.infection(scope(req), req.params.clientId, req.body, req.ip)),
  );

  const oidc = new EntraService(deps.keys, deps.fetcher);
  const redirect = deps.publicOrigin + BASE + '/callback';
  const cookieName = 'atlas_teams';
  const cookie = { httpOnly: true, secure: deps.secureCookies, sameSite: 'lax' as const, path: BASE };
  const pending = new Map<
    string,
    { orgId: string; session: string; saved: StoredTeams; cookie: string; expires: number }
  >();
  app.addHook('onClose', async () => {
    pending.clear();
  });
  app.post(BASE + '/connect', authed, async (req, reply) => {
    const actor = admin(req);
    deps.recent(req);
    const session = req.cookies[deps.cookieName];
    if (!session) throw new HttpError(403, 'Use an Atlas browser session.');
    const saved = await settings.load(actor.orgId);
    if (!saved) throw new HttpError(409, 'Save Teams settings first.');
    for (const [id, flow] of pending) if (flow.expires < Date.now()) pending.delete(id);
    if (pending.size >= 500) throw new HttpError(429, 'Too many connections in progress.');
    const flow = oidc.begin(teamsOidc(saved), redirect, SCOPES);
    const state = new URL(flow.url).searchParams.get('state')!;
    pending.set(state, { orgId: actor.orgId, session, saved, cookie: flow.cookie, expires: Date.now() + 600_000 });
    reply.setCookie(cookieName, state, { ...cookie, maxAge: 600 });
    return { url: flow.url };
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    BASE + '/callback',
    async (req, reply) => {
      reply.clearCookie(cookieName, cookie);
      const state = req.query.state;
      const flow = state && req.cookies[cookieName] === state ? pending.get(state) : undefined;
      if (state) pending.delete(state);
      const back = (status: string) => reply.redirect(`/admin/teams?connection=${status}`, 302);
      if (!flow || flow.expires < Date.now()) return back('expired');
      try {
        const before = await deps.identity.resolve(flow.session);
        if (!before || before.stage !== 'active' || before.actor.orgId !== flow.orgId) return back('expired');
        requireAdmin(before.actor);
        const result = await oidc.completeWithTokens(
          { ...teamsOidc(flow.saved), clientSecret: settings.secret(flow.orgId, flow.saved) },
          redirect,
          req.query,
          flow.cookie,
          SCOPES,
        );
        const after = await deps.identity.resolve(flow.session);
        if (!after || after.stage !== 'active' || after.actor.orgId !== flow.orgId || flow.expires < Date.now())
          return back('expired');
        requireAdmin(after.actor);
        if (!result.refreshToken) return back('failed');
        await settings.connect(
          flow.orgId,
          flow.saved.generation,
          { oid: result.identity.oid, name: result.identity.name, connectedAt: new Date().toISOString() },
          result.refreshToken,
        );
        await deps.identity.event(after.user, 'Teams Microsoft account connected', result.identity.tenant, req.ip);
        return back('connected');
      } catch {
        return back('failed');
      }
    },
  );
}
