import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mapContact } from '../src/services/integrations/cw-rmm.js';
import { cpuOf, disksOf, memoryOf, policiesOf, thin } from '../src/services/integrations/cw-device-insight.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const CLIENT_ID = 'asio-client-id-123';
const SECRET = 'asio-secret-value-456';
const GB = 1024 ** 3;

/** A fake platform API with one company, one site, one device, its contacts, usage, groups, and policy. */
function fakeAsio() {
  const state = { scopes: [] as string[], policyRefused: false };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === '/v1/token') {
      const body = JSON.parse(String(init?.body));
      state.scopes.push(body.scope);
      if (body.scope === 'platform.policies.read' && state.policyRefused)
        return json({ message: 'missing scope' }, 403);
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (path === '/api/platform/v1/company/companies') return json([{ id: 'c1', name: 'Harbor Dental Group' }]);
    if (path === '/api/platform/v1/company/companies/c1')
      return json({
        id: 'c1',
        name: 'Harbor Dental Group',
        primaryContact: {
          id: 'p1',
          firstName: 'Jane',
          lastName: 'Park',
          title: 'Office manager',
          primaryEmail: { emailAddress: 'Jane@Harbor.example' },
          primaryPhoneNumber: { countryCode: '1', nationalNumber: '919-555-0100', extension: '12' },
        },
      });
    if (path === '/api/platform/v1/contact/contacts')
      return json([
        {
          id: 'p2',
          firstName: 'Bob',
          lastName: 'Stone',
          company: { id: 'c1' },
          emails: [{ emailAddress: 'bob@harbor.example', primaryFlag: true }],
          phoneNumbers: [{ nationalNumber: '919-555-0199', designation: 'Mobile' }],
        },
        { id: 'p3', firstName: 'Former', lastName: 'Staff', company: { id: 'c1' }, activeFlag: false },
        // Another company's contact, from a list that ignored the filter.
        { id: 'p4', firstName: 'Other', lastName: 'Client', company: { id: 'c9' } },
      ]);
    if (path === '/api/platform/v1/company/companies/c1/sites') return json([{ id: 's1', name: 'Main office' }]);
    if (path === '/api/platform/v2/device/categories/all/endpoints')
      return json({ endpoints: [{ endpointId: 'e1', siteId: 's1', friendlyName: 'HDG-DC-01' }] });
    if (path === '/api/platform/v2/device/endpoints/e1/disk-usage')
      return json([
        {
          createTimeUTC: '2026-09-30T06:00:00Z',
          storages: [
            {
              name: 'Disk 0',
              partitions: [
                { name: 'p1', mountPoint: 'C:', metric: { freeSpaceBytes: 5 * GB, totalSpaceBytes: 100 * GB } },
                { name: 'p2', mountPoint: 'D:', metric: { freeSpaceBytes: 400 * GB, totalSpaceBytes: 500 * GB } },
              ],
            },
          ],
        },
      ]);
    if (path === '/api/platform/v2/device/endpoints/e1/memory-usage')
      return json([
        {
          createTimeUTC: '2026-09-30T06:00:00Z',
          physicalTotalBytes: 16 * GB,
          physicalInUseBytes: 12 * GB,
          physicalAvailableBytes: 4 * GB,
        },
        {
          createTimeUTC: '2026-09-30T05:00:00Z',
          physicalTotalBytes: 16 * GB,
          physicalInUseBytes: 14 * GB,
          physicalAvailableBytes: 2 * GB,
        },
      ]);
    if (path === '/api/platform/v2/device/endpoints/e1/cpu-usage')
      return json([
        { createTimeUTC: '2026-09-30T05:00:00Z', metric: { percentUtil: 91.2 } },
        { createTimeUTC: '2026-09-30T06:00:00Z', metric: { percentUtil: 12.5 } },
      ]);
    if (path === '/api/platform/v2/managed-endpoints/e1/device-groups') return json(['g2', 'g1']);
    if (path === '/api/platform/v1/device-groups')
      return json([
        { id: 'g1', name: 'Servers' },
        { id: 'g2', name: 'Domain controllers' },
      ]);
    if (path === '/api/platform/v2/policy/companies/c1/sites/s1/endpoints/e1/effective-policy/mapping')
      return json({
        mapping: [
          {
            domainID: 'patch',
            settingID: 'a',
            policy: { id: 'x', name: 'Server patching' },
            container: { type: 'Client' },
          },
          {
            domainID: 'patch',
            settingID: 'b',
            policy: { id: 'x', name: 'Server patching' },
            container: { type: 'Client' },
          },
          {
            domainID: 'av',
            settingID: 'c',
            policy: { id: 'y', name: 'Default' },
            container: { type: 'PartnerDefault' },
          },
        ],
      });
    return json({ message: 'resource not found' }, 404);
  }) as typeof fetch;
  return { state, fetcher };
}

