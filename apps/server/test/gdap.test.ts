import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { browser, setupOwner, startApp, type Browser, type TestApp } from './helpers.js';
import { SettingsService } from '../src/services/settings.js';
import { staticKeyProvider, type KeyProvider } from '../src/crypto/keys.js';

const PARTNER = '11111111-2222-3333-4444-555555555555';
const APP = '66666666-7777-8888-9999-000000000000';
const CUSTOMER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const SECRET = 'gdap-application-secret';
const BASE = '/api/integrations/m365/gdap';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function microsoft() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'gdap-key', alg: 'RS256', use: 'sig' };
  const state = {
    authorize: new URL('https://example.test'),
    claims: {} as Record<string, unknown>,
    refresh: 'initial-refresh-secret',
    omitRefresh: false,
    rejectRefresh: false,
    calls: [] as { url: string; grant: string; refresh: string }[],
    exchangeWait: null as Promise<void> | null,
    exchangeStarted: null as (() => void) | null,
    relationshipStatus: 'active',
    nextLink: '' as string,
    graphError: null as { code: string; message: string } | null,
  };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [jwk] });
    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      const form = new URLSearchParams(String(init?.body));
      const grant = form.get('grant_type')!;
      state.calls.push({ url: url.toString(), grant, refresh: form.get('refresh_token') ?? '' });
      expect(form.get('client_id')).toBe(APP);
      expect(form.get('client_secret')).toBe(SECRET);
      if (grant === 'authorization_code') {
        state.exchangeStarted?.();
        if (state.exchangeWait) await state.exchangeWait;
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
          state.authorize.searchParams.get('code_challenge'),
        );
        expect(form.get('redirect_uri')).toBe('http://localhost' + BASE + '/callback');
        const header = b64({ alg: 'RS256', kid: 'gdap-key' });
        const body = b64({
          tid: PARTNER,
          iss: `https://login.microsoftonline.com/${PARTNER}/v2.0`,
          aud: APP,
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: state.authorize.searchParams.get('nonce'),
          oid: 'partner-user',
          email: 'tech@partner.test',
          name: 'Partner Tech',
          ...state.claims,
        });
        const signature = sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
        return Response.json({
          id_token: `${header}.${body}.${signature}`,
          ...(state.omitRefresh ? {} : { refresh_token: state.refresh }),
        });
      }
      expect(grant).toBe('refresh_token');
      if (state.rejectRefresh) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      expect(form.get('refresh_token')).toBe(state.refresh);
      state.refresh += '-rotated';
      return Response.json({ access_token: `access-for-${url.pathname.split('/')[1]}`, refresh_token: state.refresh });
    }
    if (url.pathname === '/v1.0/tenantRelationships/delegatedAdminRelationships') {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer access-for-${PARTNER}`);
      const next = url.searchParams.has('page');
      return Response.json({
        value: [
          {
            id: next ? 'second' : 'first',
            status: state.relationshipStatus,
            endDateTime: new Date(Date.now() + 86_400_000).toISOString(),
            customer: { tenantId: next ? OTHER : CUSTOMER, displayName: next ? 'Other Customer' : 'Harbor Dental' },
          },
          {
            id: 'expired',
            status: 'active',
            endDateTime: '2020-01-01T00:00:00Z',
            customer: { tenantId: OTHER, displayName: 'Expired' },
          },
        ],
        ...(!next && state.nextLink ? { '@odata.nextLink': state.nextLink } : {}),
      });
    }
    if (url.pathname === '/v1.0/organization') {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer access-for-${CUSTOMER}`);
      if (state.graphError)
        return Response.json(
          { error: state.graphError },
          {
            status: 400,
            headers: { 'request-id': '12345678-1234-1234-1234-123456789012' },
          },
        );
      return Response.json({ value: [{ id: CUSTOMER, displayName: 'Harbor Dental', verifiedDomains: [] }] });
    }
    if (['/v1.0/users', '/v1.0/subscribedSkus', '/v1.0/directoryRoles'].includes(url.pathname))
      return Response.json({ value: [] });
    throw new Error(`Unexpected Microsoft request: ${url}`);
  }) as typeof fetch;
  return { state, fetcher };
}

