import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanSerial, latestEndDate, warrantyVendor } from '../src/services/warranty-lookup.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

describe('warranty lookup values', () => {
  it('knows which vendors it can ask', () => {
    expect(warrantyVendor('Dell Inc.')).toBe('Dell');
    expect(warrantyVendor('LENOVO')).toBe('Lenovo');
    expect(warrantyVendor('HP')).toBe('HP');
    expect(warrantyVendor('Hewlett-Packard')).toBe('HP');
    expect(warrantyVendor('HPE')).toBeNull();
    expect(warrantyVendor('Hewlett Packard Enterprise')).toBeNull();
    expect(warrantyVendor('VMware, Inc.')).toBeNull();
    expect(warrantyVendor('')).toBeNull();
  });

  it('skips placeholder serial numbers', () => {
    expect(cleanSerial(' 5cg1234xyz ')).toBe('5CG1234XYZ');
    expect(cleanSerial('To Be Filled By O.E.M.')).toBe('');
    expect(cleanSerial('0000000')).toBe('');
    expect(cleanSerial('VMware-42 1a 2b')).toBe('');
  });

  it('takes the last end date of all the entitlements', () => {
    // Dell asset-entitlements
    expect(
      latestEndDate([
        {
          serviceTag: 'ABC1234',
          entitlements: [
            { startDate: '2023-01-01T00:00:00Z', endDate: '2026-01-01T04:59:59.000001Z' },
            { startDate: '2023-01-01T00:00:00Z', endDate: '2028-01-01T04:59:59.000001Z' },
          ],
        },
      ]),
    ).toBe('2028-01-01');
    // Lenovo v2.5
    expect(latestEndDate({ Serial: 'PF1', Warranty: [{ Start: '2024-02-01', End: '2027-02-01' }] })).toBe('2027-02-01');
    // HP
    expect(latestEndDate([{ sn: 'X', offers: [{ serviceObligationLineItemEndDate: '2026-11-30' }] }])).toBe(
      '2026-11-30',
    );
    expect(latestEndDate([{ serviceTag: 'ABC1234', invalid: true, entitlements: [] }])).toBe('');
  });
});

describe('warranty lookup', () => {
  let t: TestApp;
  let owner: Browser;
  let client: string;
  let configuration: string;
  const calls: string[] = [];

  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/oauth/v2/token')) {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      if (auth !== `Basic ${Buffer.from('dell-id:dell-secret').toString('base64')}`) return json({}, 401);
      return json({ access_token: 'dell-token', expires_in: 3600 });
    }
    if (url.pathname.endsWith('/asset-entitlements')) {
      const tag = url.searchParams.get('servicetags');
      return json([
        tag === 'ABC1234'
          ? {
              serviceTag: tag,
              entitlements: [{ endDate: '2027-05-31T04:59:59Z' }, { endDate: '2029-05-31T04:59:59Z' }],
            }
          : { serviceTag: tag, invalid: true, entitlements: [] },
      ]);
    }
    return json({}, 500);
  }) as typeof fetch;

  const asset = async (name: string, fields: Record<string, string>) => {
    const r = await owner.call('POST', `/api/clients/${client}/assets`, { layoutId: configuration, name, fields });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data as { id: string; fields: Record<string, string> };
  };

  beforeEach(async () => {
    calls.length = 0;
    t = await startApp({}, { warrantyFetch: fakeFetch });
    owner = (await setupOwner(t.app)).b;
    client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    configuration = layouts.find((l) => l.key === 'configuration')!.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('keeps vendor secrets encrypted and out of the settings view', async () => {
    const saved = await owner.call('PUT', '/api/settings/warranty', {
      soonDays: 60,
      dellClientId: 'dell-id',
      dellClientSecret: 'dell-secret',
    });
    expect(saved.data).toEqual({
      soonDays: 60,
      autoLookup: true,
      dellClientId: 'dell-id',
      hasDellSecret: true,
      hasLenovoKey: false,
      hpApiKey: '',
      hasHpSecret: false,
    });
    // Saving without the secret keeps it; an empty string clears it.
    expect((await owner.call('PUT', '/api/settings/warranty', { soonDays: 90 })).data).toMatchObject({
      dellClientId: 'dell-id',
      hasDellSecret: true,
    });
    const stored = JSON.stringify(await t.handle.db.execute(sql`select settings::text as s from orgs`));
    expect(stored).toContain('dellSecretSealed');
    expect(stored).not.toContain('dell-secret');
    expect(
      (await owner.call('PUT', '/api/settings/warranty', { soonDays: 90, dellClientSecret: '' })).data,
    ).toMatchObject({ hasDellSecret: false });
  });

  it('fills the warranty date when a device is added, and checks it on demand', async () => {
    // No credentials yet: nothing is asked, and the manual check says what's missing.
    const before = await asset('HDG-WS-01', { manufacturer: 'Dell Inc.', serial_number: 'ABC1234' });
    expect(before.fields.warranty_expires ?? '').toBe('');
    expect(calls).toEqual([]);
    const missing = await owner.call('POST', `/api/assets/${before.id}/warranty-check`);
    expect(missing.status).toBe(400);
    expect(missing.data.error ?? missing.data.message).toMatch(/Dell API credentials/);

    await owner.call('PUT', '/api/settings/warranty', {
      soonDays: 90,
      dellClientId: 'dell-id',
      dellClientSecret: 'dell-secret',
    });
    const checked = await owner.call('POST', `/api/assets/${before.id}/warranty-check`);
    expect(checked.status, JSON.stringify(checked.data)).toBe(200);
    expect(checked.data).toMatchObject({ vendor: 'Dell', expires: '2029-05-31' });
    expect(checked.data.asset.fields.warranty_expires).toBe('2029-05-31');

    // A new device gets its date as it's saved; the manufacturer comes from the model.
    const added = await asset('HDG-WS-02', { model: 'OptiPlex 7090', serial_number: 'abc1234' });
    expect(added.fields.warranty_expires).toBe('2029-05-31');
    // A date someone entered is left alone.
    const typed = await asset('HDG-WS-03', {
      manufacturer: 'Dell',
      serial_number: 'ABC1234',
      warranty_expires: '2030-01-01',
    });
    expect(typed.fields.warranty_expires).toBe('2030-01-01');

    // Unknown to Dell, and a vendor that isn't covered.
    const unknown = await asset('HDG-WS-04', { manufacturer: 'Dell', serial_number: 'ZZZ9999' });
    expect((await owner.call('POST', `/api/assets/${unknown.id}/warranty-check`)).data.message).toMatch(
      /no warranty on record/,
    );
    const apple = await asset('HDG-MAC-01', { manufacturer: 'Apple', serial_number: 'C02XYZ123' });
    expect((await owner.call('POST', `/api/assets/${apple.id}/warranty-check`)).status).toBe(400);
  });

  it('can be turned off for new devices', async () => {
    await owner.call('PUT', '/api/settings/warranty', {
      soonDays: 90,
      autoLookup: false,
      dellClientId: 'dell-id',
      dellClientSecret: 'dell-secret',
    });
    const added = await asset('HDG-WS-05', { manufacturer: 'Dell', serial_number: 'ABC1234' });
    expect(added.fields.warranty_expires ?? '').toBe('');
    expect(calls).toEqual([]);
  });
});