async function sync(owner: Browser) {
  const { id } = (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data;
  for (let i = 0; i < 200; i++) {
    const job = (await owner.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

describe('ConnectWise contacts and device insight', () => {
  let t: TestApp;
  let owner: Browser;
  let asio: ReturnType<typeof fakeAsio>;
  let harbor: string;

  beforeEach(async () => {
    asio = fakeAsio();
    t = await startApp({}, { cwRmmFetch: asio.fetcher });
    owner = (await setupOwner(t.app)).b;
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it("syncs each company's contacts, matching one already there by email", async () => {
    // Typed in before the sync, with a note that must stay.
    await owner.call('POST', `/api/clients/${harbor}/contacts`, {
      name: 'Robert Stone',
      email: 'bob@harbor.example',
      notes: 'Prefers text.',
      primary: true,
    });
    const job = await sync(owner);
    expect(job.status).toBe('done');
    expect(job.counts.contacts).toMatchObject({ created: 2 });
    type C = {
      name: string;
      email: string;
      phone: string;
      mobile: string;
      title: string;
      notes: string;
      primary: boolean;
    };
    const list = async () => (await owner.call('GET', `/api/clients/${harbor}/contacts`)).data as C[];
    const contacts = await list();
    expect(contacts).toHaveLength(2);
    expect(contacts.find((c) => c.email === 'jane@harbor.example')).toMatchObject({
      name: 'Jane Park',
      title: 'Office manager',
      phone: '+1 919-555-0100 x12',
      // Robert was already primary, so the company's primary contact doesn't take that from him.
      primary: false,
    });
    expect(contacts.find((c) => c.email === 'bob@harbor.example')).toMatchObject({
      name: 'Bob Stone',
      mobile: '919-555-0199',
      notes: 'Prefers text.',
      primary: true,
    });

    // A second sync updates rather than copies.
    const again = await sync(owner);
    expect(again.counts.contacts.created ?? 0).toBe(0);
    expect(await list()).toHaveLength(2);
  });

  it('skips contacts when switched off', async () => {
    const options = (await owner.call('GET', '/api/integrations/cw-rmm')).data.options;
    await owner.call('PUT', '/api/integrations/cw-rmm/options', { ...options, contacts: false });
    const job = await sync(owner);
    expect(job.messages.join(' ')).toContain('Not synced this time, as chosen: contacts.');
    expect((await owner.call('GET', `/api/clients/${harbor}/contacts`)).data).toHaveLength(0);
  });

  it("shows a synced device's disks, CPU, memory, groups, and policy, and nothing for other assets", async () => {
    await sync(owner);
    const [asset] = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { id: string }[];
    const res = await owner.call('GET', `/api/assets/${asset!.id}/rmm-insight`);
    expect(res.status).toBe(200);
    expect(res.data.insight).toEqual({
      disks: [
        { name: 'C:', freeBytes: 5 * GB, totalBytes: 100 * GB },
        { name: 'D:', freeBytes: 400 * GB, totalBytes: 500 * GB },
      ],
      memory: { totalBytes: 16 * GB, percent: 75, peakPercent: 87.5, samples: [87.5, 75] },
      cpu: { percent: 12.5, peakPercent: 91.2, samples: [91.2, 12.5] },
      groups: ['Domain controllers', 'Servers'],
      policies: [
        { name: 'Server patching', level: 'Client', settings: 2 },
        { name: 'Default', level: 'PartnerDefault', settings: 1 },
      ],
      notes: [],
    });
    // Groups and policy sign in with their own scope, so a key without them still shows the rest.
    expect(asio.state.scopes).toEqual(expect.arrayContaining(['platform.deviceGroups.read', 'platform.policies.read']));

    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const typed = await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: layouts.find((l) => l.key === 'configuration')!.id,
      name: 'Typed in',
      fields: {},
    });
    expect((await owner.call('GET', `/api/assets/${typed.data.id}/rmm-insight`)).data).toEqual({ insight: null });
  });

  it('says which permission is missing when ConnectWise refuses a part', async () => {
    asio.state.policyRefused = true;
    await sync(owner);
    const [asset] = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { id: string }[];
    const { insight } = (await owner.call('GET', `/api/assets/${asset!.id}/rmm-insight`)).data;
    expect(insight.policies).toBeNull();
    expect(insight.disks).toHaveLength(2);
    expect(insight.notes).toEqual(['Policy: the API key needs the Policies read permission.']);
  });
});

describe('ConnectWise contact and usage mapping', () => {
  it('reads names, emails, and phones, and drops contacts without a name or that are inactive', () => {
    expect(
      mapContact({ id: '1', firstName: 'A', lastName: 'B', primaryEmail: { emailAddress: 'not an email' } }),
    ).toMatchObject({
      name: 'A B',
      email: '',
    });
    expect(mapContact({ id: '1' })).toBeNull();
    expect(mapContact({ id: '1', firstName: 'A', activeFlag: false })).toBeNull();
  });

  it('reads usage defensively', () => {
    expect(disksOf(null)).toEqual([]);
    expect(memoryOf(null)).toBeNull();
    expect(cpuOf([])).toBeNull();
    expect(policiesOf({})).toEqual([]);
    expect(
      thin(
        Array.from({ length: 100 }, (_, i) => i),
        10,
      ),
    ).toHaveLength(10);
    expect(
      thin(
        Array.from({ length: 100 }, (_, i) => i),
        10,
      ).at(-1),
    ).toBe(99);
  });
});