describe('GDAP Microsoft 365 delegated connection', () => {
  let t: TestApp;
  let owner: Browser;
  let ms: ReturnType<typeof microsoft>;
  let settings: SettingsService;
  let orgId: string;
  let keys: KeyProvider;
  beforeEach(async () => {
    ms = microsoft();
    keys = staticKeyProvider([randomBytes(32)]);
    t = await startApp({}, { m365Fetch: ms.fetcher, keys });
    owner = (await setupOwner(t.app)).b;
    orgId = (await owner.call('GET', '/api/session')).data.actor.orgId;
    settings = new SettingsService(t.handle.db, keys);
    const saved = await owner.call('PUT', '/api/integrations/m365', {
      clientId: APP,
      clientSecret: SECRET,
      partnerTenantId: PARTNER,
      authMode: 'gdap',
      autoSync: false,
    });
    expect(saved.status).toBe(200);
  });
  afterEach(async () => {
    await t.close();
  });
  async function begin() {
    const response = await owner.call('POST', BASE + '/start', {});
    expect(response.status).toBe(200);
    ms.state.authorize = new URL(response.data.url);
    return ms.state.authorize.searchParams.get('state')!;
  }
  async function complete(state = ms.state.authorize.searchParams.get('state')!) {
    return owner.call('GET', BASE + '/callback?code=fake-code&state=' + state, undefined, {
      'sec-fetch-site': 'cross-site',
    });
  }
  async function connect() {
    await begin();
    const response = await complete();
    expect(response.headers.location).toBe('/admin/data?gdap=connected');
  }

  it('connects with PKCE and validated OIDC, protects the refresh token, and rejects replay', async () => {
    const state = await begin();
    expect(ms.state.authorize.pathname).toBe(`/${PARTNER}/oauth2/v2.0/authorize`);
    expect(ms.state.authorize.searchParams.get('scope')).toContain('offline_access');
    expect(ms.state.authorize.searchParams.get('scope')).toContain('DelegatedAdminRelationship.Read.All');
    // Strict Atlas session cookies do not accompany Microsoft's cross-site callback; the Lax flow cookie does.
    const callback = browser(t.app);
    callback.jar.set('atlas_gdap', owner.jar.get('atlas_gdap')!);
    const returned = await callback.call('GET', BASE + '/callback?code=one&state=' + state, undefined, {
      'sec-fetch-site': 'cross-site',
    });
    expect(returned.headers.location).toContain('gdap=connected');
    expect((await complete(state)).headers.location).toContain('gdap=expired');
    const response = await owner.call('GET', '/api/integrations/m365');
    expect(response.data.connection.gdap.email).toBe('tech@partner.test');
    expect(JSON.stringify(response.data)).not.toContain(ms.state.refresh);
    const [row] = await t.handle.db.select().from(schema.orgs).where(eq(schema.orgs.id, orgId));
    expect(JSON.stringify(row!.settings)).not.toContain(ms.state.refresh);
    expect(await settings.gdapRefresh(orgId)).toBe(ms.state.refresh);
  });

  it.each([
    { tid: OTHER, iss: `https://login.microsoftonline.com/${OTHER}/v2.0` },
    { iss: 'https://attacker.test' },
    { aud: OTHER },
    { nonce: 'wrong' },
    { exp: 1 },
  ])('rejects mismatched token claims: %j', async (claims) => {
    ms.state.claims = claims;
    await begin();
    expect((await complete()).headers.location).toContain('gdap=failed');
    expect((await settings.m365(orgId))!.gdap).toBeUndefined();
  });

  it('requires a refresh grant and a matching browser state cookie', async () => {
    const state = await begin();
    const stranger = browser(t.app);
    expect((await stranger.call('GET', BASE + '/callback?code=one&state=' + state)).headers.location).toContain(
      'gdap=expired',
    );
    expect(ms.state.calls).toHaveLength(0);
    ms.state.omitRefresh = true;
    expect((await complete()).headers.location).toContain('gdap=failed');
  });

  it('does not complete after the initiating Atlas session ends', async () => {
    await begin();
    await owner.call('DELETE', '/api/session');
    expect((await complete()).headers.location).toContain('gdap=failed');
    expect((await settings.m365(orgId))!.gdap).toBeUndefined();
  });

  it('does not restore a connection changed or removed while sign-in was in progress', async () => {
    await begin();
    await owner.call('DELETE', '/api/integrations/m365');
    expect((await complete()).headers.location).toContain('gdap=failed');
    expect(await settings.m365(orgId)).toBeNull();
  });

  it('paginates active customers and rotates encrypted refresh tokens', async () => {
    await connect();
    ms.state.nextLink = 'https://graph.microsoft.com/v1.0/tenantRelationships/delegatedAdminRelationships?page=2';
    const response = await owner.call('GET', BASE + '/customers');
    expect(response.status).toBe(200);
    expect(response.data.map((c: { tenantId: string }) => c.tenantId)).toEqual([CUSTOMER, OTHER]);
    expect(await settings.gdapRefresh(orgId)).toBe(ms.state.refresh);
    expect(ms.state.calls.at(-1)?.grant).toBe('refresh_token');
    expect(ms.state.calls.at(-1)?.url).toContain(PARTNER);
  });

  it('refuses foreign pagination URLs without sending a Graph token', async () => {
    await connect();
    ms.state.nextLink = 'https://attacker.test/steal';
    expect((await owner.call('GET', BASE + '/customers')).status).toBe(502);
  });

  it('uses a customer-scoped delegated token for checks and refuses inactive relationships', async () => {
    await connect();
    const client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data;
    await owner.call('POST', '/api/integrations/m365/tenants', { clientId: client.id, tenant: CUSTOMER });
    let response = await owner.call('POST', `/api/integrations/m365/tenants/${client.id}/check`, {});
    expect(response.status).toBe(200);
    expect(response.data.tenants[0].status).toBe('ok');
    expect(ms.state.calls.at(-1)?.url).toContain(CUSTOMER);
    ms.state.relationshipStatus = 'terminated';
    response = await owner.call('POST', `/api/integrations/m365/tenants/${client.id}/check`, {});
    expect(response.data.tenants[0].status).toBe('failed');
    expect(response.data.tenants[0].detail).toContain('no active GDAP');
    expect(ms.state.calls.every((c) => c.grant !== 'client_credentials')).toBe(true);
  });

  it('saves safe Graph diagnostics in the customer check status without exposing credentials', async () => {
    await connect();
    const client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data;
    await owner.call('POST', '/api/integrations/m365/tenants', { clientId: client.id, tenant: CUSTOMER });
    ms.state.graphError = {
      code: 'Request_UnsupportedQuery',
      message: `Unsupported query. secret=${SECRET} refresh=${ms.state.refresh} access-for-${CUSTOMER}`,
    };
    const checked = await owner.call('POST', `/api/integrations/m365/tenants/${client.id}/check`, {});
    expect(checked.data.tenants[0].status).toBe('failed');
    expect(checked.data.tenants[0].detail).toContain('Microsoft code Request_UnsupportedQuery');
    expect(checked.data.tenants[0].detail).toContain('Microsoft request ID 12345678-1234-1234-1234-123456789012');
    const saved = await owner.call('GET', '/api/integrations/m365');
    expect(saved.data.tenants[0].detail).toBe(checked.data.tenants[0].detail);
    for (const secret of [SECRET, ms.state.refresh, `access-for-${CUSTOMER}`])
      expect(JSON.stringify(saved.data)).not.toContain(secret);
  });

  it('runs the documentation sync with delegated customer access', async () => {
    await connect();
    const client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data;
    await owner.call('POST', '/api/integrations/m365/tenants', { clientId: client.id, tenant: CUSTOMER });
    const started = await owner.call('POST', '/api/integrations/m365/sync', {});
    expect(started.status).toBe(202);
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await owner.call('GET', '/api/import/jobs/' + started.data.id)).data;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(job.status).toBe('done');
    const assets = (await owner.call('GET', '/api/assets?client=' + client.id)).data;
    expect(assets.some((asset: { name: string }) => asset.name === 'Microsoft 365: Harbor Dental')).toBe(true);
    expect(ms.state.calls.filter((call) => call.url.includes(CUSTOMER)).length).toBeGreaterThan(1);
    expect(ms.state.calls.every((call) => call.grant !== 'client_credentials')).toBe(true);
  });

  it('does not fall back to application permissions when a refresh grant is revoked', async () => {
    await connect();
    ms.state.rejectRefresh = true;
    const response = await owner.call('GET', BASE + '/customers');
    expect(response.status).toBe(400);
    expect(ms.state.calls.every((c) => c.grant !== 'client_credentials')).toBe(true);
  });

  it('cancels a first connection while Microsoft is exchanging the code', async () => {
    await begin();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    ms.state.exchangeWait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    ms.state.exchangeStarted = entered;
    const completion = complete();
    await started;
    expect((await owner.call('DELETE', BASE)).status).toBe(200);
    resume();
    expect((await completion).headers.location).toContain('gdap=failed');
    expect((await settings.m365(orgId))!.gdap).toBeUndefined();
  });

  it('disconnects the partner account and clears pending callbacks', async () => {
    await connect();
    await begin();
    expect((await owner.call('DELETE', BASE)).status).toBe(200);
    expect((await complete()).headers.location).toContain('gdap=expired');
    expect((await owner.call('GET', BASE + '/customers')).status).toBe(400);
    expect((await settings.m365(orgId))!.gdap).toBeUndefined();
  });

  it('serializes simultaneous refreshes and preserves rotated tokens', async () => {
    await connect();
    const responses = await Promise.all([
      owner.call('GET', BASE + '/customers'),
      owner.call('GET', BASE + '/customers'),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(await settings.gdapRefresh(orgId)).toBe(ms.state.refresh);
  });

  it('keeps the delegated grant readable after master key rotation', async () => {
    await connect();
    const rotated = staticKeyProvider([randomBytes(32), keys.key(keys.keyId)]);
    await new SettingsService(t.handle.db, rotated).rewrapSecrets();
    settings = new SettingsService(t.handle.db, staticKeyProvider([rotated.key(rotated.keyId)]));
    expect(await settings.gdapRefresh(orgId)).toBe(ms.state.refresh);
  });

  it('refuses a callback if the connecting account was disabled', async () => {
    await begin();
    const user = (await owner.call('GET', '/api/session')).data.actor;
    await t.handle.db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, user.id));
    expect((await complete()).headers.location).toContain('gdap=failed');
    expect((await settings.m365(orgId))!.gdap).toBeUndefined();
  });

  it('rejects non-administrators at GDAP endpoints', async () => {
    const actor = (await owner.call('GET', '/api/session')).data.actor;
    await t.handle.db.update(schema.users).set({ role: 'technician' }).where(eq(schema.users.id, actor.id));
    expect((await owner.call('POST', BASE + '/start', {})).status).toBe(403);
    expect((await owner.call('GET', BASE + '/customers')).status).toBe(403);
    expect((await owner.call('DELETE', BASE)).status).toBe(403);
  });

  it('does not restore a disconnected grant from an in-flight refresh', async () => {
    await connect();
    const saved = (await settings.m365(orgId))!;
    await settings.disconnectGdap(orgId);
    await expect(settings.saveGdap(orgId, saved, saved.gdap!, 'stale-refresh')).rejects.toMatchObject({ status: 409 });
    expect((await settings.m365(orgId))!.gdap).toBeUndefined();
  });

  it('preserves token rotation when sync metadata changes', async () => {
    await connect();
    const saved = (await settings.m365(orgId))!;
    await settings.patchM365(orgId, { lastSyncAt: '2026-10-19T12:00:00Z' });
    await settings.saveGdap(orgId, saved, saved.gdap!, 'new-refresh');
    expect(await settings.gdapRefresh(orgId)).toBe('new-refresh');
    expect((await settings.m365(orgId))!.lastSyncAt).toBe('2026-10-19T12:00:00Z');
  });

  it('requires an authenticated administrator and CSRF on sign-in initiation', async () => {
    expect((await browser(t.app).call('POST', BASE + '/start', {})).status).toBe(401);
    expect((await owner.call('POST', BASE + '/start', {}, { 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect((await owner.call('GET', BASE + '/start', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });
});
