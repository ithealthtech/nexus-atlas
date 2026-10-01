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
    // By company, as the spec says, 500 to a page: one page each for Harbor and Northline, and never a call for the
    // skipped company. A single sign-in for devices (tickets sign in once more, with their own scope).
    expect(asio.state.calls.filter((c) => c.includes('/categories/all/endpoints')).length).toBe(2);
    expect(asio.state.tokens).toBe(2);

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

  it('updates a same-named asset that is already there instead of adding a copy', async () => {
    asio.state.devices.set('c1', [
      { endpointId: 'e1', siteId: 's1', friendlyName: 'HDG-DC-01', hostName: 'hdg-dc-01', ipAddress: '10.0.0.5' },
      { endpointId: 'e2', siteId: 's1', friendlyName: 'HDG-WS-02', hostName: 'hdg-ws-02', ipAddress: '10.0.0.6' },
    ]);
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    // Like a Hudu import: another layout, with differently named fields.
    const hudu = (
      await owner.call('POST', '/api/layouts', {
        name: 'Computer Assets',
        icon: 'box',
        fields: [
          { key: 'host', label: 'Host name', type: 'text' },
          { key: 'addr', label: 'IP address', type: 'ip' },
          { key: 'notes_extra', label: 'Owner', type: 'text' },
        ],
      })
    ).data.id;
    const dc = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: hudu,
        name: 'HDG-DC-01',
        fields: { notes_extra: 'Front office' },
      })
    ).data;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });

    const first = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(first.messages.join(' ')).toContain('1 device matched an asset already in Atlas');
    const all = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { id: string; name: string }[];
    expect(all.map((a) => a.name).sort()).toEqual(['HDG-DC-01', 'HDG-WS-02']);
    const updated = (await owner.call('GET', `/api/assets/${dc.id}`)).data;
    // Existing fields take what fits; the site had no field in this layout, so the sync added one.
    expect(updated.fields).toMatchObject({
      notes_extra: 'Front office',
      host: 'hdg-dc-01',
      addr: '10.0.0.5',
      location: 'Main office',
    });
    const computers = (await owner.call('GET', '/api/layouts')).data.find(
      (l: { name: string }) => l.name === 'Endpoints',
    );
    expect(computers.fields.map((f: { label: string }) => f.label)).toContain('Location');

    // A copy an earlier sync made is folded into the asset that was already there.
    const ws = all.find((a) => a.name === 'HDG-WS-02')!;
    const old = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId: hudu, name: 'HDG-WS-02', fields: {} })
    ).data;
    const second = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(second.messages.join(' ')).toContain('1 copy from earlier syncs archived');
    expect(second.messages.join(' ')).not.toContain('copyies');
    expect((await owner.call('GET', `/api/assets/${ws.id}`)).data.archived).toBe(true);
    expect((await owner.call('GET', `/api/assets/${old.id}`)).data.fields).toMatchObject({ host: 'hdg-ws-02' });
    // Stays settled on the next run: nothing new is archived or copied.
    const third = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(third.messages.join(' ')).not.toContain('archived');
    expect((await owner.call('GET', `/api/assets?client=${harbor}`)).data).toHaveLength(2);
  });

  it('syncs only what was chosen, and never archives devices while devices are switched off', async () => {
    asio.state.devices.set('c1', [
      { endpointId: 'e1', siteId: 's1', friendlyName: 'HDG-DC-01' },
      { endpointId: 'e2', siteId: 's1', friendlyName: 'HDG-WS-02' },
    ]);
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect((await owner.call('GET', `/api/assets?client=${harbor}`)).data).toHaveLength(2);

    const saved = await owner.call('PUT', '/api/integrations/cw-rmm/options', { locations: true, devices: false });
    expect(saved.data.options).toEqual({
      locations: true,
      devices: false,
      contacts: true,
      tickets: true,
      inventory: true,
      atlasLinks: false,
      ticketNotes: false,
      expiryTickets: false,
      expiryTicketDays: 30,
      expiryTicketBoard: '',
      layoutId: null,
    });
    const sitesOnly = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(sitesOnly.counts.assets).toBeUndefined();
    expect(sitesOnly.counts.locations.updated).toBe(1);
    expect(sitesOnly.messages.join(' ')).toContain('Not synced this time, as chosen: devices.');
    // Not reading devices must not look like every device was removed.
    const kept = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { archived: boolean }[];
    expect(kept).toHaveLength(2);

    await owner.call('PUT', '/api/integrations/cw-rmm/options', { locations: false, devices: true });
    const devicesOnly = await waitForJob(
      owner,
      (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id,
    );
    expect(devicesOnly.counts.locations).toBeUndefined();
    expect(devicesOnly.counts.assets.updated).toBe(2);
  });

  it('saves devices in the device layout, not Configurations, and moves ones an earlier sync put there', async () => {
    asio.state.devices.set('c1', [
      { endpointId: 'e1', siteId: 's1', friendlyName: 'HDG-DC-01', hostName: 'hdg-dc-01', endpointType: 'Server' },
      { endpointId: 'e2', siteId: 's1', friendlyName: 'HDG-WS-02', hostName: 'hdg-ws-02', ipAddress: '10.0.0.6' },
      { endpointId: 'e3', siteId: 's1', friendlyName: 'HDG-WS-03', hostName: 'hdg-ws-03' },
    ]);
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    // Before there is a device layout, devices go to Configurations.
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    const layoutsBefore = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const configurationLayout = layoutsBefore.find((l) => l.key === 'configuration')! as {
      id: string;
      key: string;
      fields: object[];
    };
    const configuration = configurationLayout.id;
    // Configurations has a number field someone added.
    await owner.call('PATCH', `/api/layouts/${configuration}`, {
      fields: [...configurationLayout.fields, { key: 'rack_units', label: 'Rack units', type: 'number' }],
    });
    type Row = { id: string; name: string; layoutId: string; fields: Record<string, string> };
    const synced = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as Row[];
    expect(synced.every((a) => a.layoutId === configuration)).toBe(true);
    // Someone added a note to one of them.
    const ws2 = synced.find((a) => a.name === 'HDG-WS-02')!;
    const ws2Full = (await owner.call('GET', `/api/assets/${ws2.id}`)).data;
    await owner.call('PATCH', `/api/assets/${ws2.id}`, {
      fields: { ...ws2Full.fields, purchase_date: '2024-02-01', rack_units: 2 },
      version: ws2Full.version,
    });

    // The organization documents devices in their own layout, where one of them already is.
    const devices = (
      await owner.call('POST', '/api/layouts', {
        name: 'Devices',
        icon: 'monitor',
        fields: [
          { key: 'host', label: 'Hostname', type: 'text' },
          { key: 'ip', label: 'IP address', type: 'ip' },
          { key: 'bought', label: 'Purchase date', type: 'date' },
          { key: 'units', label: 'Rack units', type: 'number' },
        ],
      })
    ).data.id;
    const dc = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId: devices, name: 'HDG-DC-01', fields: {} })
    ).data;
    asio.state.devices.get('c1')!.push({ endpointId: 'e4', siteId: 's1', friendlyName: 'HDG-WS-04' });

    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(job.counts.assets.failed ?? 0).toBe(0);
    expect(job.messages.join(' ')).toContain('2 devices moved into the device layout');
    expect(job.messages.join(' ')).toContain('1 copy from earlier syncs archived');
    const after = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as Row[];
    // Every device is in Devices, once: the copy of HDG-DC-01 folded into the one already there.
    expect(after.map((a) => [a.name, a.layoutId]).sort()).toEqual([
      ['HDG-DC-01', devices],
      ['HDG-WS-02', devices],
      ['HDG-WS-03', devices],
      ['HDG-WS-04', devices],
    ]);
    expect(after.find((a) => a.name === 'HDG-DC-01')!.id).toBe(dc.id);
    // The moved asset is the same one, with what Atlas users entered and the RMM's values in its new fields.
    const moved = (await owner.call('GET', `/api/assets/${ws2.id}`)).data;
    expect(moved.layoutId).toBe(devices);
    expect(moved.fields).toMatchObject({ host: 'hdg-ws-02', ip: '10.0.0.6', bought: '2024-02-01', units: 2 });

    // Restoring a version from before the move puts it back in Configurations, as it was.
    const restored = await owner.call('POST', `/api/assets/${ws2.id}/restore`, {
      version: ws2Full.version + 1,
      expectedVersion: moved.version,
    });
    expect(restored.data.layoutId).toBe(configuration);
    expect(restored.data.fields).toMatchObject({ purchase_date: '2024-02-01', rack_units: 2 });

    // The next run moves the restored one back, and then stays settled.
    const back = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(back.messages.join(' ')).toContain('1 device moved');
    const again = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(again.counts.assets.created ?? 0).toBe(0);
    expect(again.messages.join(' ')).not.toContain('moved');
    expect(again.messages.join(' ')).not.toContain('archived');

    // A device that goes away is archived only if the sync made its asset: the one that was already there stays.
    asio.state.devices.set(
      'c1',
      asio.state.devices.get('c1')!.filter((d) => !['e1', 'e3'].includes(String(d.endpointId))),
    );
    const dropped = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(dropped.messages.join(' ')).toContain('Archived 1 device');
    expect((await owner.call('GET', `/api/assets/${dc.id}`)).data.archived).toBe(false);
    const ws3 = after.find((a) => a.name === 'HDG-WS-03')!;
    expect((await owner.call('GET', `/api/assets/${ws3.id}`)).data.archived).toBe(true);

    // Choosing another endpoint layout folds it into Endpoints, so every device stays in the one layout.
    const computers = (
      await owner.call('POST', '/api/layouts', {
        name: 'Computers',
        icon: 'monitor',
        fields: [{ key: 'host', label: 'Hostname', type: 'text' }],
      })
    ).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/options', {
      locations: true,
      devices: true,
      tickets: true,
      layoutId: computers,
    });
    asio.state.devices.get('c1')!.push({ endpointId: 'e1', siteId: 's1', friendlyName: 'HDG-DC-01' });
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    const switched = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as Row[];
    expect(switched.map((a) => [a.name, a.layoutId === computers ? 'computers' : a.layoutId]).sort()).toEqual([
      ['HDG-DC-01', devices],
      ['HDG-WS-02', devices],
      ['HDG-WS-04', devices],
    ]);

    // An administrator can pick the layout; one from elsewhere is refused.
    const options = { locations: true, devices: true, tickets: true };
    const bad = await owner.call('PUT', '/api/integrations/cw-rmm/options', {
      ...options,
      layoutId: '00000000-0000-4000-8000-000000000000',
    });
    expect(bad.status).toBe(400);
    const picked = await owner.call('PUT', '/api/integrations/cw-rmm/options', { ...options, layoutId: configuration });
    expect(picked.data.options.layoutId).toBe(configuration);
  });

  it('keeps a device whose extra values a field cannot hold, instead of failing it', async () => {
    asio.state.devices.set('c1', [
      {
        endpointId: 'e1',
        siteId: 's1',
        friendlyName: '-MikeC-PC',
        endpointType: 'Desktop',
        // "Type" is a choice list in Configurations; none of these is one of its options.
        type: 'Windows',
        subResourceType: 'workstation',
        installDate: 'not a date',
        agentUrl: 'not a url',
      },
    ]);
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(job.counts.assets).toMatchObject({ created: 1, failed: 0 });
    expect(job.messages.join(' ')).not.toContain('Choose a listed option');
    const [asset] = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { id: string }[];
    const pc = (await owner.call('GET', `/api/assets/${asset!.id}`)).data;
    // The named mapping's Type wins; the odd values are still kept, in fields that take any text.
    expect(pc.fields.type).toBe('Workstation');
    expect(pc.fields).toMatchObject({ sub_resource_type: 'workstation' });
  });

  it('imports every value the RMM sends, adding a field for each one the layout lacks', async () => {
    asio.state.devices.set('c1', [
      {
        endpointId: 'e1',
        siteId: 's1',
        friendlyName: 'HDG-DC-01',
        hostName: 'hdg-dc-01',
        agentVersion: '2.5.9.0',
        lastSeen: '2026-09-26T10:00:00Z',
        tags: ['server', 'domain controller'],
        os: { name: 'Windows Server 2022', build: '20348' },
      },
    ]);
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);

    const [asset] = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { id: string }[];
    const dc = (await owner.call('GET', `/api/assets/${asset!.id}`)).data;
    // Named fields as before, and everything else in fields of its own.
    expect(dc.fields).toMatchObject({
      hostname: 'hdg-dc-01',
      operating_system: 'Windows Server 2022',
      agent_version: '2.5.9.0',
      last_seen: '2026-09-26T10:00:00Z',
      tags: 'server, domain controller',
      os_build: '20348',
      endpoint_id: 'e1',
    });
    const layout = (await owner.call('GET', '/api/layouts')).data.find(
      (l: { key: string }) => l.key === 'configuration',
    );
    expect(layout.fields.map((f: { label: string }) => f.label)).toEqual(
      expect.arrayContaining(['Agent version', 'Last seen', 'Tags', 'OS build', 'Endpoint ID']),
    );
    // Stays settled: a second sync adds no more fields.
    const before = layout.fields.length;
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    const after = (await owner.call('GET', '/api/layouts')).data.find(
      (l: { key: string }) => l.key === 'configuration',
    );
    expect(after.fields.length).toBe(before);
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
      /Tried v2 by company: resources must not be empty; v2 by client: resources must not be empty; v2 by partner: resources must not be empty; v1 list: resources must not be empty/,
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

describe('ConnectWise RMM category responses', () => {
  it('reads devices from every category, including ones nested inside a record', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    let body: unknown = {
      platform: [
        { endpointID: 'p1', friendlyName: 'HDG-DC-01' },
        { siteName: 'Main office', endpoints: [{ endpointId: 'p2', friendlyName: 'HDG-WS-02' }] },
      ],
      network: [{ resourceId: 'n1', friendlyName: 'HDG-FW-01' }],
    };
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      return Response.json(body);
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    expect((await client.devices('c1')).map((d) => d.name).sort()).toEqual(['HDG-DC-01', 'HDG-FW-01', 'HDG-WS-02']);
    body = { platform: [{ mystery: 'x', details: { a: 1 } }] };
    expect(await client.devices('c1')).toEqual([]);
    expect(client.lastDeviceList).toContain('a record without one has fields mystery, details{a}');
  });
});

