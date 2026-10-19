import { randomBytes, randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { licenseSchema } from '@atlas/shared';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { SettingsService } from '../src/services/settings.js';
import { M365Client } from '../src/services/integrations/m365.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const APP = '11111111-2222-4333-8444-555555555555';
const PARTNER = '66666666-7777-4888-8999-000000000000';
const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SKU = '11111111-aaaa-4bbb-8ccc-222222222222';
const USER = '22222222-aaaa-4bbb-8ccc-333333333333';
const manual = {
  name: 'Design Suite',
  vendor: 'Example Software',
  seats: 3,
  unitCostCents: 1250,
  assignments: ['Avery'],
};

describe('client license management', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let other: string;
  let settings: SettingsService;
  let orgId: string;
  let active: boolean;
  let assigned: boolean;
  let group: boolean;
  let sourcesKnown: boolean;
  let capacity: number;
  let reject: boolean;
  let graphWrites: number;
  let nextLink: string | undefined;
  const grants: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') {
      const form = new URLSearchParams(init?.body as URLSearchParams);
      grants.push(form.get('grant_type')!);
      expect(form.get('grant_type')).toBe('refresh_token');
      return Response.json({ access_token: `for-${url.pathname.split('/')[1]}` });
    }
    if (url.pathname.endsWith('/delegatedAdminRelationships'))
      return Response.json({
        value: [
          {
            id: 'relationship',
            status: active ? 'active' : 'terminated',
            endDateTime: new Date(Date.now() + 86400000).toISOString(),
            customer: { tenantId: TENANT, displayName: 'Harbor Dental' },
          },
        ],
      });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer for-${TENANT}`);
    if (url.pathname.endsWith('/subscribedSkus'))
      return Response.json({
        value: [
          {
            skuId: SKU,
            skuPartNumber: 'SPB',
            prepaidUnits: { enabled: capacity },
            consumedUnits: assigned ? 1 : 0,
            capabilityStatus: 'Enabled',
          },
        ],
      });
    if (url.pathname === '/v1.0/users')
      return Response.json({
        value: [
          {
            id: USER,
            displayName: 'Avery Example',
            userPrincipalName: 'avery@harbor.test',
            assignedLicenses: assigned ? [{ skuId: SKU }] : [],
            ...(sourcesKnown
              ? { licenseAssignmentStates: group ? [{ skuId: SKU, assignedByGroup: 'group-id' }] : [] }
              : {}),
          },
        ],
        ...(nextLink ? { '@odata.nextLink': nextLink } : {}),
      });
    if (url.pathname === `/v1.0/users/${USER}/assignLicense`) {
      graphWrites++;
      if (reject) return Response.json({ error: { message: 'secret information not for display' } }, { status: 403 });
      const body = JSON.parse(init?.body as string);
      expect(body).toEqual(
        assigned
          ? { addLicenses: [], removeLicenses: [SKU] }
          : { addLicenses: [{ skuId: SKU, disabledPlans: [] }], removeLicenses: [] },
      );
      assigned = !assigned;
      return Response.json({ id: USER });
    }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
  beforeEach(async () => {
    active = true;
    assigned = false;
    group = false;
    sourcesKnown = true;
    capacity = 3;
    reject = false;
    graphWrites = 0;
    nextLink = undefined;
    grants.length = 0;
    const keys = staticKeyProvider([randomBytes(32)]);
    t = await startApp({}, { keys, m365Fetch: fetcher });
    owner = (await setupOwner(t.app)).b;
    orgId = (await owner.call('GET', '/api/session')).data.actor.orgId;
    settings = new SettingsService(t.handle.db, keys);
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    other = (await owner.call('POST', '/api/clients', { name: 'Other Client' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });
  const base = () => `/api/clients/${harbor}/licenses`;
  async function gdap() {
    await owner.call('PUT', '/api/integrations/m365', {
      clientId: APP,
      clientSecret: 'synthetic-app-secret',
      partnerTenantId: PARTNER,
      authMode: 'gdap',
      autoSync: false,
    });
    const saved = (await settings.m365(orgId))!;
    await settings.saveGdap(
      orgId,
      saved,
      {
        refreshSealed: '',
        oid: USER,
        name: 'Partner',
        email: 'partner@atlas.test',
        connectedAt: new Date().toISOString(),
      },
      'synthetic-refresh-token',
    );
    await settings.patchM365(orgId, {
      tenants: {
        [harbor]: { tenantId: TENANT, tenantName: 'Harbor Dental', status: 'ok', checkedAt: null, detail: null },
      },
    });
  }
  const change = (action: 'assign' | 'remove', extra = {}) =>
    owner.call('POST', base() + '/microsoft/assignments', { userId: USER, skuId: SKU, action, ...extra });

  it('tracks assignments, costs and renewals with optimistic concurrency and activity', async () => {
    const created = await owner.call('POST', base(), { ...manual, renewalDate: '2027-01-01', autoRenew: true });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ ...manual, version: 1, renewalDate: '2027-01-01' });
    const url = base() + '/' + created.data.id;
    expect((await owner.call('GET', base())).data.licenses).toHaveLength(1);
    expect((await owner.call('PUT', url, { version: 1, license: { ...manual, seats: 4 } })).data.version).toBe(2);
    expect((await owner.call('PUT', url, { version: 1, license: manual })).status).toBe(409);
    expect((await owner.call('DELETE', url, { version: 1 })).status).toBe(409);
    expect(
      (await owner.call('PUT', `/api/clients/${other}/licenses/${created.data.id}`, { version: 2, license: manual }))
        .status,
    ).toBe(404);
    expect((await owner.call('DELETE', url, { version: 2 })).status).toBe(200);
    expect((await owner.call('GET', base())).data.licenses).toEqual([]);
    const activity = await t.handle.db.select().from(schema.activity).where(eq(schema.activity.entityType, 'license'));
    expect(activity.map((a) => a.action)).toEqual(['Added', 'Updated', 'Deleted']);
  });
  it('rejects invalid costs, duplicate assignments, excess seats and impossible dates', async () => {
    for (const bad of [
      { seats: 0 },
      { unitCostCents: -1 },
      { assignments: ['A', 'a'] },
      { seats: 1, assignments: ['A', 'B'] },
      { renewalDate: '2027-02-30' },
    ])
      expect(licenseSchema.safeParse({ ...manual, ...bad }).success).toBe(false);
    expect((await owner.call('POST', base(), { ...manual, seats: 0 })).status).toBe(400);
  });
  it('enforces read-only, client and organization isolation for every endpoint before Microsoft is called', async () => {
    await gdap();
    const created = (await owner.call('POST', base(), manual)).data;
    const temporary = 'temporary license pass 1234';
    await owner.call('POST', '/api/users', {
      email: 'viewer@atlas.test',
      name: 'Viewer',
      role: 'client_viewer',
      password: temporary,
      grants: [{ clientId: harbor, level: 'read' }],
    });
    const { b } = await signIn(t.app, 'viewer@atlas.test', temporary);
    await b.call('POST', '/api/account/password', { current: temporary, next: 'replaced license password 321' });
    expect((await b.call('GET', base())).status).toBe(200);
    expect((await b.call('GET', base() + '/microsoft')).status).toBe(200);
    expect((await b.call('POST', base(), manual)).status).toBe(403);
    expect((await b.call('PUT', base() + '/' + created.id, { version: 1, license: manual })).status).toBe(403);
    expect((await b.call('DELETE', base() + '/' + created.id, { version: 1 })).status).toBe(403);
    expect(
      (await b.call('POST', base() + '/microsoft/assignments', { userId: USER, skuId: SKU, action: 'assign' })).status,
    ).toBe(403);
    grants.length = 0;
    const [foreignOrg] = await t.handle.db.insert(schema.orgs).values({ name: 'Foreign Org' }).returning();
    const [foreignClient] = await t.handle.db
      .insert(schema.clients)
      .values({ orgId: foreignOrg!.id, name: 'Foreign Client' })
      .returning();
    for (const client of [other, foreignClient!.id, randomUUID()]) {
      const path = `/api/clients/${client}/licenses`;
      expect((await b.call('GET', path)).status).toBe(404);
      expect((await b.call('POST', path, manual)).status).toBe(404);
      expect((await b.call('PUT', path + '/' + created.id, { version: 1, license: manual })).status).toBe(404);
      expect((await b.call('DELETE', path + '/' + created.id, { version: 1 })).status).toBe(404);
      expect((await b.call('GET', path + '/microsoft')).status).toBe(404);
      expect(
        (await b.call('POST', path + '/microsoft/assignments', { userId: USER, skuId: SKU, action: 'assign' })).status,
      ).toBe(404);
    }
    expect(grants).toEqual([]);
    expect(graphWrites).toBe(0);
  });
  it('uses saved tenant and delegated refresh grants for inventory, assignment and removal', async () => {
    await gdap();
    const response = await owner.call('GET', base() + '/microsoft');
    expect(response.status).toBe(200);
    expect(response.data.skus[0]).toMatchObject({ name: 'Microsoft 365 Business Premium', enabled: 3, assigned: 0 });
    expect((await change('assign', { tenantId: PARTNER })).status).toBe(200);
    expect(assigned).toBe(true);
    expect((await change('remove')).status).toBe(200);
    expect(assigned).toBe(false);
    expect(graphWrites).toBe(2);
    expect(new Set(grants)).toEqual(new Set(['refresh_token']));
    const events = await t.handle.db.select().from(schema.securityEvents);
    expect(events.filter((e) => e.action === 'Microsoft 365 license change confirmed via GDAP')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('synthetic-refresh-token');
  });
  it('blocks foreign users/SKUs, exhausted seats, repeat assignments and group removal', async () => {
    await gdap();
    expect((await change('assign', { userId: randomUUID() })).status).toBe(404);
    expect((await change('assign', { skuId: randomUUID() })).status).toBe(404);
    capacity = 0;
    expect((await change('assign')).status).toBe(409);
    capacity = 3;
    assigned = true;
    expect((await change('assign')).status).toBe(409);
    group = true;
    expect((await change('remove')).status).toBe(409);
    sourcesKnown = false;
    expect((await owner.call('GET', base() + '/microsoft')).status).toBe(502);
    expect(graphWrites).toBe(0);
  });
  it('blocks revoked/expired delegation, missing consent, application fallback and stale authentication', async () => {
    await gdap();
    active = false;
    expect((await owner.call('GET', base() + '/microsoft')).status).toBe(403);
    expect((await change('assign')).status).toBe(403);
    active = true;
    reject = true;
    const denied = await change('assign');
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.data)).not.toContain('secret information');
    reject = false;
    await t.handle.db.update(schema.sessions).set({ reauthAt: new Date(0) });
    expect((await change('assign')).status).toBe(403);
    await settings.disconnectGdap(orgId);
    expect((await owner.call('GET', base() + '/microsoft')).status).toBe(400);
    const saved = (await settings.m365(orgId))!;
    await settings.saveM365(orgId, (await owner.call('GET', '/api/session')).data.actor.id, {
      clientId: APP,
      clientSecret: 'synthetic-app-secret',
      authMode: 'application',
      autoSync: false,
    });
    expect(saved.authMode).toBe('gdap');
    expect((await owner.call('GET', base() + '/microsoft')).status).toBe(409);
    const client = new M365Client(APP, 'synthetic-app-secret', fetcher);
    await expect(client.assignLicense(TENANT, USER, SKU, 'assign')).rejects.toThrow(/GDAP/);
    expect(graphWrites).toBe(1);
  });
  it('fails closed on invalid or cyclic Microsoft pagination', async () => {
    await gdap();
    nextLink = 'https://attacker.test/steal-token';
    expect((await owner.call('GET', base() + '/microsoft')).status).toBe(502);
    nextLink =
      'https://graph.microsoft.com/v1.0/users?$select=id,displayName,userPrincipalName,assignedLicenses,licenseAssignmentStates&$top=999';
    expect((await owner.call('GET', base() + '/microsoft')).status).toBe(502);
    expect(graphWrites).toBe(0);
  });
  it('cascades manual subscriptions when the client is deleted', async () => {
    await owner.call('POST', base(), manual);
    await t.handle.db.delete(schema.clients).where(eq(schema.clients.id, harbor));
    expect(await t.handle.db.select().from(schema.licenses)).toEqual([]);
  });
  it('keeps license routes closed to API keys despite the parent client API scope', async () => {
    await gdap();
    const token = (
      await owner.call('POST', '/api/api-keys', {
        name: 'Synthetic integration',
        scopes: ['read', 'write', 'passwords'],
      })
    ).data.token;
    const headers = { authorization: `Bearer ${token}` };
    for (const suffix of ['', '/microsoft', '/microsoft/assignments']) {
      const response = await t.app.inject({
        method: suffix.endsWith('/assignments') ? 'POST' : 'GET',
        url: '/api/v1' + base().slice(4) + suffix,
        headers,
      });
      expect(response.statusCode).toBe(403);
    }
    expect(
      (await t.app.inject({ method: 'POST', url: '/api/v1' + base().slice(4), headers, payload: manual })).statusCode,
    ).toBe(403);
    expect(grants).toEqual([]);
    expect(graphWrites).toBe(0);
  });
  it('includes manual subscription tracking in client exports', async () => {
    await owner.call('POST', base(), manual);
    const exported = await t.app.inject({
      method: 'GET',
      url: `/api/clients/${harbor}/export`,
      headers: { cookie: owner.cookie },
    });
    expect(exported.statusCode).toBe(200);
    const files = unzipSync(exported.rawPayload);
    const contents = JSON.parse(strFromU8(files['client.json']!));
    expect(contents.licenses).toHaveLength(1);
    expect(contents.licenses[0]).toMatchObject(manual);
  });
});
