import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { deviceKind, onlineState, protectionOf, seenAt } from '../src/services/integrations/cw-rmm.js';
import { thresholds } from '../src/services/rmm-health.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const CLIENT_ID = 'asio-client-id-123';
const SECRET = 'asio-secret-value-456';
const TEMP = 'temporary pass 1234';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

type Device = Record<string, unknown>;

/** A fake Asio API with two companies whose devices report agent and protection status. */
/** `failing` companies answer every request with a server error. */
function fakeAsio(devices: Map<string, Device[]>, failing = new Set<string>()) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/token') return json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
    if (url.pathname === '/api/platform/v1/company/companies')
      return json([
        { id: 'c1', name: 'Harbor Dental Group' },
        { id: 'c2', name: 'Northline Architecture' },
      ]);
    const sites = url.pathname.match(/companies\/(\w+)\/sites$/);
    if (sites) return failing.has(sites[1]!) ? json({ message: 'unavailable' }, 500) : json([]);
    if (url.pathname === '/api/platform/v2/device/categories/all/endpoints') {
      const request = JSON.parse(String(init?.body));
      if (request.resourceType !== 'company') return json({ message: 'invalid resource type' }, 400);
      const all = devices.get(request.resources[0] as string) ?? [];
      if (!all.length) return json({ message: 'resource not found' }, 404);
      const cursor = Number(url.searchParams.get('cursor'));
      return json({ endpoints: all.slice(cursor, cursor + Number(url.searchParams.get('limit'))) });
    }
    return json({}, 404);
  }) as typeof fetch;
}