describe('ConnectWise RMM device details', () => {
  it("fills a device's fields from its own endpoint, and notes field names only", async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.pathname === '/api/platform/v2/device/companies/c1/sites/s1/endpoints/e1')
        return Response.json({
          endpointId: 'e1',
          system: { hostname: 'ahmdhackdt010', manufacturer: 'Dell Inc.', model: 'OptiPlex 7090' },
          os: { name: 'Windows 11 Pro' },
          networkInterfaces: [{ ipAddress: '10.1.2.3', macAddress: 'AA:BB:CC:DD:EE:FF' }],
          bios: { serialNumber: 'ABC1234' },
        });
      return Response.json({ platform: [{ endpointId: 'e1', siteId: 's1', friendlyName: 'AHMDHACKDT010' }] });
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    const [device] = await client.devices('c1', ['s1']);
    expect(device).toMatchObject({
      name: 'AHMDHACKDT010',
      hostname: 'ahmdhackdt010',
      os: 'Windows 11 Pro',
      ip: '10.1.2.3',
      mac: 'AA:BB:CC:DD:EE:FF',
      // The firmware's "Dell Inc." is tidied to the name Atlas shows.
      manufacturer: 'Dell',
      model: 'OptiPlex 7090',
      serial: 'ABC1234',
    });
    expect(client.lastDeviceFields).toContain('summary fields endpointId, siteId, friendlyName');
    expect(client.lastDeviceFields).toContain('system{hostname,manufacturer,model}');
    expect(client.lastDeviceFields).not.toContain('ahmdhackdt010');
  });
});

