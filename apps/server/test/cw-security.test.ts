import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const E1 = '11111111-1111-4111-8111-111111111111';
const E2 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.now();

/**
 * A fake ConnectWise platform with patching, backup, vulnerability and MDR APIs. Each answers only to a token that
 * asked for its scope; `refuse` lists scopes the key doesn't have.
 */
function fakePlatform(opts: { refuse?: string[] } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/token') {
      const scope = String(JSON.parse(String(init?.body)).scope);
      if (opts.refuse?.some((s) => scope.includes(s))) return json({ error: 'invalid_scope' }, 400);
      return json({ access_token: `tok ${scope}`, expires_in: 3600 });
    }
    const auth = String((init?.headers as Record<string, string>).Authorization);
    const needs = (scope: string) => auth.includes(scope);
    if (url.pathname === '/api/platform/v1/company/companies') return json([{ id: 'c1', name: 'Harbor Dental Group' }]);
    if (url.pathname === '/api/platform/v2/os-patching/compliance/summary' && needs('ospatching'))
      return json({
        data: [
          {
            companyID: 'c1',
            siteID: 's1',
            endpoints: [
              { endpointID: E1, compliance: 100, missingPatchCount: 0, installedPatchCount: 40 },
              { endpointID: E2, compliance: 60, missingPatchCount: 4, pendingRebootPatchCount: 1, outOfSupport: true },
            ],
          },
        ],
      });
    if (url.pathname === '/api/platform/v2/third-party-patching/compliance/summary' && needs('tppatching'))
      return json({ data: [{ endpoints: [{ endpointID: E2, complianceScore: 80.4, updatesPending: 2 }] }] });
    if (url.pathname === `/api/platform/v2/patching/${E2}/patches` && needs('ospatching'))
      return json({
        summary: { missingCount: 1 },
        patches: [
          {
            kbArticleID: 'KB5031356',
            msrcSeverity: 'Critical',
            classification: 'Security Updates',
            moreInformationLink: 'https://support.microsoft.com/kb/5031356',
          },
          { kbArticleID: 'KB500', installedDate: '2026-09-01T00:00:00Z' },
          { kbArticleID: 'KB666', moreInformationLink: 'javascript:alert(1)' },
        ],
      });
    if (url.pathname === '/api/platform/v2/third-party-patching/patch/details' && needs('tppatching'))
      return json({
        data: [
          {
            endpoints: [
              {
                endpointID: E2,
                applications: [
                  {
                    applicationName: 'Google Chrome',
                    installedVersion: '120',
                    latestVersion: '129',
                    status: 'OUT-OF-DATE',
                  },
                  { applicationName: '7-Zip', status: 'UP-TO-DATE' },
                ],
              },
            ],
          },
        ],
      });
    if (url.pathname.startsWith('/api/backup-dashboard/') && needs('backupdashboard')) {
      if (url.pathname.endsWith('/instances'))
        return json({
          jobs: [
            {
              backupJobName: 'Nightly',
              endpointId: E1,
              dashboardBackupStatus: 'Success',
              lastBackupTimestamp: NOW - 3600_000,
              productName: 'ConnectWise Cloud Backup',
            },
            {
              backupJobName: 'File server',
              endpointId: E2,
              dashboardBackupStatus: 'Failure',
              lastBackupTimestamp: NOW - 86_400_000 * 3,
            },
          ],
        });
      if (url.pathname.endsWith('/dr-readiness'))
        return json({ dr: [{ status: 'Success' }, { status: 'Failure' }, { status: 'Unknown' }] });
      return json({
        alarms: [
          { name: 'OFFSITE_STATUS', severity: 'High', status: 'Open', endpointId: E2 },
          { name: 'Old', status: 'Closed' },
        ],
      });
    }
    if (url.pathname === '/api/v2/vulnerabilities') {
      const ids = JSON.parse(String(init?.body)).endpointIDs as string[];
      return json({
        status: 'success',
        successfulRecords: {
          data: [
            {
              siteId: 's1',
              devices: ids.map((id) => ({
                deviceId: id,
                vulnerabilities:
                  id === E2
                    ? [
                        { cve_id: 'CVE-2024-1', cvss_score: 9.8, severity: 'Critical' },
                        { cve_id: 'CVE-2024-2', cvss_score: 5.1, severity: 'Medium' },
                      ]
                    : [],
              })),
            },
          ],
        },
        failedRecords: { data: [] },
      });
    }
    if (url.pathname === '/api/v1/cases' && needs('security.cases'))
      return json({
        items: [{ case_id: '42', title: 'Suspicious PowerShell', severity: 'high', status: 'open', alerts_count: 3 }],
        pagination: { next_cursor: null, limit: 100 },
      });
    if (url.pathname === '/api/v1/cases/42/impacted-entities' && needs('security.cases'))
      return json({
        items: [
          { type: 'ENDPOINT', endpoint: { name: 'HDG-FS-01' } },
          { type: 'USER', user: { name: 'Jane' } },
        ],
        pagination: { limit: 100 },
      });
    if (url.pathname.includes('/api/')) return json({ message: 'missing scope' }, 403);
    return json({}, 404);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('ConnectWise security and compliance', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let assets: string[];

  const start = async (opts?: { refuse?: string[] }) => {
    const platform = fakePlatform(opts);
    t = await startApp({}, { cwRmmFetch: platform.fetcher });
    owner = (await setupOwner(t.app)).b;
    await owner.call('PUT', '/api/integrations/cw-rmm', {
      clientId: 'asio-client-id-123',
      clientSecret: 'asio-secret-value-456',
    });
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const layoutId = layouts.find((l) => l.key === 'configuration')!.id;
    assets = [];
    for (const [name, endpoint] of [
      ['HDG-DC-01', E1],
      ['HDG-FS-01', E2],
    ]) {
      const id = (await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId, name, fields: {} })).data.id;
      assets.push(id);
      // As a device sync would have recorded it.
      await t.handle.db.execute(
        sql`insert into rmm_device_status (org_id, source, external_id, client_id, asset_id, kind)
            select org_id, 'cw-rmm', ${endpoint}, client_id, id, 'server' from assets where id = ${id}`,
      );
    }
    return platform;
  };
  afterEach(async () => {
    await t.close();
  });

  describe('with every product', () => {
    beforeEach(async () => {
      await start();
    });

    it('shows patching, backup, vulnerabilities and MDR on the client', async () => {
      const res = await owner.call('GET', `/api/clients/${harbor}/security`);
      expect(res.status).toBe(200);
      const s = res.data;
      expect(s.linked).toBe(true);
      expect(s.patching.state).toBe('ok');
      expect(s.patching.data).toMatchObject({
        osScore: 80,
        thirdPartyScore: 80,
        compliant: 1,
        assessed: 2,
        missing: 4,
      });
      expect(s.patching.data.devices[0]).toMatchObject({ name: 'HDG-FS-01', assetId: assets[1], outOfSupport: true });
      expect(s.backup.data).toMatchObject({ jobs: 2, byStatus: { success: 1, failure: 1 }, drScore: 50, drChecks: 2 });
      expect(s.backup.data.failing).toEqual([expect.objectContaining({ name: 'File server', device: 'HDG-FS-01' })]);
      expect(s.backup.data.alarms).toEqual([expect.objectContaining({ name: 'OFFSITE_STATUS', device: 'HDG-FS-01' })]);
      expect(s.vulnerabilities.data.counts).toMatchObject({ critical: 1, medium: 1, high: 0 });
      expect(s.vulnerabilities.data.devices).toEqual([expect.objectContaining({ assetId: assets[1] })]);
      expect(s.incidents.data).toEqual([
        expect.objectContaining({
          id: '42',
          title: 'Suspicious PowerShell',
          alerts: 3,
          impacted: ['HDG-FS-01', 'Jane'],
        }),
      ]);
    });

    it('lists a device’s missing patches, backups and CVEs', async () => {
      const s = (await owner.call('GET', `/api/assets/${assets[1]}/security`)).data;
      expect(s.linked).toBe(true);
      expect(s.patching.data.device).toMatchObject({ osScore: 60, missing: 4, pendingReboot: 1, thirdPartyScore: 80 });
      expect(s.patching.data.missing).toEqual([
        {
          name: 'KB5031356',
          kind: 'os',
          detail: 'Critical · Security Updates',
          link: 'https://support.microsoft.com/kb/5031356',
        },
        // Only web links are kept.
        { name: 'KB666', kind: 'os', detail: '', link: null },
        { name: 'Google Chrome', kind: 'third_party', detail: 'Installed 120, latest 129', link: null },
      ]);
      expect(s.backup.data).toEqual([expect.objectContaining({ name: 'File server', status: 'failure' })]);
      expect(s.vulnerabilities.data.list.map((v: { cve: string }) => v.cve)).toEqual(['CVE-2024-1', 'CVE-2024-2']);
    });

    it('says a client with no linked company is not linked', async () => {
      const other = (await owner.call('POST', '/api/clients', { name: 'Northline' })).data.id;
      const s = (await owner.call('GET', `/api/clients/${other}/security`)).data;
      expect(s.linked).toBe(false);
      expect(s.patching.state).toBe('unavailable');
    });
  });

  it('shows "not available" instead of an error when the key or partner lacks a product', async () => {
    const platform = await start({ refuse: ['backupdashboard', 'security.cases'] });
    const s = (await owner.call('GET', `/api/clients/${harbor}/security`)).data;
    expect(s.patching.state).toBe('ok');
    expect(s.backup).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('backup') });
    expect(s.incidents).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('MDR') });
    // A refused sign-in isn't retried on the next page, so the key doesn't get locked.
    const signIns = platform.calls.filter((c) => c === 'POST /v1/token').length;
    const other = (await owner.call('GET', `/api/assets/${assets[0]}/security`)).data;
    expect(other.backup.state).toBe('unavailable');
    const again = platform.calls.filter((c) => c === 'POST /v1/token').length;
    expect(again).toBe(signIns);
  });
});
