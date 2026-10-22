import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { GdapCustomer } from '@atlas/shared';
import type { KeyProvider } from '../crypto/keys.js';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { IdentityService } from '../identity/service.js';
import { EntraService } from '../services/entra.js';
import { M365Client } from '../services/integrations/m365.js';
import type { SettingsService, StoredEntra, StoredM365 } from '../services/settings.js';

const BASE = '/api/integrations/m365/gdap';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES =
  'openid profile email offline_access https://graph.microsoft.com/Directory.Read.All https://graph.microsoft.com/DelegatedAdminRelationship.Read.All https://graph.microsoft.com/LicenseAssignment.ReadWrite.All https://graph.microsoft.com/Reports.Read.All';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Connection = StoredM365 & { clientSecret: string };
export function partnerSettings(saved: Connection): StoredEntra & { clientSecret: string } {
  if (saved.authMode !== 'gdap' || !saved.partnerTenantId || !GUID.test(saved.partnerTenantId))
    throw new HttpError(400, 'Save the GDAP partner tenant and app settings first.');
  return {
    tenantId: saved.partnerTenantId,
    clientId: saved.clientId,
    secretSealed: saved.secretSealed,
    clientSecret: saved.clientSecret,
    enabled: true,
    trustMfa: false,
    requireSso: false,
  };
}

/** Uses the existing validated OIDC flow to connect a partner account, independently of Atlas staff SSO. */
export class GdapService {
  readonly oidc: EntraService;
  constructor(keys: KeyProvider, fetcher?: typeof fetch) {
    this.oidc = new EntraService(keys, fetcher);
  }
  begin(saved: Connection, redirectUri: string) {
    return this.oidc.begin(partnerSettings(saved), redirectUri, SCOPES);
  }
  async complete(
    saved: Connection,
    redirectUri: string,
    query: { code?: string; state?: string; error?: string },
    cookie: string,
  ) {
    const result = await this.oidc.completeWithTokens(partnerSettings(saved), redirectUri, query, cookie, SCOPES);
    if (!result.refreshToken)
      throw new HttpError(400, 'Microsoft did not grant offline access. Sign in and consent again.');
    return { identity: result.identity, refreshToken: result.refreshToken };
  }
}

