import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanSerial,
  dellExpiry,
  hpProductNumber,
  latestEndDate,
  textDate,
  warrantyVendor,
} from '../src/services/warranty-lookup.js';
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

  it('reads dates from the vendor pages', () => {
    expect(textDate('31 Mar 2027 and more')).toBe('2027-03-31');
    expect(textDate('March 31, 2027')).toBe('2027-03-31');
    expect(textDate('03/31/2027')).toBe('2027-03-31');
    expect(textDate('soon')).toBe('');
    expect(
      dellExpiry(
        '<div>Warranty</div><p>Expired 01 Jan 2024</p><span>Expires</span> <b>31 May 2029</b><i>Expiration: May 31, 2028</i>',
      ),
    ).toBe('2029-05-31');
    expect(dellExpiry('<html>No warranty found</html>')).toBe('');
    expect(hpProductNumber({ data: { verifyResponse: { data: { productNumber: '4K1A3UT#ABA' } } } })).toBe(
      '4K1A3UT#ABA',
    );
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
    if (url.host === 'www.dell.com') {
      if (url.pathname.includes('/ABC1234/'))
        return new Response('<h2>Warranty</h2><div>Expires</div><div>31 May 2029</div>', { status: 200 });
      return new Response('<p>Service tag not found</p>', { status: 200 });
    }
    if (url.host === 'pcsupport.lenovo.com') {
      const serial = JSON.parse(String(init?.body)).serialNumber;
      return json({
        code: 0,
        data: serial === 'PF2ABCDE' ? { baseWarranties: [{ startDate: '2024-02-01', endDate: '2027-02-01' }] } : {},
      });
    }
    if (url.pathname.includes('searchresult')) return json({ data: { productNumber: '4K1A3UT#ABA' } });
    if (url.pathname.includes('warranty/specs')) {
      const body = JSON.parse(String(init?.body));
      if (body.productNumber !== '4K1A3UT#ABA') return json({}, 400);
      return json({ data: { warrantyEndDate: '2026-11-30' } });
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

  it('fills the warranty date when a device is added, with no API keys', async () => {
    expect((await owner.call('GET', '/api/settings/warranty')).data).toEqual({ soonDays: 90, autoLookup: true });
    const dell = await asset('HDG-WS-01', { manufacturer: 'Dell Inc.', serial_number: 'ABC1234' });
    expect(dell.fields.warranty_expires).toBe('2029-05-31');
    // The manufacturer comes from the model when it's blank.
    const lenovo = await asset('HDG-WS-02', { model: 'ThinkPad T14 Gen 4', serial_number: 'pf2abcde' });
    expect(lenovo.fields.warranty_expires).toBe('2027-02-01');
    const hp = await asset('HDG-WS-03', { manufacturer: 'HP', serial_number: '5CG1234XYZ' });
    expect(hp.fields.warranty_expires).toBe('2026-11-30');
    // A date someone entered is left alone.
    const typed = await asset('HDG-WS-04', {
      manufacturer: 'Dell',
      serial_number: 'ABC1234',
      warranty_expires: '2030-01-01',
    });
    expect(typed.fields.warranty_expires).toBe('2030-01-01');
  });

  it('checks a warranty on demand', async () => {
    await owner.call('PUT', '/api/settings/warranty', { soonDays: 90, autoLookup: false });
    const before = await asset('HDG-WS-01', { manufacturer: 'Dell Inc.', serial_number: 'ABC1234' });
    expect(before.fields.warranty_expires ?? '').toBe('');
    expect(calls).toEqual([]);

    const checked = await owner.call('POST', `/api/assets/${before.id}/warranty-check`);
    expect(checked.status, JSON.stringify(checked.data)).toBe(200);
    expect(checked.data).toMatchObject({ vendor: 'Dell', expires: '2029-05-31' });
    expect(checked.data.asset.fields.warranty_expires).toBe('2029-05-31');

    const unknown = await asset('HDG-WS-05', { manufacturer: 'Dell', serial_number: 'ZZZ9999' });
    expect((await owner.call('POST', `/api/assets/${unknown.id}/warranty-check`)).data.message).toMatch(
      /no warranty on record/,
    );
    const apple = await asset('HDG-MAC-01', { manufacturer: 'Apple', serial_number: 'C02XYZ123' });
    expect((await owner.call('POST', `/api/assets/${apple.id}/warranty-check`)).status).toBe(400);
    const blank = await asset('HDG-WS-06', { manufacturer: 'Dell' });
    expect((await owner.call('POST', `/api/assets/${blank.id}/warranty-check`)).status).toBe(400);
  });
});