describe('ConnectWise RMM real response shapes', () => {
  it('maps the fields a real tenant returns, finding each device in the right site', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    const calls: string[] = [];
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      // Shapes as reported by a real tenant (field names only; values made up).
      if (url.pathname === '/api/platform/v2/device/companies/c1/sites/s2/endpoints/e1')
        return Response.json({
          companyID: 'c1',
          siteID: 's2',
          endpointID: 'e1',
          platform: {
            deviceName: 'AHMDHACKDT010',
            friendlyName: 'Front desk PC',
            resourceType: 'desktop',
            endpointType: 'Desktop',
            ipAddress: '10.1.2.3',
            macAddress: 'AA:BB:CC:DD:EE:FF',
            type: 'Windows',
            subResourceType: 'workstation',
          },
        });
      if (url.pathname.includes('/endpoints/'))
        return Response.json({ message: 'resource not found' }, { status: 404 });
      return Response.json({
        platform: [
          {
            endpointID: 'e1',
            deviceName: 'AHMDHACKDT010',
            friendlyName: 'Front desk PC',
            resourceType: 'desktop',
            endpointType: 'Desktop',
          },
        ],
      });
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    const [device] = await client.devices('c1', ['s1', 's2']);
    expect(device).toMatchObject({
      siteId: 's2',
      name: 'Front desk PC',
      hostname: 'AHMDHACKDT010',
      ip: '10.1.2.3',
      mac: 'AA:BB:CC:DD:EE:FF',
      type: 'Desktop',
    });
    // Tried s1 (not there), then s2.
    expect(calls.filter((c) => c.includes('/endpoints/e1'))).toEqual([
      '/api/platform/v2/device/companies/c1/sites/s1/endpoints/e1',
      '/api/platform/v2/device/companies/c1/sites/s2/endpoints/e1',
    ]);
  });
});

