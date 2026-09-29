import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { warrantyDate } from '../src/services/integrations/cw-rmm.js';
import { soonDaysOf, standing, warrantyFields } from '../src/services/warranty.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('warranty values', () => {
  it('finds warranty date fields, the one about when it ends first', () => {
    const f = (key: string, label: string, type = 'date') =>
      ({ key, label, type, required: false, options: [], help: '', showInList: false, expires: false }) as never;
    expect(warrantyFields([f('warranty_expires', 'Warranty expires')])).toEqual(['warranty_expires']);
    expect(
      warrantyFields([f('w1', 'Warranty start'), f('w2', 'Warranty End Date'), f('notes', 'Warranty', 'text')]),
    ).toEqual(['w2', 'w1']);
    expect(warrantyFields([f('purchase_date', 'Purchase date')])).toEqual([]);
  });

  it('places a date as expired, soon, active, or unknown', () => {
    const today = '2026-09-29';
    expect(standing('2026-09-28', 90, today)).toBe('expired');
    expect(standing('2026-09-29', 90, today)).toBe('soon');
    expect(standing('2026-12-28', 90, today)).toBe('soon');
    expect(standing('2026-12-29', 90, today)).toBe('active');
    expect(standing(null, 90, today)).toBe('unknown');
    expect(standing('next year', 90, today)).toBe('unknown');
  });

  it('keeps the soon window in range', () => {
    expect(soonDaysOf(undefined, 90)).toBe(90);
    expect(soonDaysOf('30', 90)).toBe(30);
    expect(soonDaysOf('-4', 60)).toBe(60);
    expect(soonDaysOf('9999', 90)).toBe(365);
  });

  it('reads warranty dates from the RMM, and refuses implausible ones', () => {
    expect(warrantyDate('2027-03-31T00:00:00Z')).toBe('2027-03-31');
    expect(warrantyDate('2027-03-31')).toBe('2027-03-31');
    expect(warrantyDate(Date.UTC(2028, 0, 15) / 1000)).toBe('2028-01-15');
    expect(warrantyDate('0001-01-01T00:00:00Z')).toBe('');
    expect(warrantyDate('unknown')).toBe('');
    expect(warrantyDate(undefined)).toBe('');
  });
});

describe('asset warranty report', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let northline: string;
  let configuration: string;

  const asset = async (clientId: string, layoutId: string, name: string, fields: Record<string, string> = {}) => {
    const r = await owner.call('POST', `/api/clients/${clientId}/assets`, { layoutId, name, fields });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data.id as string;
  };

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    configuration = layouts.find((l) => l.key === 'configuration')!.id;
    // Like a Hudu import: its own layout, with the warranty date under another name.
    const computers = (
      await owner.call('POST', '/api/layouts', {
        name: 'Computer Assets',
        icon: 'box',
        fields: [
          { key: 'bought', label: 'Purchased', type: 'date' },
          { key: 'warranty_end', label: 'Warranty End Date', type: 'date' },
        ],
      })
    ).data.id;
    await asset(harbor, configuration, 'HDG-DC-01', { warranty_expires: inDays(-10) });
    await asset(harbor, configuration, 'HDG-FS-01', { warranty_expires: inDays(30) });
    await asset(harbor, configuration, 'HDG-WS-01');
    await asset(harbor, computers, 'HDG-WS-02', { bought: inDays(-400), warranty_end: inDays(200) });
    await asset(northline, configuration, 'NLA-WS-01', { warranty_expires: inDays(400) });
    // No warranty field in its layout: not hardware, not counted.
    const domain = layouts.find((l) => l.key === 'domain')!.id;
    await asset(northline, domain, 'northline.example', { expires: inDays(-5) });
  });
  afterEach(async () => {
    await t.close();
  });

  it('counts expired, soon, active, and unknown warranties across clients', async () => {
    const report = (await owner.call('GET', '/api/warranty')).data;
    expect(report.soonDays).toBe(90);
    expect(report.totals).toEqual({ total: 5, expired: 1, soon: 1, active: 2, unknown: 1 });
    expect(report.clients.map((c: { clientName: string }) => c.clientName)).toEqual([
      'Harbor Dental Group',
      'Northline Architecture',
    ]);
    expect((await owner.call('GET', `/api/warranty?client=${northline}`)).data.totals).toEqual({
      total: 1,
      expired: 0,
      soon: 0,
      active: 1,
      unknown: 0,
    });
    // A wider window moves the 200-day warranty into soon.
    expect((await owner.call('GET', '/api/warranty?soonDays=365')).data.totals).toMatchObject({ soon: 2, active: 1 });
  });

  it('lists the assets behind a slice, and leaves archived assets out', async () => {
    const unknown = (await owner.call('GET', '/api/warranty/assets?filter=unknown')).data;
    expect(unknown).toEqual([
      expect.objectContaining({
        name: 'HDG-WS-01',
        warrantyExpires: null,
        daysLeft: null,
        layoutName: 'Configurations',
      }),
    ]);
    const expired = (await owner.call('GET', '/api/warranty/assets?filter=expired')).data;
    expect(expired[0]).toMatchObject({ name: 'HDG-DC-01', warrantyExpires: inDays(-10), daysLeft: -10 });
    const active = (await owner.call('GET', `/api/warranty/assets?filter=active&client=${harbor}`)).data;
    expect(active.map((a: { name: string }) => a.name)).toEqual(['HDG-WS-02']);
    expect((await owner.call('GET', '/api/warranty/assets?filter=all')).status).toBe(400);

    expect((await owner.call('POST', `/api/assets/${expired[0].assetId}/archive`, { archived: true })).status).toBe(
      200,
    );
    expect((await owner.call('GET', '/api/warranty')).data.totals).toMatchObject({ total: 4, expired: 0 });
  });

  it("uses the organization's soon window, which only an administrator changes", async () => {
    expect((await owner.call('GET', '/api/settings/warranty')).data).toEqual({ soonDays: 90 });
    expect((await owner.call('PUT', '/api/settings/warranty', { soonDays: 0 })).status).toBe(400);
    expect((await owner.call('PUT', '/api/settings/warranty', { soonDays: 365 })).data).toEqual({ soonDays: 365 });
    const report = (await owner.call('GET', '/api/warranty')).data;
    expect(report.soonDays).toBe(365);
    expect(report.totals).toMatchObject({ soon: 2, active: 1 });
    const events = await t.handle.db.execute(sql`select action from security_events`);
    expect(events.rows.map((r) => r.action)).toContain('Warranty settings changed');
  });

  it('shows only clients the viewer can read, and hides others as not found', async () => {
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
    expect(changed.data.stage).toBe('active');
    const report = (await b.call('GET', '/api/warranty')).data;
    expect(report.totals.total).toBe(1);
    expect(report.clients.map((c: { clientId: string }) => c.clientId)).toEqual([northline]);
    expect((await b.call('GET', `/api/warranty?client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/warranty?client=nope')).status).toBe(404);
    expect((await b.call('GET', `/api/warranty/assets?filter=unknown&client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/warranty/assets?filter=unknown')).data).toEqual([]);
    expect((await b.call('PUT', '/api/settings/warranty', { soonDays: 30 })).status).toBe(403);
  });
});
