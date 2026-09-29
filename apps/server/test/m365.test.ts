import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const APP_ID = '11111111-2222-3333-4444-555555555555';
const SECRET = 'multi-tenant-secret-value';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** A fake Microsoft: token endpoint per tenant (consented or not) and the Graph calls the sync makes. */
function fakeMicrosoft() {
  const state = {
    consented: new Set<string>([TENANT, 'harbordental.onmicrosoft.com']),
    users: [
      {
        id: 'u1',
        displayName: 'Dana Whitfield',
        userPrincipalName: 'dana@harbordental.com',
        mail: 'dana@harbordental.com',
        jobTitle: 'Office manager',
        businessPhones: ['555-0100'],
        mobilePhone: null,
        accountEnabled: true,
        userType: 'Member',
        assignedLicenses: [{ skuId: 'sku-bp' }],
      },
      {
        id: 'u2',
        displayName: 'Dr. Lee',
        userPrincipalName: 'lee@harbordental.com',
        mail: 'lee@harbordental.com',
        jobTitle: 'Dentist',
        businessPhones: [],
        mobilePhone: '555-0199',
        accountEnabled: true,
        userType: 'Member',
        assignedLicenses: [{ skuId: 'sku-bp' }],
      },
      // Unlicensed (a shared mailbox) and a guest: left out by default.
      {
        id: 'u3',
        displayName: 'Front desk',
        userPrincipalName: 'frontdesk@harbordental.com',
        mail: 'frontdesk@harbordental.com',
        accountEnabled: false,
        userType: 'Member',
        assignedLicenses: [],
      },
      {
        id: 'u4',
        displayName: 'Guest',
        userPrincipalName: 'guest_x#EXT#@harbordental.onmicrosoft.com',
        accountEnabled: true,
        userType: 'Guest',
        assignedLicenses: [{ skuId: 'sku-bp' }],
      },
    ] as Record<string, unknown>[],
    graphCalls: [] as string[],
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') {
      const tenant = decodeURIComponent(url.pathname.split('/')[1]!);
      const body = new URLSearchParams(String(init?.body));
      if (body.get('client_id') !== APP_ID || body.get('client_secret') !== SECRET)
        return json(
          { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' },
          401,
        );
      if (!state.consented.has(tenant))
        return json(
          {
            error: 'invalid_client',
            error_description: `AADSTS700016: Application not found in the directory ${tenant}.`,
          },
          400,
        );
      return json({ access_token: `token-for-${tenant}`, expires_in: 3600 });
    }
    expect(url.hostname).toBe('graph.microsoft.com');
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer token-for-/);
    state.graphCalls.push(url.pathname);
    switch (url.pathname) {
      case '/v1.0/organization':
        return json({
          value: [
            {
              id: TENANT,
              displayName: 'Harbor Dental Group',
              verifiedDomains: [
                { name: 'harbordental.onmicrosoft.com', isDefault: false, isInitial: true },
                { name: 'HarborDental.com', isDefault: true, isInitial: false },
              ],
            },
          ],
        });
      case '/v1.0/subscribedSkus':
        return json({
          value: [
            {
              skuId: 'sku-bp',
              skuPartNumber: 'SPB',
              capabilityStatus: 'Enabled',
              consumedUnits: 3,
              prepaidUnits: { enabled: 5 },
            },
            // Free and viral subscriptions aren't documented as licenses.
            {
              skuId: 'sku-free',
              skuPartNumber: 'FLOW_FREE',
              capabilityStatus: 'Enabled',
              consumedUnits: 1,
              prepaidUnits: { enabled: 10000 },
            },
          ],
        });
      case '/v1.0/users': {
        // Two pages, to follow @odata.nextLink.
        const page = url.searchParams.get('page');
        return page
          ? json({ value: state.users.slice(2) })
          : json({
              value: state.users.slice(0, 2),
              '@odata.nextLink': 'https://graph.microsoft.com/v1.0/users?page=2',
            });
      }
      case '/v1.0/directoryRoles':
        return json({ value: [{ displayName: 'Global Administrator', members: [{ id: 'u1' }] }] });
      default:
        return json({ error: { code: 'NotFound' } }, 404);
    }
  }) as typeof fetch;
  return { state, fetcher };
}

