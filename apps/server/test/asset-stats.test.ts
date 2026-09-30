import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { kindOf, layoutRules, osField, osFamily, typeField } from '../src/services/asset-stats.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('asset statistics values', () => {
  it('places operating systems in families', () => {
    expect(osFamily('Microsoft Windows 11 Pro')).toBe('windows-11');
    expect(osFamily('Windows 10 Enterprise 22H2')).toBe('windows-10');
    expect(osFamily('Windows 7 Professional')).toBe('windows-old');
    expect(osFamily('Microsoft Windows Server 2022 Standard')).toBe('server-2022');
    expect(osFamily('Windows Server 2019 Datacenter')).toBe('server-2019');
    expect(osFamily('Windows Server 2012 R2 Standard')).toBe('server-old');
    expect(osFamily('Windows Small Business Server 2011')).toBe('server-old');
    expect(osFamily('macOS Sonoma 14.5')).toBe('macos');
    expect(osFamily('Ubuntu Server 22.04 LTS')).toBe('linux');
    expect(osFamily('FortiOS 7.2')).toBe('other');
    expect(osFamily('  ')).toBe('unknown');
  });

  it('reads the kind of device from its type, then its operating system', () => {
    expect(kindOf('Server')).toBe('server');
    expect(kindOf('Hypervisor')).toBe('server');
    expect(kindOf('Laptop')).toBe('workstation');
    expect(kindOf('Virtual machine', 'Windows Server 2022')).toBe('server');
    expect(kindOf('Virtual machine', 'Windows 11 Pro')).toBe('workstation');
    expect(kindOf('Switch')).toBe('switch');
    expect(kindOf('Firewall')).toBe('network');
    expect(kindOf('Access point')).toBe('network');
    expect(kindOf('Phone')).toBe('phone');
    expect(kindOf('Printers')).toBe('printer');
    expect(kindOf('Other', 'Windows Server 2016')).toBe('server');
    expect(kindOf('', 'Windows 10 Pro')).toBe('workstation');
    expect(kindOf('Other')).toBe('other');
  });

  it("decides how each layout counts, with an administrator's choice first", () => {
    const f = (key: string, label: string, type = 'text') =>
      ({ key, label, type, required: false, options: [], help: '', showInList: false, expires: false }) as never;
    expect(typeField([f('kind', 'Device Type', 'select')])).toBe('kind');
    expect(osField([f('bios', 'BIOS Version'), f('osv', 'OS version')])).toBe('osv');
    expect(osField([f('bios', 'BIOS Version')])).toBeNull();
    const layouts = [
      { id: 'a', key: 'configuration', name: 'Configurations', fields: [f('type', 'Type', 'select')] },
      { id: 'b', key: 'printer', name: 'Printers', fields: [f('model', 'Model')] },
      { id: 'c', key: 'network', name: 'Networks', fields: [f('subnet', 'Subnet')] },
      { id: 'd', key: 'domain', name: 'Domains', fields: [] },
      { id: 'e', key: 'computers', name: 'Machines', fields: [f('os', 'OS')] },
    ];
    expect(layoutRules(layouts, { layouts: {} })).toEqual([
      { id: 'a', kind: null, typeKey: 'type', osKey: null },
      { id: 'b', kind: 'printer', typeKey: null, osKey: null },
      { id: 'e', kind: null, typeKey: null, osKey: 'os' },
    ]);
    expect(layoutRules(layouts, { layouts: { a: 'none', d: 'phone' } }).map((r) => [r.id, r.kind])).toEqual([
      ['b', 'printer'],
      ['d', 'phone'],
      ['e', null],
    ]);
  });
});