describe('ConnectWise RMM sync with warranty lookup', () => {
  let t: TestApp;
  let owner: Browser;
  let asio: ReturnType<typeof fakeAsio>;
  const dell = (async () =>
    new Response('<div>Expires</div><div>31 May 2029</div>', { status: 200 })) as unknown as typeof fetch;

  beforeEach(async () => {
    asio = fakeAsio();
    t = await startApp({}, { cwRmmFetch: asio.fetcher, warrantyFetch: dell });
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('fills a blank warranty date from the vendor, and keeps one someone typed in', async () => {
    asio.state.devices.set('c1', [
      { endpointId: 'd1', siteId: 's1', friendlyName: 'HDG-WS-01', manufacturer: 'Dell Inc.', serialNumber: 'ABC1234' },
      { endpointId: 'd2', siteId: 's1', friendlyName: 'HDG-WS-02', manufacturer: 'Dell Inc.', serialNumber: 'ABC5678' },
    ]);
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect(job.messages.join(' ')).toContain('Warranty end dates looked up from the vendor for 2 devices');
    type A = { id: string; name: string; version: number; fields: Record<string, string> };
    const list = async () => (await owner.call('GET', `/api/assets?client=${harbor}`)).data as A[];
    const first = await list();
    expect(first.map((a) => a.fields.warranty_expires)).toEqual(['2029-05-31', '2029-05-31']);

    const typed = first.find((a) => a.name === 'HDG-WS-01')!;
    const edited = await owner.call('PATCH', `/api/assets/${typed.id}`, {
      fields: { ...typed.fields, warranty_expires: '2031-01-01' },
      version: typed.version,
    });
    expect(edited.status, JSON.stringify(edited.data)).toBe(200);
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
    expect((await list()).find((a) => a.name === 'HDG-WS-01')!.fields.warranty_expires).toBe('2031-01-01');
  });
});

describe('ConnectWise RMM fields as the platform API spec gives them', () => {
  it('takes the maker from baseboard, protection from antiViruses and services, and check-in from the heartbeat', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    const detail = (id: string, extra: Record<string, unknown>) => ({
      companyID: 'c1',
      siteID: 's1',
      endpointID: id,
      platform: {
        deviceName: `WS-${id}`,
        bios: { manufacturer: 'American Megatrends Inc.' },
        baseboard: { manufacturer: 'Dell Inc.', product: '0XYZ' },
        system: { model: 'OptiPlex 7090', serialNumber: `SN-${id}` },
        ...extra,
      },
    });
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      const m = /\/sites\/s1\/endpoints\/(e\d)$/.exec(url.pathname);
      if (m?.[1] === 'e1') return Response.json(detail('e1', { antiViruses: [{ name: 'Windows Defender' }] }));
      if (m?.[1] === 'e2')
        return Response.json(
          detail('e2', {
            antiViruses: [],
            services: [
              { serviceName: 'SentinelAgent', displayName: 'SentinelOne', antivirus: true, serviceStatus: 'Stopped' },
            ],
          }),
        );
      if (m?.[1] === 'e3') return Response.json(detail('e3', { antiViruses: [] }));
      if (url.pathname.endsWith('/endpoints/heartbeat'))
        return Response.json({
          status: 'success',
          successfulRecords: [
            {
              companyID: 'c1',
              siteID: 's1',
              endpoints: [
                { EndpointID: 'e1', DcDateTimeUTC: '2026-09-29T08:30:00Z', Availability: false },
                { EndpointID: 'e2', DcDateTimeUTC: '2026-09-30T05:00:00Z', Availability: true },
              ],
            },
          ],
          failedRecords: [],
        });
      if (url.pathname.endsWith('/endpoints/systemstate')) return Response.json({ successfulRecords: [] });
      return Response.json({
        platform: ['e1', 'e2', 'e3'].map((id) => ({ endpointID: id, siteID: 's1', deviceName: `WS-${id}` })),
      });
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    const [one, two, three] = await client.devices('c1', ['s1']);
    expect(one).toMatchObject({
      manufacturer: 'Dell',
      model: 'OptiPlex 7090',
      serial: 'SN-e1',
      protection: 'running',
      protectionProduct: 'Windows Defender',
      online: false,
      lastSeenAt: '2026-09-29T08:30:00.000Z',
    });
    // The maker goes in Manufacturer only; the BIOS vendor is kept as its own field.
    const labels = one!.extra.map(([label]) => label.toLowerCase());
    expect(labels.some((l) => l.includes('baseboard') && l.includes('manufacturer'))).toBe(false);
    expect(labels.some((l) => l.includes('bios') && l.includes('manufacturer'))).toBe(true);
    expect(two).toMatchObject({ protection: 'not_running', protectionProduct: 'SentinelOne', online: true });
    expect(two!.lastSeenAt).toBe('2026-09-30T05:00:00.000Z');
    expect(three).toMatchObject({ protection: 'missing', online: null, lastSeenAt: null });
  });
});

describe('ConnectWise RMM loosely named fields', () => {
  it('reads manufacturer, check-in and protection under other names, with the manufacturer in its own field only', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    const now = Date.now();
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.pathname === '/api/platform/v2/device/companies/c1/sites/s1/endpoints/e1')
        return Response.json({
          companyID: 'c1',
          siteID: 's1',
          endpointID: 'e1',
          platform: {
            deviceName: 'WS-01',
            systemManufacturer: 'Dell Inc.',
            bios: { manufacturer: 'American Megatrends Inc.' },
            lastContactedAt: new Date(now - 3_600_000).toISOString(),
          },
        });
      if (url.pathname.endsWith('/endpoints/heartbeat'))
        return Response.json({
          successfulRecords: [
            {
              endpoints: [
                { EndpointID: 'e1', Availability: true },
                { EndpointID: 'e2', Availability: true },
              ],
            },
          ],
        });
      if (url.pathname.endsWith('/endpoints/systemstate'))
        return Response.json({
          successfulRecords: [
            {
              endpoints: [
                { endpointID: 'e1', antivirusStatus: 'Enabled', antivirusName: 'Defender' },
                { endpointID: 'e2', avStatus: 'Not Protected', lastLoggedOnUser: { username: 'x' } },
              ],
            },
          ],
        });
      if (url.pathname.includes('/endpoints/'))
        return Response.json({ message: 'resource not found' }, { status: 404 });
      return Response.json({
        platform: [
          { endpointID: 'e1', siteID: 's1', deviceName: 'WS-01' },
          { endpointID: 'e2', siteID: 's1', deviceName: 'WS-02', manufacturer: 'LENOVO' },
        ],
      });
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    const [one, two] = await client.devices('c1', ['s1']);
    expect(one).toMatchObject({
      manufacturer: 'Dell',
      protection: 'running',
      protectionProduct: 'Defender',
      online: true,
    });
    expect(Date.parse(one!.lastSeenAt!)).toBe(now - 3_600_000);
    expect(one!.extra.map(([label]) => label.toLowerCase()).join('|')).not.toMatch(/system manufacturer/);
    // No check-in time given, but the heartbeat says it's up now.
    expect(two).toMatchObject({ manufacturer: 'Lenovo', protection: 'not_running', online: true });
    expect(Date.parse(two!.lastSeenAt!)).toBeGreaterThanOrEqual(now - 1000);
  });
});

