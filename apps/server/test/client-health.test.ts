import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { ClientHealthDetail, ClientHealthSummary, RmmHealthCounts } from '@atlas/shared';
import { scoreClient, type HealthInputs } from '../src/services/client-health.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const none = { expired: 0, soon: 0, active: 0, unknown: 0 };
const blank = (): HealthInputs => ({
  passwords: { total: 0, withIssues: 0, breached: 0 },
  devices: null,
  staleDays: 7,
  encryption: { reported: 0, unprotected: 0 },
  documents: { total: 0, overdue: 0 },
  primaryContact: false,
  locations: 0,
  assets: 0,
  domains: { ...none },
  certificates: { ...none },
  warranties: { ...none },
  subscriptions: { ...none },
});
const devices = (over: Partial<RmmHealthCounts>): RmmHealthCounts => ({
  total: 10,
  servers: 2,
  workstations: 8,
  online: 10,
  offline: 0,
  onlineUnknown: 0,
  offlineServers: 0,
  current: 10,
  stale: 0,
  veryStale: 0,
  seenUnknown: 0,
  protectionRunning: 10,
  protectionNotRunning: 0,
  protectionMissing: 0,
  protectionUnknown: 0,
  ...over,
});
const part = (h: ReturnType<typeof scoreClient>, name: string) => h.parts.find((p) => p.part === name)!;

describe('client health score', () => {
  it('counts Bitdefender: infected endpoints double, then attention, then devices it does not manage', () => {
    const base: HealthInputs = {
      ...blank(),
      passwords: { total: 10, withIssues: 0, breached: 0 },
      devices: devices({}),
      encryption: { reported: 10, unprotected: 0 },
    };
    expect(part(scoreClient('c', 'Not linked', base), 'security').score).toBe(100);
    const linked = scoreClient('c', 'Linked', {
      ...base,
      bitdefender: { endpoints: 10, infected: 1, attention: 2, missing: 2 },
    });
    const security = part(linked, 'security');
    // (1 + 1 + 1 + 0.9 × 2 + 0.8 + 10/12) / 7
    expect(security.score).toBe(92);
    expect(security.findings.map((f) => f.text)).toEqual([
      '1 endpoint still infected, per Bitdefender',
      '2 Bitdefender endpoints needing attention',
      '2 devices without Bitdefender',
    ]);
    // Findings point at the client's overview, where the Bitdefender card is.
    expect(security.findings.every((f) => f.section === '')).toBe(true);
    expect(security.detail).toContain('Bitdefender on 10');
  });

  it('leaves out what it cannot measure, rather than counting it healthy', () => {
    // A new client: only documentation can be measured, and nothing is on record yet.
    const empty = scoreClient('c', 'New client', blank());
    expect(part(empty, 'security').score).toBeNull();
    expect(part(empty, 'endpoints').score).toBeNull();
    expect(part(empty, 'renewals').score).toBeNull();
    expect(empty.score).toBe(0);
    expect(part(empty, 'documentation').findings.map((f) => f.text)).toEqual([
      'No primary contact',
      'No locations',
      'No assets documented',
      'No documents yet',
    ]);
  });

  it('weighs the parts, and says how many points each fix is worth', () => {
    const healthy: HealthInputs = {
      ...blank(),
      passwords: { total: 10, withIssues: 0, breached: 0 },
      devices: devices({}),
      encryption: { reported: 10, unprotected: 0 },
      documents: { total: 4, overdue: 0 },
      primaryContact: true,
      locations: 1,
      assets: 12,
      domains: { ...none, active: 2 },
    };
    expect(scoreClient('c', 'Healthy', healthy).score).toBe(100);
    expect(scoreClient('c', 'Healthy', healthy).parts.flatMap((p) => p.findings)).toEqual([]);

    // Half the passwords have issues: security falls by a third of half, and so the score by 30% of that.
    const weak = scoreClient('c', 'Weak passwords', {
      ...healthy,
      passwords: { total: 10, withIssues: 5, breached: 2 },
    });
    expect(part(weak, 'security').score).toBe(83);
    expect(weak.score).toBe(95);
    expect(part(weak, 'security').findings).toEqual([
      { text: '5 of 10 passwords have issues, 2 found in a data breach', section: '/passwords', gain: 5 },
    ]);

    // Without RMM devices, endpoints are left out and the other parts count for more.
    const noRmm = scoreClient('c', 'No RMM', { ...healthy, devices: null, documents: { total: 4, overdue: 4 } });
    expect(part(noRmm, 'endpoints').score).toBeNull();
    expect(part(noRmm, 'documentation').score).toBe(67);
    expect(noRmm.score).toBe(Math.round((100 * 30 + 66.67 * 25 + 100 * 20) / 75));
  });

  it('counts an expired item fully against renewals and one due soon by half', () => {
    const h = scoreClient('c', 'Renewals', {
      ...blank(),
      domains: { expired: 1, soon: 0, active: 1, unknown: 1 },
      certificates: { expired: 0, soon: 2, active: 0, unknown: 0 },
      warranties: { expired: 0, soon: 0, active: 0, unknown: 3 },
    });
    // 4 dated items: 1 expired, 2 due soon (half each) = 2 of 4 lost.
    expect(part(h, 'renewals').score).toBe(50);
    expect(part(h, 'renewals').findings.map((f) => [f.text, f.section])).toEqual([
      ['1 domain expired', '/trackers/domains'],
      ['2 SSL certificates expiring soon', '/trackers/ssl'],
      ['1 domain or certificate with no known expiry date', '/trackers/domains'],
    ]);
    expect(part(h, 'renewals').findings.at(-1)!.gain).toBe(0);
  });
});