async function waitForJob(b: Browser, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

describe('Microsoft 365 sync', () => {
  let t: TestApp;
  let owner: Browser;
  let ms: ReturnType<typeof fakeMicrosoft>;
  let harbor: string;

  beforeEach(async () => {
    ms = fakeMicrosoft();
    t = await startApp({}, { m365Fetch: ms.fetcher });
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('links a client to its tenant once consent is granted, then documents users, licenses, and domains', async () => {
    expect((await owner.call('GET', '/api/integrations/m365')).data.connection).toBeNull();
    const saved = await owner.call('PUT', '/api/integrations/m365', { clientId: APP_ID, clientSecret: SECRET });
    expect(saved.status).toBe(200);
    expect(saved.data.connection.redirectUri).toBe('http://localhost/api/integrations/m365/consent');
    expect(JSON.stringify(saved.data)).not.toContain(SECRET);

    // Linked by domain before consent: the check says what to do, and the consent link points at that tenant.
    ms.state.consented.delete('harbordental.onmicrosoft.com');
    ms.state.consented.delete(TENANT);
    let view = (
      await owner.call('POST', '/api/integrations/m365/tenants', {
        clientId: harbor,
        tenant: 'harbordental.onmicrosoft.com',
      })
    ).data;
    expect(view.tenants[0].consentUrl).toContain(
      'https://login.microsoftonline.com/harbordental.onmicrosoft.com/adminconsent?client_id=',
    );
    view = (await owner.call('POST', `/api/integrations/m365/tenants/${harbor}/check`, {})).data;
    expect(view.tenants[0]).toMatchObject({ status: 'failed' });
    expect(view.tenants[0].detail).toMatch(/consent/);

    // After consent the check finds the tenant and keeps its ID instead of the domain.
    ms.state.consented.add('harbordental.onmicrosoft.com').add(TENANT);
    view = (await owner.call('POST', `/api/integrations/m365/tenants/${harbor}/check`, {})).data;
    expect(view.tenants[0]).toMatchObject({ status: 'ok', tenantId: TENANT, tenantName: 'Harbor Dental Group' });

    // An existing contact with the same email is updated rather than copied.
    await owner.call('POST', `/api/clients/${harbor}/contacts`, {
      name: 'Dana W.',
      email: 'dana@harbordental.com',
      notes: 'Prefers text.',
    });
    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/m365/sync', {})).data.id);
    expect(job.status).toBe('done');
    expect(ms.state.graphCalls.filter((c) => c === '/v1.0/users')).toHaveLength(2);

    const people = (await owner.call('GET', `/api/clients/${harbor}/contacts`)).data as {
      name: string;
      title: string;
      notes: string;
    }[];
    expect(people.map((p) => p.name).sort()).toEqual(['Dana Whitfield', 'Dr. Lee']);
    const dana = people.find((p) => p.name === 'Dana Whitfield')!;
    expect(dana.title).toBe('Office manager');
    expect(dana.notes).toContain('Licenses: Microsoft 365 Business Premium');
    expect(dana.notes).toContain('Admin roles: Global Administrator');
    expect(dana.notes).toContain('Prefers text.');

    const assets = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as {
      name: string;
      fields: Record<string, unknown>;
    }[];
    expect(assets.map((a) => a.name).sort()).toEqual([
      'Microsoft 365 Business Premium',
      'Microsoft 365: Harbor Dental Group',
      'harbordental.com',
    ]);
    const tenant = assets.find((a) => a.name.startsWith('Microsoft 365:'))!;
    expect(tenant.fields).toMatchObject({
      tenant_id: TENANT,
      default_domain: 'harbordental.com',
      // Number fields are stored as numbers.
      users: 2,
      global_admins: 'dana@harbordental.com',
    });
    expect(assets.find((a) => a.name === 'Microsoft 365 Business Premium')!.fields).toMatchObject({
      seats: 5,
      assigned: 3,
      vendor: 'Microsoft',
    });

    // A second run updates in place.
    const again = await waitForJob(owner, (await owner.call('POST', '/api/integrations/m365/sync', {})).data.id);
    expect(again.counts.contacts.created ?? 0).toBe(0);
    expect(again.counts.licenses.created ?? 0).toBe(0);
    expect((await owner.call('GET', `/api/clients/${harbor}/contacts`)).data).toHaveLength(2);
  });

  it('reports a tenant it can no longer read without stopping the others, and refuses a tenant linked twice', async () => {
    await owner.call('PUT', '/api/integrations/m365', { clientId: APP_ID, clientSecret: SECRET });
    const northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    await owner.call('POST', '/api/integrations/m365/tenants', { clientId: harbor, tenant: TENANT });
    expect(
      (await owner.call('POST', '/api/integrations/m365/tenants', { clientId: northline, tenant: TENANT })).status,
    ).toBe(409);
    await owner.call('POST', '/api/integrations/m365/tenants', {
      clientId: northline,
      tenant: 'northline.onmicrosoft.com',
    });

    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/m365/sync', {})).data.id);
    expect(job.status).toBe('done');
    expect(job.counts.tenants.failed).toBe(1);
    expect(job.messages.join(' ')).toMatch(/northline\.onmicrosoft\.com: .*consent/);
    const view = (await owner.call('GET', '/api/integrations/m365')).data;
    expect(
      Object.fromEntries(view.tenants.map((l: { clientName: string; status: string }) => [l.clientName, l.status])),
    ).toEqual({
      'Harbor Dental Group': 'ok',
      'Northline Architecture': 'failed',
    });

    // The consent return only redirects; it changes nothing and needs no session.
    const back = await t.app.inject({
      method: 'GET',
      url: `/api/integrations/m365/consent?admin_consent=True&tenant=${TENANT}&state=${harbor}`,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`/#/admin/data?m365=consented&client=${harbor}`);

    expect((await owner.call('DELETE', `/api/integrations/m365/tenants/${northline}`)).data.tenants).toHaveLength(1);
    expect((await owner.call('DELETE', '/api/integrations/m365')).status).toBe(200);
    expect((await owner.call('GET', '/api/integrations/m365')).data.connection).toBeNull();
  });
});
