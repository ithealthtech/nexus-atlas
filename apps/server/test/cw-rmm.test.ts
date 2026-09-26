import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { deviceType } from '../src/services/integrations/cw-rmm.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const CLIENT_ID = 'asio-client-id-123';
const SECRET = 'asio-secret-value-456';

type Device = Record<string, unknown>;

/** A fake Asio API: token exchange, companies, sites, and paged endpoints. */
function fakeAsio() {
  const state = {
    tokens: 0,
    calls: [] as string[],
    devices: new Map<string, Device[]>([
      [
        'c1',
        Array.from({ length: 205 }, (_, i) => ({
          endpointId: `e${i}`,
          siteId: 's1',
          friendlyName: i === 0 ? 'HDG-DC-01' : `HDG-WS-${i}`,
          hostName: i === 0 ? 'hdg-dc-01' : `hdg-ws-${i}`,
          endpointType: i === 0 ? 'Server' : 'Desktop',
          os: { name: i === 0 ? 'Windows Server 2022' : 'Windows 11 Pro' },
          ipAddress: `10.0.0.${i % 250}`,
          serialNumber: `SN${i}`,
        })),
      ],
      ['c2', [{ endpointId: 'x1', friendlyName: 'Northline laptop', endpointType: 'Laptop' }]],
    ]),
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    state.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/token') {
      const body = JSON.parse(String(init?.body));
      if (body.client_id !== CLIENT_ID || body.client_secret !== SECRET) return json({ error: 'invalid_client' }, 401);
      state.tokens++;
      return json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
    }
    if ((init?.headers as Record<string, string>).Authorization !== 'Bearer tok') return json({}, 401);
    if (url.pathname === '/api/platform/v1/company/companies')
      return json([
        { id: 'c1', name: 'Harbor Dental Group' },
        { id: 'c2', name: 'Northline Architecture' },
        { id: 'c3', name: 'Old Prospect' },
      ]);
    const sites = url.pathname.match(/^\/api\/platform\/v1\/company\/companies\/(\w+)\/sites$/);
    if (sites)
      return json(
        sites[1] === 'c1'
          ? [{ id: 's1', name: 'Main office', address: { line1: '410 Harbor St', city: 'Raleigh', state: 'NC' } }]
          : [],
      );
    if (url.pathname === '/api/platform/v2/device/categories/all/endpoints') {
      const request = JSON.parse(String(init?.body));
      // Like a real tenant, only one resource type is accepted.
      if (request.resourceType !== 'company') return json({ message: 'invalid resource type' }, 400);
      const company = request.resources[0] as string;
      const limit = Number(url.searchParams.get('limit'));
      const cursor = Number(url.searchParams.get('cursor'));
      const all = state.devices.get(company) ?? [];
      if (!all.length) return json({ message: 'resource not found' }, 404);
      return json({ endpoints: all.slice(cursor, cursor + limit) });
    }
    return json({}, 404);
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

describe('ConnectWise RMM sync', () => {
  let t: TestApp;
  let owner: Browser;
  let asio: ReturnType<typeof fakeAsio>;

  beforeEach(async () => {
    asio = fakeAsio();
    t = await startApp({}, { cwRmmFetch: asio.fetcher });
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('checks credentials on save and keeps the secret encrypted', async () => {
    const bad = await owner.call('PUT', '/api/integrations/cw-rmm', {
      clientId: CLIENT_ID,
      clientSecret: 'wrong-secret-1',
    });
    expect(bad.status).toBe(400);
    expect((await owner.call('GET', '/api/integrations/cw-rmm')).data).toBeNull();
    const ok = await owner.call('PUT', '/api/integrations/cw-rmm', {
      region: 'na',
      clientId: CLIENT_ID,
      clientSecret: SECRET,
    });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ clientId: CLIENT_ID, hasSecret: true, companies: 3 });
    expect(JSON.stringify(ok.data)).not.toContain(SECRET);
    const stored = await t.handle.db.execute(sql`select settings::text as s from orgs`);
    expect(JSON.stringify(stored.rows)).not.toContain(SECRET);
    // Saving again without a secret keeps the stored one.
    expect((await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID })).status).toBe(200);
  });

  it('maps companies, syncs sites and devices, and archives removed devices', async () => {
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;

    const companies = (await owner.call('GET', '/api/integrations/cw-rmm/companies')).data;
    expect(companies.find((c: { id: string }) => c.id === 'c1')).toMatchObject({
      action: null,
      suggestedClientId: harbor,
    });

    const mapped = await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [
        { companyId: 'c1', action: 'link', clientId: harbor },
        { companyId: 'c2', action: 'create' },
        { companyId: 'c3', action: 'skip' },
      ],
    });
    expect(mapped.status).toBe(200);
    const northline = mapped.data.find((c: { id: string }) => c.id === 'c2');
    expect(northline).toMatchObject({ action: 'link', clientName: 'Northline Architecture' });

    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(job.status).toBe('done');
    expect(job.counts.assets.created).toBe(206);
    expect(job.counts.locations.created).toBe(1);
    // Paged past the first 200 devices, and never asked about the skipped company.
    // One rejected shape (client), then three pages of 100 for Harbor and one for Northline, with a single sign-in.
    expect(asio.state.calls.filter((c) => c.includes('/endpoints')).length).toBe(5);
    expect(asio.state.tokens).toBe(1);

    const assets = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as {
      id: string;
      name: string;
      fields: Record<string, string>;
    }[];
    expect(assets).toHaveLength(205);
    const dc = assets.find((a) => a.name === 'HDG-DC-01')!;
    expect(dc.fields).toMatchObject({
      type: 'Server',
      hostname: 'hdg-dc-01',
      operating_system: 'Windows Server 2022',
      ip_address: '10.0.0.0',
      serial_number: 'SN0',
      location: 'Main office',
    });

    // A second sync updates rather than duplicates, and archives what the RMM dropped.
    asio.state.devices.set('c1', asio.state.devices.get('c1')!.slice(0, 204));
    const again = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(again.counts.assets.created ?? 0).toBe(0);
    expect(again.messages.join(' ')).toContain('Archived 1 device');
    expect((await owner.call('GET', `/api/assets?client=${harbor}`)).data).toHaveLength(204);
    expect((await owner.call('GET', '/api/integrations/cw-rmm')).data.lastSyncAt).not.toBeNull();
  });

  it('is for administrators only', async () => {
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const user = await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess Tech',
      password: 'temporary pass 1234',
      role: 'technician',
      allClients: 'edit_passwords',
    });
    expect(user.status, JSON.stringify(user.data)).toBe(201);
    const { b: tech } = await signIn(t.app, 'tess@atlas.test', 'temporary pass 1234');
    const changed = await tech.call('POST', '/api/account/password', {
      current: 'temporary pass 1234',
      next: 'rmm reviewer pass 99',
    });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    await enroll(tech);
    expect((await tech.call('GET', '/api/integrations/cw-rmm/companies')).status).toBe(403);
    expect((await tech.call('POST', '/api/integrations/cw-rmm/sync', {})).status).toBe(403);
  });

  it('maps device types onto the Configurations layout', () => {
    expect(deviceType({ type: 'Server', os: '' })).toBe('Server');
    expect(deviceType({ type: '', os: 'Windows Server 2019' })).toBe('Server');
    expect(deviceType({ type: 'Laptop', os: 'Windows 11' })).toBe('Laptop');
    expect(deviceType({ type: 'Desktop', os: 'Windows 11' })).toBe('Workstation');
    expect(deviceType({ type: '', os: '' })).toBe('Other');
  });
});