describe('client health for staff', () => {
  let t: TestApp, owner: Browser, clientId: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('scores a client from its records, keeps a daily trend, and rises as the gaps close', async () => {
    const first = await owner.call('GET', `/api/clients/${clientId}/health`);
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    const before = first.data as ClientHealthDetail;
    expect(before).toMatchObject({ clientName: 'Harbor Dental', score: 0, change: null });
    expect(before.trend).toHaveLength(1);
    expect(before.parts.find((p) => p.part === 'documentation')!.findings[0]).toMatchObject({
      text: 'No primary contact',
      section: '/contacts',
    });

    await owner.call('POST', `/api/clients/${clientId}/contacts`, { name: 'Robin Hale', primary: true });
    await owner.call('POST', `/api/clients/${clientId}/locations`, { name: 'Main office' });
    // Scores are kept for an hour; make today's row old so it is worked out again.
    await t.handle.db
      .update(schema.clientHealth)
      .set({ updatedAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(schema.clientHealth.clientId, clientId));
    const after = (await owner.call('GET', `/api/clients/${clientId}/health`)).data as ClientHealthDetail;
    expect(after.score).toBe(50);
    expect(after.trend).toHaveLength(1);
    const list = (await owner.call('GET', '/api/client-health')).data as ClientHealthSummary[];
    expect(list).toEqual([
      expect.objectContaining({ clientId, clientName: 'Harbor Dental', score: 50, weakest: 'documentation' }),
    ]);

    // The executive summary carries each client's score, for staff.
    const report = await owner.call('POST', '/api/reports/runs', {
      kind: 'executive',
      title: 'Executive summary',
      clientIds: [clientId],
    });
    const section = report.data.snapshot.sections.find((s: { title: string }) => s.title === 'Client health');
    expect(section.rows).toEqual([['Harbor Dental', '50', 'Not measured', 'Not measured', '50', 'Not measured']]);

    // Deleting the client removes its scores.
    await owner.call('DELETE', `/api/clients/${clientId}`, { confirmName: 'Harbor Dental' });
    expect(await t.handle.db.select().from(schema.clientHealth)).toEqual([]);
  });

  it('shows scores to staff only, for the clients they can open', async () => {
    const otherId = (await owner.call('POST', '/api/clients', { name: 'Other Client' })).data.id;
    const temporary = 'temporary health pass 1234';
    for (const [email, role] of [
      ['health-viewer@atlas.test', 'client_viewer'],
      ['health-tech@atlas.test', 'technician'],
    ] as const)
      await owner.call('POST', '/api/users', {
        email,
        name: email,
        role,
        password: temporary,
        grants: [{ clientId, level: 'read' }],
      });
    // Staff must set up two-step verification before they reach client data.
    const as = async (email: string, staff = false) => {
      const { b } = await signIn(t.app, email, temporary);
      await b.call('POST', '/api/account/password', { current: temporary, next: 'replaced health pass 4321' });
      if (staff) await enroll(b);
      return b;
    };
    const viewer = await as('health-viewer@atlas.test');
    expect((await viewer.call('GET', `/api/clients/${clientId}/health`)).status).toBe(404);
    expect((await viewer.call('GET', '/api/client-health')).data).toEqual([]);

    const tech = await as('health-tech@atlas.test', true);
    expect((await tech.call('GET', `/api/clients/${clientId}/health`)).status).toBe(200);
    expect((await tech.call('GET', `/api/clients/${otherId}/health`)).status).toBe(404);
    expect(
      ((await tech.call('GET', '/api/client-health')).data as ClientHealthSummary[]).map((c) => c.clientId),
    ).toEqual([clientId]);
  });
});