// Refreshes are serialized per organization across syncs, discovery and checks; rotated tokens cannot overwrite each other.
const refreshes = new Map<string, Promise<unknown>>();
async function accessToken(settings: SettingsService, orgId: string, tenant: string, fetcher: typeof fetch) {
  const previous = refreshes.get(orgId) ?? Promise.resolve();
  const job = previous
    .catch(() => undefined)
    .then(async () => {
      const saved = await settings.m365(orgId);
      if (!saved) throw new HttpError(400, 'Connect Microsoft 365 first.');
      partnerSettings(saved);
      const refresh = await settings.gdapRefresh(orgId);
      let res: Response;
      try {
        res = await fetcher(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: saved.clientId,
            client_secret: saved.clientSecret,
            refresh_token: refresh,
            scope: 'https://graph.microsoft.com/.default',
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new HttpError(502, 'Microsoft could not be reached from this server.');
      }
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
      if (!res.ok || typeof body.access_token !== 'string' || !body.access_token)
        throw new HttpError(
          400,
          'Microsoft refused delegated access. Reconnect the partner account, check MFA/Conditional Access, and verify customer consent and GDAP roles.',
        );
      if (typeof body.refresh_token === 'string' && body.refresh_token)
        await settings.saveGdap(orgId, saved, saved.gdap!, body.refresh_token);
      return body.access_token;
    });
  refreshes.set(orgId, job);
  try {
    return await job;
  } finally {
    if (refreshes.get(orgId) === job) refreshes.delete(orgId);
  }
}

/** Relationship discovery is read-only. A relationship alone never grants an Atlas role or client access. */
export async function gdapCustomers(
  settings: SettingsService,
  orgId: string,
  fetcher: typeof fetch = fetch,
): Promise<GdapCustomer[]> {
  const saved = await settings.m365(orgId);
  if (!saved) throw new HttpError(400, 'Connect Microsoft 365 first.');
  const partner = partnerSettings(saved).tenantId;
  const token = await accessToken(settings, orgId, partner, fetcher);
  let url: string | undefined =
    `${GRAPH}/tenantRelationships/delegatedAdminRelationships?$select=id,status,endDateTime,customer`;
  const customers: GdapCustomer[] = [];
  const visited = new Set<string>();
  while (url) {
    if (!url.startsWith(`${GRAPH}/`) || visited.has(url) || visited.size >= 100)
      throw new HttpError(502, 'Microsoft returned an invalid or oversized relationship list.');
    visited.add(url);
    let res: Response;
    try {
      res = await fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new HttpError(502, 'Microsoft Graph could not be reached from this server.');
    }
    if (!res.ok)
      throw new HttpError(
        400,
        'GDAP relationships could not be read. Grant DelegatedAdminRelationship.Read.All delegated permission and verify the partner account’s role.',
      );
    const body = (await res.json()) as {
      value?: {
        id: string;
        status: string;
        endDateTime: string;
        customer?: { tenantId: string; displayName: string };
      }[];
      '@odata.nextLink'?: string;
    };
    if (!Array.isArray(body.value)) throw new HttpError(502, 'Microsoft returned an invalid relationship list.');
    for (const row of body.value) {
      if (
        row.status !== 'active' ||
        !row.customer ||
        !GUID.test(row.customer.tenantId) ||
        !(Date.parse(row.endDateTime) > Date.now())
      )
        continue;
      customers.push({
        tenantId: row.customer.tenantId.toLowerCase(),
        name: row.customer.displayName,
        relationshipId: row.id,
        expiresAt: row.endDateTime,
      });
    }
    url = body['@odata.nextLink'];
  }
  return customers;
}

/** No application-permission fallback: Microsoft enforces the signed-in partner user's assignments and consent. */
export async function gdapClient(
  settings: SettingsService,
  orgId: string,
  fetcher: typeof fetch = fetch,
  requireDelegated = false,
): Promise<M365Client> {
  const saved = await settings.m365(orgId);
  if (!saved) throw new HttpError(400, 'Connect Microsoft 365 first.');
  if (saved.authMode !== 'gdap') {
    if (requireDelegated) throw new HttpError(409, 'Connect Microsoft 365 through GDAP to read this inventory.');
    return new M365Client(saved.clientId, saved.clientSecret, fetcher);
  }
  const customers = await gdapCustomers(settings, orgId, fetcher);
  return new M365Client(saved.clientId, saved.clientSecret, fetcher, async (tenant) => {
    // Customer GUIDs must be selected explicitly; domains cannot identify a delegated authorization boundary.
    if (
      !GUID.test(tenant) ||
      !customers.some((c) => c.tenantId === tenant.toLowerCase() && Date.parse(c.expiresAt) > Date.now())
    )
      throw new HttpError(403, 'There is no active GDAP relationship for this customer tenant ID.');
    return accessToken(settings, orgId, tenant, fetcher);
  });
}

export function registerGdapRoutes(
  app: FastifyInstance,
  deps: {
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    identity: IdentityService;
    gdap: GdapService;
    cookieName: string;
    secureCookies: boolean;
    publicOrigin: string;
    fetcher?: typeof fetch;
  },
) {
  const { settings, identity, authed } = deps;
  const redirectUri = `${deps.publicOrigin}${BASE}/callback`;
  const cookieName = 'atlas_gdap';
  const cookie = { httpOnly: true, secure: deps.secureCookies, sameSite: 'lax' as const, path: BASE };
  const pending = new Map<
    string,
    {
      expires: number;
      orgId: string;
      sessionToken: string;
      saved: Connection;
      sealed: string;
      used?: boolean;
      cancelled?: boolean;
    }
  >();
  app.addHook('onClose', async () => {
    pending.clear();
  });
  app.post(`${BASE}/start`, authed, async (req, reply) => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    deps.recent(req);
    const sessionToken = req.cookies[deps.cookieName];
    if (!sessionToken) throw new HttpError(403, 'Use an Atlas browser session to connect GDAP.');
    const saved = await settings.m365(actor.orgId);
    if (!saved) throw new HttpError(400, 'Save the Microsoft 365 connection first.');
    for (const [id, value] of pending) if (value.expires < Date.now()) pending.delete(id);
    if (pending.size >= 500) throw new HttpError(429, 'Too many sign-in attempts. Try again later.');
    const flow = deps.gdap.begin(saved, redirectUri);
    const state = new URL(flow.url).searchParams.get('state')!;
    pending.set(state, { orgId: actor.orgId, sessionToken, saved, sealed: flow.cookie, expires: Date.now() + 600_000 });
    reply.setCookie(cookieName, state, { ...cookie, maxAge: 600 });
    return { url: flow.url };
  });
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    `${BASE}/callback`,
    async (req, reply) => {
      reply.clearCookie(cookieName, cookie);
      const state = req.query.state;
      const flow = state && state === req.cookies[cookieName] ? pending.get(state) : undefined;
      // Consume before network I/O, retaining the flow so Disconnect can cancel an exchange in progress.
      if (flow?.used) return reply.redirect('/admin/data?gdap=expired', 302);
      if (flow) flow.used = true;
      const back = (outcome: string) => reply.redirect(`/admin/data?gdap=${outcome}`, 302);
      if (!flow || flow.expires < Date.now()) return back('expired');
      try {
        const context = await identity.resolve(flow.sessionToken);
        if (!context || context.stage !== 'active' || context.actor.orgId !== flow.orgId)
          throw new HttpError(403, 'The initiating Atlas session ended.');
        requireAdmin(context.actor);
        const result = await deps.gdap.complete(flow.saved, redirectUri, req.query, flow.sealed);
        // Sign-out, disablement and role removal during the Microsoft exchange must also take effect.
        const current = await identity.resolve(flow.sessionToken);
        if (!current || current.stage !== 'active' || current.actor.orgId !== flow.orgId)
          throw new HttpError(403, 'The initiating Atlas session ended.');
        requireAdmin(current.actor);
        if (flow.cancelled || flow.expires < Date.now())
          throw new HttpError(403, 'The GDAP sign-in was cancelled or expired.');
        await settings.saveGdap(
          flow.orgId,
          flow.saved,
          {
            refreshSealed: '',
            oid: result.identity.oid,
            name: result.identity.name,
            email: result.identity.email,
            connectedAt: new Date().toISOString(),
          },
          result.refreshToken,
        );
        await identity.event(current.user, 'GDAP partner account connected', result.identity.tenant, req.ip);
        return back('connected');
      } catch {
        await identity.event(null, 'GDAP partner sign-in failed', 'Reconnect from Microsoft 365 settings', req.ip);
        return back('failed');
      } finally {
        if (state) pending.delete(state);
      }
    },
  );
  app.get(`${BASE}/customers`, authed, async (req) => {
    requireAdmin(req.session!.actor);
    return gdapCustomers(settings, req.session!.actor.orgId, deps.fetcher);
  });
  app.delete(BASE, authed, async (req) => {
    requireAdmin(req.session!.actor);
    deps.recent(req);
    // Invalidate pending login attempts too, including one begun before a disconnect.
    for (const [id, flow] of pending)
      if (flow.orgId === req.session!.actor.orgId) {
        flow.cancelled = true;
        pending.delete(id);
      }
    await settings.disconnectGdap(req.session!.actor.orgId);
    await identity.event(req.session!.user, 'GDAP partner account disconnected', '', req.ip);
    return { ok: true };
  });
}