describe('ConnectWise RMM client', () => {
  it('shares one sign-in, waits out a lock, and reports what ConnectWise said', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    let tokens = 0;
    let locked = 1;
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') {
        tokens++;
        if (locked-- > 0) return new Response('{}', { status: 423, headers: { 'retry-after': '0.01' } });
        return Response.json({ access_token: 'tok', expires_in: 3600 });
      }
      if (url.pathname.endsWith('/sites')) return Response.json([]);
      return Response.json({ message: 'resources must not be empty' }, { status: 400 });
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    await Promise.all([client.sites('a'), client.sites('b'), client.sites('c')]);
    // One lock, one retry: two token requests in total, however many callers.
    expect(tokens).toBe(2);
    await expect(client.devices('a')).rejects.toThrow(
      /Tried v2 by client: resources must not be empty; v2 by company: resources must not be empty; v2 by partner: resources must not be empty; v1 list: resources must not be empty/,
    );
  });
});

describe('ConnectWise RMM device-list errors', () => {
  it('keeps every attempt in the message, however long each answer is', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.pathname.startsWith('/api/platform/v1/device'))
        return Response.json({ message: 'access denied' }, { status: 403 });
      return Response.json({ message: `invalid request ${'x'.repeat(190)}` }, { status: 400 });
    }) as typeof fetch;
    const error = await new CwRmmClient('na', 'id', 'secret', fetcher).devices('a', ['s1']).catch((e: Error) => e);
    expect(error.message).toContain('v1 list: access denied');
    expect(error.message).toContain('v2 by site: invalid request');
    // The sync adds "Company <id>: " before it; the whole line must fit the 800-character job message.
    expect(`Company ${'0'.repeat(36)}: ${error.message}`.length).toBeLessThanOrEqual(800);
  });
});

describe('ConnectWise RMM companies without devices', () => {
  it('treats "resource not found" as no devices, not a failure', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      const { resourceType, resources } = JSON.parse(String(init?.body));
      if (resourceType !== 'client') return Response.json({ message: 'invalid resource type' }, { status: 400 });
      if (resources[0] === 'empty') return Response.json({ message: 'resource not found' }, { status: 404 });
      return Response.json({ endpoints: [{ endpointId: 'e1', friendlyName: 'PC-1' }] });
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    expect(await client.devices('empty')).toEqual([]);
    expect((await client.devices('full')).map((d) => d.name)).toEqual(['PC-1']);
  });
});

describe('ConnectWise RMM response shapes', () => {
  it('finds devices nested deeper in the response, and describes an empty one by field names only', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    let body: unknown = { data: { endpoints: [{ endpointId: 'e1', friendlyName: 'PC-1', clientId: 12345 }] } };
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      return Response.json(body);
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    // A device's own client ID in another numbering doesn't drop it when the list is already per company.
    expect((await client.devices('company-uuid')).map((d) => d.name)).toEqual(['PC-1']);
    body = { total: 0, secretish: 'value-not-shown', paging: { cursor: 0 } };
    expect(await client.devices('company-uuid')).toEqual([]);
    expect(client.lastDeviceList).toContain('response fields total, secretish, paging{cursor}');
    expect(client.lastDeviceList).not.toContain('value-not-shown');
  });
});
