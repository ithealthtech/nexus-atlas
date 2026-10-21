import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MicrosoftLicenseView, ReportSection, ReportSnapshot } from '@atlas/shared';
import { microsoftListPrice } from '../src/services/m365-prices.js';
import { findSavings, type TrackedSubscription } from '../src/services/reports/savings.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const sub = (over: Partial<TrackedSubscription>): TrackedSubscription => ({
  name: 'Design Suite',
  status: 'active',
  seats: 10,
  assigned: 7,
  unitCostCents: 1500,
  currency: 'USD',
  billingCycle: 'monthly',
  renewalDate: null,
  autoRenew: false,
  ...over,
});
const SPB = 'aaaaaaaa-0000-0000-0000-000000000001';
const EXO = 'aaaaaaaa-0000-0000-0000-000000000002';
const ODD = 'aaaaaaaa-0000-0000-0000-000000000003';
const microsoft: MicrosoftLicenseView = {
  tenantId: 't',
  checkedAt: '2026-10-21T12:00:00.000Z',
  skus: [
    {
      id: SPB.toUpperCase(),
      name: 'Microsoft 365 Business Premium',
      part: 'SPB',
      enabled: 10,
      assigned: 6,
      status: 'Enabled',
    },
    { id: EXO, name: 'Exchange Online (Plan 1)', part: 'EXCHANGESTANDARD', enabled: 5, assigned: 5, status: 'Enabled' },
    { id: ODD, name: 'Contoso Add-on', part: 'CONTOSO_ADDON', enabled: 3, assigned: 1, status: 'Enabled' },
  ],
  users: [
    { id: 'u1', name: 'Left Company', upn: 'left@harbor.example', enabled: false, skuIds: [SPB, EXO], groupSkuIds: [] },
    { id: 'u2', name: 'Still Here', upn: 'here@harbor.example', enabled: true, skuIds: [SPB], groupSkuIds: [] },
    { id: 'u3', name: 'Blocked, no licenses', upn: 'none@harbor.example', enabled: false, skuIds: [], groupSkuIds: [] },
  ],
};

describe('savings finder', () => {
  it('prices unused tracked seats per month, and never guesses where assignments are not recorded', () => {
    const found = findSavings(
      [
        sub({}), // 3 unused at $15/month
        sub({ name: 'Backup', seats: 12, assigned: 10, unitCostCents: 12_000, billingCycle: 'annual' }), // $10/month each
        sub({ name: 'Perpetual', seats: 5, assigned: 1, billingCycle: 'one_time' }), // not a monthly cost
        sub({ name: 'Untracked', seats: 8, assigned: 0 }), // can't tell
        sub({ name: 'Old', status: 'cancelled', seats: 9, assigned: 1 }),
      ],
      null,
      '2026-10-21',
      '2027-01-19',
    );
    expect(found.unused.map((u) => [u.subscription, u.unused, u.price.cents])).toEqual([
      ['Design Suite', 3, 1500],
      ['Backup', 2, 1000],
    ]);
    expect(found.untracked).toBe(1);
    expect(found.blocked).toEqual([]);
  });

  it('counts Microsoft seats live, prices them from a tracked subscription or the list price, and finds blocked accounts', () => {
    const found = findSavings(
      // Tracked under the same name: its own price is used, and its own (stale) counts aren't counted again.
      [sub({ name: 'Microsoft 365 Business Premium', seats: 10, assigned: 2, unitCostCents: 2050 })],
      microsoft,
      '2026-10-21',
      '2027-01-19',
    );
    expect(found.unused.map((u) => [u.subscription, u.source, u.unused, u.price])).toEqual([
      ['Microsoft 365 Business Premium', 'Microsoft 365', 4, { cents: 2050, currency: 'USD', basis: 'tracked' }],
      ['Contoso Add-on', 'Microsoft 365', 2, { cents: null, currency: 'USD', basis: 'unknown' }],
    ]);
    // The blocked account holds both: Business Premium at the tracked price, Exchange at list price.
    expect(found.blocked).toEqual([
      {
        name: 'Left Company',
        upn: 'left@harbor.example',
        subscriptions: ['Microsoft 365 Business Premium', 'Exchange Online (Plan 1)'],
        price: { cents: 2050 + 400, currency: 'USD', basis: 'list' },
      },
    ]);
    expect(microsoftListPrice('FLOW_FREE')).toBe(0);
    expect(microsoftListPrice('SPB')).toBe(2200);
    expect(microsoftListPrice('SOMETHING_NEW')).toBeNull();
  });

  it('lists renewals in the window, soonest first, with what they cost and how many seats go unused', () => {
    const found = findSavings(
      [
        sub({ name: 'Later', renewalDate: '2027-01-10', autoRenew: true }),
        sub({ name: 'Soon', renewalDate: '2026-11-01', seats: 4, assigned: 0 }),
        sub({ name: 'Past', renewalDate: '2026-10-01' }),
        sub({ name: 'Beyond', renewalDate: '2027-06-01' }),
      ],
      null,
      '2026-10-21',
      '2027-01-19',
    );
    expect(found.renewals.map((r) => [r.subscription, r.date, r.unused, r.valueCents, r.autoRenew])).toEqual([
      ['Soon', '2026-11-01', null, 6000, false],
      ['Later', '2027-01-10', 3, 15_000, true],
    ]);
  });
});

describe('savings finder report', () => {
  let t: TestApp, owner: Browser, clientId: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    for (const body of [
      { name: 'Design Suite', seats: 10, assignments: ['Avery', 'Blake'], unitCostCents: 1500, renewalDate: soon },
      { name: 'Backup Service', seats: 2, assignments: ['Office', 'Server'], unitCostCents: 500 },
      { name: 'Password manager', seats: 6, unitCostCents: 300 },
    ]) {
      const r = await owner.call('POST', `/api/clients/${clientId}/licenses`, body);
      expect(r.status, JSON.stringify(r.data)).toBe(201);
    }
  });
  afterEach(async () => {
    await t.close();
  });

  it('totals the monthly waste, lists unused seats and renewals, and says what it couldn’t count', async () => {
    const made = await owner.call('POST', '/api/reports/runs', {
      kind: 'savings',
      title: 'Savings finder',
      clientIds: [clientId],
      includeMicrosoft: false,
    });
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const snapshot = made.data.snapshot as ReportSnapshot;
    const section = (start: string) => snapshot.sections.find((s) => s.title.startsWith(start)) as ReportSection;
    // 8 unused Design Suite seats at $15 a month.
    expect(section('Savings summary').rows).toEqual([
      ['Harbor Dental', '8', 'USD 120.00', 'USD 1,440.00', '1', 'USD 150.00'],
    ]);
    expect(section('Unused seats').rows).toEqual([
      ['Harbor Dental', 'Design Suite', 'Tracked', '10', '2', '8', 'USD 15.00', 'USD 120.00'],
    ]);
    expect(section('Renewals through').rows[0]).toEqual([
      'Harbor Dental',
      'Design Suite',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      '10',
      '8',
      'USD 150.00',
      'No',
      'Cut 8 unused seats: saves USD 120.00 a term',
    ]);
    expect(snapshot.sections.some((s) => s.title === 'Licenses on blocked accounts')).toBe(false);
    expect(snapshot.warnings.join(' ')).toContain('1 tracked subscription has no assignments recorded');
    const pdf = await owner.call('GET', `/api/reports/runs/${made.data.id}/export?format=pdf&whole=1`);
    expect(pdf.status).toBe(200);
  });
});
