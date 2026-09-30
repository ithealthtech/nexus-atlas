import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contactFor, signInsOf } from '../src/services/integrations/cw-rmm.js';
import { endOfLife, softwareFlagger } from '../src/services/software-rules.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const CLIENT_ID = 'asio-client-id-123';
const SECRET = 'asio-secret-value-456';
// 2026-09-20, as Unix seconds, the way the users API gives a last sign-in.
const SIGNED_IN = 1789900000;

/** A fake platform API with three devices (a host, its VM, and a laptop), their software, users, and relations. */
function fakeAsio() {
  const calls: string[] = [];
  const devices = [
    { endpointId: 'e1', siteId: 's1', friendlyName: 'HDG-HV-01', endpointType: 'Server' },
    { endpointId: 'e2', siteId: 's1', friendlyName: 'HDG-APP-01', endpointType: 'Server' },
    { endpointId: 'e3', siteId: 's1', friendlyName: 'HDG-LT-07', endpointType: 'Laptop' },
  ];
  const apps: Record<string, { name: string; version: string; publisher?: string }[]> = {
    e1: [{ name: 'Microsoft 365 Apps for business - en-us', version: '16.0' }],
    e2: [{ name: 'Microsoft SQL Server 2014 (64-bit)', version: '12.0' }],
    e3: [
      { name: 'Microsoft 365 Apps for business - en-us', version: '16.0', publisher: 'Microsoft Corporation' },
      { name: 'Adobe Acrobat Pro DC', version: '24.1' },
      { name: '7-Zip 24.08 (x64)', version: '24.08' },
      { name: '7-Zip 24.08 (x64)', version: '24.08' },
    ],
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/token') return json({ access_token: 'tok', expires_in: 3600 });
    if (url.pathname === '/api/platform/v1/company/companies') return json([{ id: 'c1', name: 'Harbor Dental Group' }]);
    if (url.pathname === '/api/platform/v1/company/companies/c1/sites')
      return json([{ id: 's1', name: 'Main office' }]);
    if (url.pathname === '/api/platform/v2/device/categories/all/endpoints') return json({ endpoints: devices });
    if (url.pathname === '/api/platform/v2/device/endpoints/applications')
      return json(
        Object.entries(apps).map(([endpointID, applications]) => ({
          companyID: 'c1',
          siteID: 's1',
          endpointID,
          applications,
        })),
      );
    if (url.pathname === '/api/platform/v2/device/endpoints/users')
      return json([
        {
          endpointID: 'e3',
          users: [
            { username: 'jane.doe', domainName: 'HARBOR', lastLogonTimestamp: SIGNED_IN },
            { username: 'Administrator', lastLogonTimestamp: SIGNED_IN },
            { username: 'olduser', userDisabled: true, lastLogonTimestamp: SIGNED_IN },
          ],
        },
      ]);
    if (url.pathname === '/api/platform/v2/device/companies/c1/sites/s1/endpoints/e1/relations')
      return json({
        endpointID: 'e1',
        relations: [{ endpointID: 'e2', relationshipType: { source: 'Host', target: 'Guest' } }],
      });
    if (url.pathname === '/api/platform/v2/device/companies/c1/sites/s1/endpoints/e2/relations')
      return json({
        endpointID: 'e2',
        relations: [{ endpointID: 'e1', relationshipType: { source: 'Guest', target: 'Host' } }],
      });
    return json({ message: 'resource not found' }, 404);
  }) as typeof fetch;
  return { calls, apps, fetcher };
}