describe('ConnectWise RMM device list paging and sites', () => {
  it('follows the Link header to the next page and looks each device up in its own site', async () => {
    const { CwRmmClient } = await import('../src/services/integrations/cw-rmm.js');
    const calls: string[] = [];
    const fetcher = (async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}?${url.searchParams.get('cursor') ?? ''}`);
      if (url.pathname === '/v1/token') return Response.json({ access_token: 'tok', expires_in: 3600 });
      if (url.pathname === '/api/platform/v2/device/categories/all/endpoints') {
        const cursor = url.searchParams.get('cursor');
        if (cursor === '0')
          return Response.json(
            { platform: [{ companyID: 'c1', siteID: 's2', endpoints: [{ endpointID: 'e1', deviceName: 'A' }] }] },
            { headers: { Link: `<${url.origin}${url.pathname}?limit=500&cursor=7>; rel="next"` } },
          );
        if (cursor === '7')
          return Response.json({
            platform: [{ companyID: 'c1', siteID: 's3', endpoints: [{ endpointID: 'e2', deviceName: 'B' }] }],
          });
        return Response.json({ message: 'unexpected cursor' }, { status: 400 });
      }
      const m = /\/sites\/(s\d)\/endpoints\/(e\d)$/.exec(url.pathname);
      if (m) return Response.json({ endpointID: m[2], siteID: m[1], platform: { deviceName: m[2] } });
      return Response.json({ successfulRecords: [] });
    }) as typeof fetch;
    const client = new CwRmmClient('na', 'id', 'secret', fetcher);
    const devices = await client.devices('c1', ['s1', 's2', 's3']);
    expect(devices.map((d) => [d.id, d.siteId])).toEqual([
      ['e1', 's2'],
      ['e2', 's3'],
    ]);
    // Straight to each device's own site; no probing the others.
    expect(calls.filter((c) => c.includes('/sites/'))).toEqual([
      '/api/platform/v2/device/companies/c1/sites/s2/endpoints/e1?',
      '/api/platform/v2/device/companies/c1/sites/s3/endpoints/e2?',
    ]);
  });
});