async function waitForJob(b: Browser, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

describe('RMM health values', () => {
  it('reads online state and leaves anything else unknown', () => {
    expect(onlineState(true)).toBe(true);
    expect(onlineState('Online')).toBe(true);
    expect(onlineState('OFFLINE')).toBe(false);
    expect(onlineState(0)).toBe(false);
    expect(onlineState('Active')).toBeNull();
    expect(onlineState(undefined)).toBeNull();
  });

  it('reads check-in times from ISO strings and Unix times, and refuses placeholders', () => {
    const now = Date.UTC(2026, 8, 29);
    expect(seenAt('2026-09-28T10:00:00Z', now)).toBe('2026-09-28T10:00:00.000Z');
    expect(seenAt(Date.UTC(2026, 8, 1) / 1000, now)).toBe('2026-09-01T00:00:00.000Z');
    expect(seenAt(String(Date.UTC(2026, 8, 1)), now)).toBe('2026-09-01T00:00:00.000Z');
    expect(seenAt('0001-01-01T00:00:00Z', now)).toBeNull();
    expect(seenAt('2027-01-01', now)).toBeNull();
    expect(seenAt('never', now)).toBeNull();
  });

  it('reads endpoint protection as running, not running, or missing', () => {
    expect(protectionOf({ endpointProtection: { name: 'SentinelOne', status: 'Running' } })).toEqual({
      protection: 'running',
      protectionProduct: 'SentinelOne',
    });
    expect(protectionOf({ antivirus: { name: 'Defender', running: false } }).protection).toBe('not_running');
    expect(protectionOf({ antivirusStatus: 'Out of date' }).protection).toBe('not_running');
    expect(protectionOf({ isAntivirusInstalled: false }).protection).toBe('missing');
    expect(protectionOf({ endpointProtection: 'Not installed' }).protection).toBe('missing');
    // Installed says nothing about whether it runs.
    expect(protectionOf({ antivirus: { name: 'Defender', status: 'Installed' } }).protection).toBeNull();
    expect(protectionOf({}).protection).toBeNull();
  });

  it('groups devices into servers, workstations, and others', () => {
    expect(deviceKind({ type: 'Server', os: '' })).toBe('server');
    expect(deviceKind({ type: '', os: 'Windows Server 2022' })).toBe('server');
    expect(deviceKind({ type: 'Laptop', os: '' })).toBe('workstation');
    expect(deviceKind({ type: 'Desktop', os: 'Windows 11 Pro' })).toBe('workstation');
    expect(deviceKind({ type: 'Firewall', os: '' })).toBe('other');
  });

  it('keeps stale thresholds in range', () => {
    expect(thresholds()).toEqual({ staleDays: 7, veryStaleDays: 30 });
    expect(thresholds('3', '10')).toEqual({ staleDays: 3, veryStaleDays: 10 });
    expect(thresholds('0', '-5')).toEqual({ staleDays: 7, veryStaleDays: 30 });
    expect(thresholds('20', '5')).toEqual({ staleDays: 20, veryStaleDays: 21 });
    // An organization's own thresholds fill in what the request leaves out.
    expect(thresholds(undefined, undefined, { staleDays: 3, veryStaleDays: 14 })).toEqual({
      staleDays: 3,
      veryStaleDays: 14,
    });
  });
});

describe('RMM health report', () => {
  let t: TestApp;
  let owner: Browser;
  let devices: Map<string, Device[]>;
  let failing: Set<string>;
  let harbor: string;
  let northline: string;

  beforeEach(async () => {
    devices = new Map<string, Device[]>([
      [
        'c1',
        [
          {
            endpointId: 'h1',
            friendlyName: 'HDG-DC-01',
            endpointType: 'Server',
            availabilityStatus: 'Online',
            lastSeen: ago(0),
            endpointProtection: { name: 'SentinelOne', status: 'Running' },
            warrantyExpirationDate: '2027-03-31T00:00:00Z',
          },
          {
            endpointId: 'h2',
            friendlyName: 'HDG-FS-01',
            endpointType: 'Server',
            availabilityStatus: 'Offline',
            lastSeen: ago(10),
            endpointProtection: { name: 'SentinelOne', status: 'Stopped' },
          },
          {
            endpointId: 'h3',
            friendlyName: 'HDG-WS-01',
            endpointType: 'Desktop',
            isOnline: false,
            lastSeen: ago(45),
            isAntivirusInstalled: false,
          },
          { endpointId: 'h4', friendlyName: 'HDG-WS-02', endpointType: 'Laptop' },
        ],
      ],
      [
        'c2',
        [
          {
            endpointId: 'n1',
            friendlyName: 'NLA-WS-01',
            endpointType: 'Desktop',
            isOnline: true,
            lastSeen: ago(1),
            antivirus: { name: 'Defender', running: true },
          },
        ],
      ],
    ]);
    failing = new Set();
    t = await startApp({}, { cwRmmFetch: fakeAsio(devices, failing) });
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [
        { companyId: 'c1', action: 'link', clientId: harbor },
        { companyId: 'c2', action: 'link', clientId: northline },
      ],
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const sync = async () => waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);

  it('is empty before a sync', async () => {
    const report = (await owner.call('GET', '/api/rmm-health')).data;
    expect(report).toMatchObject({ updatedAt: null, clients: [], totals: { total: 0 } });
  });

  it('counts agent online, stale agents, and endpoint protection across clients, worst first', async () => {
    expect((await sync()).status).toBe('done');
    const report = (await owner.call('GET', '/api/rmm-health')).data;
    expect(report.staleDays).toBe(7);
    expect(report.updatedAt).not.toBeNull();
    expect(report.totals).toEqual({
      total: 5,
      servers: 2,
      workstations: 3,
      online: 2,
      offline: 2,
      onlineUnknown: 1,
      offlineServers: 1,
      current: 2,
      stale: 1,
      veryStale: 1,
      seenUnknown: 1,
      protectionRunning: 2,
      protectionNotRunning: 1,
      protectionMissing: 1,
      protectionUnknown: 1,
    });
    expect(report.clients.map((c: { clientName: string }) => c.clientName)).toEqual([
      'Harbor Dental Group',
      'Northline Architecture',
    ]);

    // Thresholds move devices between current, stale, and very stale.
    const strict = (await owner.call('GET', '/api/rmm-health?staleDays=1&veryStaleDays=5')).data;
    expect(strict.totals).toMatchObject({ current: 1, stale: 1, veryStale: 2 });

    const one = (await owner.call('GET', `/api/rmm-health?client=${northline}`)).data;
    expect(one.totals).toMatchObject({ total: 1, online: 1, protectionRunning: 1 });
  });

  it('fills the warranty date the RMM reports, for the warranty chart', async () => {
    await sync();
    const assets = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as {
      name: string;
      fields: Record<string, string>;
    }[];
    expect(assets.find((a) => a.name === 'HDG-DC-01')!.fields.warranty_expires).toBe('2027-03-31');
    expect(assets.find((a) => a.name === 'HDG-FS-01')!.fields.warranty_expires).toBeUndefined();
    expect((await owner.call('GET', `/api/warranty?client=${harbor}`)).data.totals).toMatchObject({
      total: 4,
      unknown: 3,
    });
  });

  it("keeps a client's health when one of its companies could not be read", async () => {
    // Both companies feed Harbor.
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c2', action: 'link', clientId: harbor }],
    });
    await sync();
    expect((await owner.call('GET', `/api/rmm-health?client=${harbor}`)).data.totals.total).toBe(5);
    const snapshots = async () =>
      (await t.handle.db.execute(sql`select counts from rmm_health_snapshots`)).rows.map(
        (r) => (r.counts as { total: number }).total,
      );
    expect(await snapshots()).toEqual([5]);
    // Next time c2 fails and c1 drops a device: nothing of Harbor's is removed, and today's point stays.
    failing.add('c2');
    devices.set('c1', devices.get('c1')!.slice(0, 3));
    expect((await sync()).status).toBe('done');
    expect((await owner.call('GET', `/api/rmm-health?client=${harbor}`)).data.totals.total).toBe(5);
    expect(await snapshots()).toEqual([5]);
    // Once both are read again, the dropped device goes.
    failing.clear();
    await sync();
    expect((await owner.call('GET', `/api/rmm-health?client=${harbor}`)).data.totals.total).toBe(4);
  });

  it('lists the devices behind a slice, most overdue first', async () => {
    await sync();
    const offline = (await owner.call('GET', '/api/rmm-health/devices?filter=offline')).data;
    expect(offline.map((d: { name: string }) => d.name)).toEqual(['HDG-WS-01', 'HDG-FS-01']);
    expect(offline[1]).toMatchObject({
      kind: 'server',
      online: false,
      protection: 'not_running',
      protectionProduct: 'SentinelOne',
    });
    const missing = (await owner.call('GET', `/api/rmm-health/devices?filter=protection_missing&client=${harbor}`))
      .data;
    expect(missing).toHaveLength(1);
    expect((await owner.call('GET', '/api/rmm-health/devices?filter=everything')).status).toBe(400);
  });

  it('drops devices the RMM no longer reports, and archived assets', async () => {
    await sync();
    devices.set('c1', devices.get('c1')!.slice(0, 3));
    await sync();
    expect((await owner.call('GET', '/api/rmm-health')).data.totals.total).toBe(4);
    const [dc] = (await owner.call('GET', '/api/rmm-health/devices?filter=protection_not_running')).data;
    expect((await owner.call('POST', `/api/assets/${dc.assetId}/archive`, { archived: true })).status).toBeLessThan(
      300,
    );
    const after = (await owner.call('GET', '/api/rmm-health')).data.totals;
    expect(after).toMatchObject({ total: 3, protectionNotRunning: 0 });
  });

  it('shows only clients the viewer can read, and hides others as not found', async () => {
    await sync();
    const created = await owner.call('POST', '/api/users', {
      email: 'viewer@northline.test',
      name: 'Northline Viewer',
      role: 'client_viewer',
      password: TEMP,
      grants: [{ clientId: northline, level: 'read' }],
    });
    expect(created.status).toBe(201);
    const { b } = await signIn(t.app, 'viewer@northline.test', TEMP);
    const changed = await b.call('POST', '/api/account/password', { current: TEMP, next: 'harbor lights read only 7' });
    expect(changed.data.stage, JSON.stringify(changed.data)).toBe('active');
    const report = (await b.call('GET', '/api/rmm-health')).data;
    expect(report.totals.total).toBe(1);
    expect(report.clients.map((c: { clientId: string }) => c.clientId)).toEqual([northline]);
    expect((await b.call('GET', `/api/rmm-health?client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/rmm-health?client=not-a-uuid')).status).toBe(404);
    expect((await b.call('GET', `/api/rmm-health/devices?filter=offline&client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/rmm-health/devices?filter=offline')).data).toEqual([]);
    const trend = (await b.call('GET', '/api/rmm-health/trend')).data;
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ total: 1, online: 1 });
    expect((await b.call('GET', `/api/rmm-health/trend?client=${harbor}`)).status).toBe(404);
    expect((await b.call('PUT', '/api/settings/rmm-health', { staleDays: 2, veryStaleDays: 3 })).status).toBe(403);
  });

  it("uses the organization's stale thresholds, which only an administrator changes", async () => {
    await sync();
    expect((await owner.call('GET', '/api/settings/rmm-health')).data).toEqual({ staleDays: 7, veryStaleDays: 30 });
    const bad = await owner.call('PUT', '/api/settings/rmm-health', { staleDays: 10, veryStaleDays: 10 });
    expect(bad.status).toBe(400);
    const saved = await owner.call('PUT', '/api/settings/rmm-health', { staleDays: 1, veryStaleDays: 5 });
    expect(saved.data).toEqual({ staleDays: 1, veryStaleDays: 5 });
    const report = (await owner.call('GET', '/api/rmm-health')).data;
    expect(report).toMatchObject({ staleDays: 1, veryStaleDays: 5 });
    expect(report.totals).toMatchObject({ current: 1, stale: 1, veryStale: 2 });
    // A request can still ask for its own.
    expect((await owner.call('GET', '/api/rmm-health?staleDays=7&veryStaleDays=30')).data.totals.current).toBe(2);
    const events = await t.handle.db.execute(sql`select action from security_events`);
    expect(events.rows.map((r) => r.action)).toContain('RMM health settings changed');
  });

  it('records a daily snapshot after each sync for the trend lines', async () => {
    expect((await owner.call('GET', '/api/rmm-health/trend')).data).toEqual([]);
    await sync();
    const today = new Date().toISOString().slice(0, 10);
    expect((await owner.call('GET', '/api/rmm-health/trend')).data).toEqual([
      { day: today, total: 5, online: 2, current: 2, protectionRunning: 2 },
    ]);
    // The day's last sync wins: one row per client per day.
    devices.set('c2', []);
    await sync();
    const rows = await t.handle.db.execute(sql`select count(*)::int as n from rmm_health_snapshots`);
    expect(rows.rows[0]!.n).toBe(2);
    expect((await owner.call('GET', `/api/rmm-health/trend?client=${northline}`)).data).toEqual([
      { day: today, total: 0, online: 0, current: 0, protectionRunning: 0 },
    ]);
    // Older days show within the window, oldest first.
    const past = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
    await t.handle.db.execute(
      sql`insert into rmm_health_snapshots (org_id, client_id, day, counts)
          select org_id, id, ${past}, '{"total":4,"online":4,"current":4,"protectionRunning":3}'::jsonb
          from clients where id = ${harbor}`,
    );
    const trend = (await owner.call('GET', `/api/rmm-health/trend?client=${harbor}`)).data;
    expect(trend.map((p: { day: string }) => p.day)).toEqual([past, today]);
    expect(trend[0]).toMatchObject({ total: 4, online: 4 });
    expect((await owner.call('GET', `/api/rmm-health/trend?client=${harbor}&days=2`)).data).toHaveLength(1);
  });
});
