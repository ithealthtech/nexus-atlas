import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectManufacturer, normalizeManufacturer } from '../src/services/manufacturer.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

describe('manufacturer detection', () => {
  it('reads the maker from the model, the OS, the name, or the MAC address', () => {
    for (const [model, maker] of [
      ['OptiPlex 7090', 'Dell'],
      ['Latitude 5440', 'Dell'],
      ['PowerEdge R750', 'Dell'],
      ['Precision 3660 Tower', 'Dell'],
      ['ThinkPad T14 Gen 3', 'Lenovo'],
      ['ThinkCentre M70q', 'Lenovo'],
      ['HP EliteBook 840 G9', 'HP'],
      ['HP LaserJet Pro M404dn', 'HP'],
      ['ProLiant DL380 Gen10', 'HPE'],
      ['Surface Pro 9', 'Microsoft'],
      ['Virtual Machine', 'Microsoft'],
      ['VMware Virtual Platform', 'VMware'],
      ['MacBook Pro (14-inch, 2023)', 'Apple'],
      ['UniFi Dream Machine Pro', 'Ubiquiti'],
      ['FortiGate 60F', 'Fortinet'],
      ['SonicWall TZ370', 'SonicWall'],
      ['Meraki MX68', 'Cisco Meraki'],
      ['DS920+', 'Synology'],
      ['TASKalfa 3253ci', 'Kyocera'],
      ['MFC-L8900CDW', 'Brother'],
    ])
      expect(detectManufacturer({ model }), model).toBe(maker);
    expect(detectManufacturer({ os: 'VMware ESXi 8.0' })).toBe('VMware');
    expect(detectManufacturer({ name: 'OPTIPLEX-FRONTDESK' })).toBe('Dell');
    // VMware and Hyper-V network adapters; a randomized (locally administered) address says nothing.
    expect(detectManufacturer({ mac: '00:50:56:9a:bc:de' })).toBe('VMware');
    expect(detectManufacturer({ mac: '02-15-5D-00-11-22, 00-15-5D-00-11-22' })).toBe('Microsoft');
    expect(detectManufacturer({ mac: '06:15:5d:00:11:22' })).toBe('');
  });

  it('does not guess from names that are only common words', () => {
    // A server called NEXUS isn't a Cisco switch, and a client named Precision Dental doesn't make Dells.
    expect(detectManufacturer({ name: 'NEXUS', hostname: 'nexus' })).toBe('');
    expect(detectManufacturer({ name: 'PRECISION-FS01' })).toBe('');
    expect(detectManufacturer({ name: 'YOGA-STUDIO-PC' })).toBe('');
    expect(detectManufacturer({ name: 'MS365 admin workstation' })).toBe('');
    expect(detectManufacturer({ model: 'Nexus 9300' })).toBe('Cisco');
    // An Intel network card says nothing about who made the PC.
    expect(detectManufacturer({ model: '', mac: '3C:A9:F4:00:11:22' })).toBe('');
  });

  it('tidies firmware manufacturer names and drops placeholders', () => {
    expect(normalizeManufacturer('Dell Inc.')).toBe('Dell');
    expect(normalizeManufacturer('LENOVO')).toBe('Lenovo');
    expect(normalizeManufacturer('HP')).toBe('HP');
    expect(normalizeManufacturer('Hewlett-Packard')).toBe('HP');
    expect(normalizeManufacturer('Microsoft Corporation')).toBe('Microsoft');
    expect(normalizeManufacturer('ASUSTeK COMPUTER INC.')).toBe('ASUS');
    expect(normalizeManufacturer('To be filled by O.E.M.')).toBe('');
    expect(normalizeManufacturer('System manufacturer')).toBe('');
    expect(normalizeManufacturer('Acme Widgets')).toBe('Acme Widgets');
  });
});

describe('manufacturer detection on assets', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let configuration: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    configuration = layouts.find((l) => l.key === 'configuration')!.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('fills a blank manufacturer when an asset is saved, and never replaces one someone entered', async () => {
    const pc = await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: configuration,
      name: 'HDG-WS-01',
      fields: { model: 'OptiPlex 7010' },
    });
    expect(pc.data.fields.manufacturer).toBe('Dell');

    const typed = await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: configuration,
      name: 'HDG-WS-02',
      fields: { model: 'OptiPlex 7010', manufacturer: 'Dell Technologies' },
    });
    expect(typed.data.fields.manufacturer).toBe('Dell Technologies');

    // Unknown: left blank rather than guessed.
    const unknown = await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: configuration,
      name: 'HDG-BOX',
      fields: { model: 'Model 12' },
    });
    expect(unknown.data.fields.manufacturer).toBeUndefined();

    // A model added later fills it on that save.
    const later = await owner.call('PATCH', `/api/assets/${unknown.data.id}`, {
      fields: { ...unknown.data.fields, model: 'ThinkCentre M90q' },
      version: unknown.data.version,
    });
    expect(later.data.fields.manufacturer).toBe('Lenovo');
  });

  it('fills blanks across existing assets on request, as a new version of each', async () => {
    // Assets saved before detection existed: written straight to the database, manufacturer blank.
    const created = await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: configuration,
      name: 'HDG-SRV-01',
      fields: {},
    });
    await t.handle.pool.query(`update assets set fields = '{"model":"PowerEdge T350"}'::jsonb where id = $1`, [
      created.data.id,
    ]);
    const result = await owner.call('POST', '/api/assets/detect-manufacturers', {});
    expect(result.data).toEqual({ checked: 1, filled: 1 });
    const after = (await owner.call('GET', `/api/assets/${created.data.id}`)).data;
    expect(after.fields.manufacturer).toBe('Dell');
    expect(after.version).toBe(2);
    // Nothing left to do the second time.
    expect((await owner.call('POST', '/api/assets/detect-manufacturers', {})).data).toEqual({ checked: 0, filled: 0 });
  });
});