async function sync(b: Browser) {
  const id = (await b.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id;
  for (let i = 0; i < 200; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

describe('ConnectWise RMM device inventory', () => {
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

  it('saves software and sign-ins, flags software, and links contacts and VM hosts', async () => {
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const jane = (
      await owner.call('POST', `/api/clients/${harbor}/contacts`, {
        name: 'Jane Doe',
        email: 'jane.doe@harbordental.com',
      })
    ).data;
    const licenses = (await owner.call('GET', '/api/layouts')).data.find((l: { key: string }) => l.key === 'license');
    await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: licenses.id,
      name: 'Microsoft 365 Business Standard',
      fields: { product: 'Microsoft 365 Business Standard', seats: 1 },
    });
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });

    const job = await sync(owner);
    expect(job.status).toBe('done');
    expect(job.messages.join(' ')).toContain('1 new link between devices and the contacts who sign in to them');
    expect(job.messages.join(' ')).toContain('1 new link between virtual machines and their hosts');
    // The laptop hosts nothing, so it's never asked about.
    expect(asio.calls.some((c) => c.includes('/e3/relations'))).toBe(false);

    const assets = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { id: string; name: string }[];
    const id = (name: string) => assets.find((a) => a.name === name)!.id;

    const laptop = (await owner.call('GET', `/api/assets/${id('HDG-LT-07')}/inventory`)).data;
    expect(laptop.signIns).toEqual([
      {
        username: 'jane.doe',
        domain: 'HARBOR',
        lastLogonAt: new Date(SIGNED_IN * 1000).toISOString(),
        contactId: jane.id,
        contactName: 'Jane Doe',
      },
    ]);
    expect(laptop.software.map((a: { name: string; flag: string | null }) => [a.name, a.flag])).toEqual([
      ['7-Zip 24.08 (x64)', null],
      ['Adobe Acrobat Pro DC', 'unlicensed'],
      // On two devices, with one seat.
      ['Microsoft 365 Apps for business - en-us', 'over_seats'],
    ]);

    const client = (await owner.call('GET', `/api/clients/${harbor}/software`)).data;
    // Flagged first, then the most installed.
    expect(
      client.map((a: { name: string; flag: string | null; devices: number }) => [a.name, a.flag, a.devices]),
    ).toEqual([
      ['Microsoft 365 Apps for business - en-us', 'over_seats', 2],
      ['Adobe Acrobat Pro DC', 'unlicensed', 1],
      ['Microsoft SQL Server 2014 (64-bit)', 'end_of_life', 1],
      ['7-Zip 24.08 (x64)', null, 1],
    ]);

    const related = (await owner.call('GET', `/api/items/asset/${id('HDG-HV-01')}/relations`)).data;
    expect(related).toMatchObject([{ title: 'HDG-APP-01', note: 'HDG-HV-01 hosts virtual machine HDG-APP-01' }]);
    const janeLinks = (await owner.call('GET', `/api/items/contact/${jane.id}/relations`)).data;
    expect(janeLinks).toMatchObject([{ title: 'HDG-LT-07' }]);

    // A later sync refreshes the software list and makes no second links.
    asio.apps.e3 = [];
    const again = await sync(owner);
    expect(again.messages.join(' ')).not.toContain('new link');
    expect((await owner.call('GET', `/api/assets/${id('HDG-LT-07')}/inventory`)).data.software).toEqual([]);
  });

  it('skips software and sign-ins when switched off', async () => {
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    const options = (await owner.call('GET', '/api/integrations/cw-rmm')).data.options;
    expect(options.inventory).toBe(true);
    await owner.call('PUT', '/api/integrations/cw-rmm/options', { ...options, inventory: false });
    expect((await sync(owner)).status).toBe('done');
    expect(asio.calls.some((c) => /applications|users|relations/.test(c))).toBe(false);
    expect((await owner.call('GET', `/api/clients/${harbor}/software`)).data).toEqual([]);
  });
});

describe('Device inventory rules', () => {
  it('reads sign-ins from the users API and system state, most recent first, without built-in accounts', () => {
    const list = signInsOf([{ username: 'bob', lastLogonTimestamp: 1700000000000 }, { username: 'never' }], {
      lastLoggedOnUser: { username: 'HARBOR\\jane.doe', logonTime: '2026-09-29T08:00:00Z' },
      loggedOnUsers: [{ username: 'DWM-1', logonTime: '2026-09-29T08:00:00Z' }],
    });
    expect(list).toEqual([
      { username: 'jane.doe', domain: 'HARBOR', lastLogonAt: '2026-09-29T08:00:00.000Z' },
      { username: 'bob', domain: '', lastLogonAt: new Date(1700000000000).toISOString() },
    ]);
  });

  it('matches an account to one contact only', () => {
    const contacts = [
      { id: 'a', name: 'Jane Doe', email: 'jane.doe@harbor.com' },
      { id: 'b', name: 'John Doe', email: 'jdoe2@harbor.com' },
    ];
    expect(contactFor('jane.doe', contacts)).toBe('a');
    expect(contactFor('JaneDoe', contacts)).toBe('a');
    // "jdoe" could be Jane or John.
    expect(contactFor('jdoe', contacts)).toBeNull();
    expect(contactFor('it', contacts)).toBeNull();
  });

  it('flags end of support only once it has passed, and licenses by product family and seats', () => {
    expect(endOfLife('Microsoft Office Professional Plus 2016', new Date('2025-10-01'))).toBeNull();
    expect(endOfLife('Microsoft Office Professional Plus 2016', new Date('2025-10-15'))).toContain('2025-10-14');
    const flag = softwareFlagger([{ text: 'Adobe Acrobat Standard', seats: null }], new Map());
    expect(flag('Adobe Acrobat Pro DC').flag).toBeNull();
    expect(flag('Adobe Acrobat Reader DC').flag).toBeNull();
    expect(flag('QuickBooks Desktop Pro 2024').flag).toBe('unlicensed');
    expect(flag('Google Chrome').flag).toBeNull();
  });
});