describe('asset statistics report', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let northline: string;
  let configuration: string;
  let printers: string;

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
    printers = layouts.find((l) => l.key === 'printer')!.id;
    await asset(harbor, configuration, 'HDG-DC-01', { type: 'Server', operating_system: 'Windows Server 2012 R2' });
    await asset(harbor, configuration, 'HDG-FS-01', { type: 'Server', operating_system: 'Windows Server 2022' });
    await asset(harbor, configuration, 'HDG-WS-01', { type: 'Workstation', operating_system: 'Windows 11 Pro' });
    await asset(harbor, configuration, 'HDG-WS-02', { type: 'Laptop', operating_system: 'Windows 10 Pro' });
    await asset(harbor, configuration, 'HDG-SW-01', { type: 'Switch' });
    await asset(harbor, printers, 'Front desk MFP');
    await asset(northline, configuration, 'NLA-MAC-01', { type: 'Workstation', operating_system: 'macOS 14' });
    // Not a device: a domain isn't counted.
    const domain = layouts.find((l) => l.key === 'domain')!.id;
    await asset(northline, domain, 'northline.example');
  });
  afterEach(async () => {
    await t.close();
  });

  it('counts devices by kind and operating system across clients', async () => {
    const report = (await owner.call('GET', '/api/asset-stats')).data;
    expect(report.totals).toEqual({
      total: 7,
      server: 2,
      workstation: 3,
      switch: 1,
      network: 0,
      printer: 1,
      phone: 0,
      other: 0,
    });
    expect(report.os).toMatchObject({
      'windows-11': 1,
      'windows-10': 1,
      'server-2022': 1,
      'server-old': 1,
      macos: 1,
      unknown: 2,
    });
    expect(report.clients).toEqual([
      expect.objectContaining({ clientName: 'Harbor Dental Group', endOfSupport: 2 }),
      expect.objectContaining({ clientName: 'Northline Architecture', endOfSupport: 0 }),
    ]);
    expect((await owner.call('GET', `/api/asset-stats?client=${northline}`)).data.totals).toMatchObject({
      total: 1,
      workstation: 1,
    });
  });

  it('lists the devices behind a tile or slice, and leaves archived assets out', async () => {
    const servers = (await owner.call('GET', '/api/asset-stats/assets?filter=kind:server')).data;
    expect(servers.map((a: { name: string }) => a.name)).toEqual(['HDG-DC-01', 'HDG-FS-01']);
    expect(servers[0]).toMatchObject({
      os: 'server-old',
      osName: 'Windows Server 2012 R2',
      layoutName: 'Configurations',
    });
    const eos = (await owner.call('GET', '/api/asset-stats/assets?filter=eos')).data;
    expect(eos.map((a: { name: string }) => a.name)).toEqual(['HDG-DC-01', 'HDG-WS-02']);
    const mac = (await owner.call('GET', `/api/asset-stats/assets?filter=os:macos&client=${harbor}`)).data;
    expect(mac).toEqual([]);
    expect((await owner.call('GET', '/api/asset-stats/assets?filter=kind:toaster')).status).toBe(400);
    expect((await owner.call('GET', '/api/asset-stats/assets')).status).toBe(400);

    expect((await owner.call('POST', `/api/assets/${servers[0].assetId}/archive`, { archived: true })).status).toBe(
      200,
    );
    expect((await owner.call('GET', '/api/asset-stats')).data.totals).toMatchObject({ total: 6, server: 1 });
  });

  it("uses the organization's layout choices, which only an administrator changes", async () => {
    expect((await owner.call('GET', '/api/settings/asset-stats')).data).toEqual({ layouts: {} });
    expect((await owner.call('PUT', '/api/settings/asset-stats', { layouts: { [printers]: 'toaster' } })).status).toBe(
      400,
    );
    const saved = await owner.call('PUT', '/api/settings/asset-stats', {
      layouts: { [printers]: 'phone', [configuration]: 'auto' },
    });
    expect(saved.data).toEqual({ layouts: { [printers]: 'phone' } });
    expect((await owner.call('GET', '/api/asset-stats')).data.totals).toMatchObject({ printer: 0, phone: 1 });
    await owner.call('PUT', '/api/settings/asset-stats', { layouts: { [configuration]: 'none' } });
    expect((await owner.call('GET', '/api/asset-stats')).data.totals).toMatchObject({ total: 1, printer: 1 });
    const events = await t.handle.db.execute(sql`select action from security_events`);
    expect(events.rows.map((r) => r.action)).toContain('Asset statistics settings changed');
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
    const report = (await b.call('GET', '/api/asset-stats')).data;
    expect(report.totals.total).toBe(1);
    expect(report.clients.map((c: { clientId: string }) => c.clientId)).toEqual([northline]);
    expect((await b.call('GET', `/api/asset-stats?client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/asset-stats?client=nope')).status).toBe(404);
    expect((await b.call('GET', `/api/asset-stats/assets?filter=kind:server&client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/asset-stats/assets?filter=kind:server')).data).toEqual([]);
    expect((await b.call('PUT', '/api/settings/asset-stats', { layouts: {} })).status).toBe(403);
  });
});
