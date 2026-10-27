import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  REPORT_KINDS,
  REPORT_LINK,
  compareReportSections,
  previousReportRun,
  reportDefinitionSchema,
  reportNeedsAttention,
  reportSectionGroups,
  reportSelectionSchema,
  selectReportSection,
  type ReportSection,
  type ReportSnapshot,
} from '@atlas/shared';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { SettingsService } from '../src/services/settings.js';
import { reportCsv, reportPdf } from '../src/services/report-export.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const APP = '11111111-2222-4333-8444-555555555555';
const USER = '22222222-aaaa-4bbb-8ccc-333333333333';
const sample: ReportSnapshot = {
  schemaVersion: 1,
  organization: 'IT Done Right',
  definition: {
    kind: 'assets',
    title: 'Asset inventory',
    clientIds: [TENANT],
    withinDays: 90,
    includeMicrosoft: false,
  },
  generatedAt: '2026-10-19T12:00:00.000Z',
  generatedBy: 'Avery Example',
  clients: [{ id: TENANT, name: 'Harbor Dental' }],
  sources: [
    {
      name: 'Atlas assets',
      updatedAt: '2026-10-19T12:00:00.000Z',
      detail: 'Current asset metadata. No custom field contents.',
    },
  ],
  warnings: [],
  sections: [
    {
      title: 'Asset inventory',
      columns: ['Client', 'Asset', 'Status'],
      rows: [
        ['Harbor Dental', '=FORMULA()', 'active'],
        ['Harbor Dental', 'Printer', 'inactive'],
      ],
    },
  ],
};

describe('comparing report runs', () => {
  it('finds new, changed and removed rows, ignoring values that move on every capture', () => {
    const columns = ['Client', 'Device', 'Online', 'Protection', 'Last check-in'];
    const previous = {
      title: 'Endpoint health',
      columns,
      rows: [
        ['Harbor', 'HDG-01', 'Online', 'running', '2026-10-01T08:00:00.000Z'],
        ['Harbor', 'HDG-02', 'Online', 'running', '2026-10-01T08:00:00.000Z'],
        ['Harbor', 'HDG-03', 'Offline', 'missing', '2026-10-01T08:00:00.000Z'],
      ],
    };
    const current = {
      title: 'Endpoint health',
      // A column added since (Type) is not a change; columns line up by name.
      columns: ['Client', 'Device', 'Type', 'Online', 'Protection', 'Last check-in'],
      rows: [
        ['Harbor', 'HDG-01', 'workstation', 'Online', 'running', '2026-10-20T08:00:00.000Z'],
        ['Harbor', 'HDG-02', 'workstation', 'Offline', 'running', '2026-10-20T08:00:00.000Z'],
        ['Harbor', 'HDG-04', 'server', 'Online', 'running', '2026-10-20T08:00:00.000Z'],
      ],
    };
    const diff = compareReportSections(previous, current);
    expect(diff.added).toEqual([2]);
    expect(diff.changed).toEqual([
      { index: 1, columns: [3], previous: ['Harbor', 'HDG-02', '', 'Online', 'running', '2026-10-01T08:00:00.000Z'] },
    ]);
    expect(diff.removed).toEqual([['Harbor', 'HDG-03', '', 'Offline', 'missing', '2026-10-01T08:00:00.000Z']]);
    // Per-client summaries match on the client alone; a check's date isn't a change, OK against Failed is.
    const summary = (failed: string, checked: string) => ({
      title: 'Summary',
      columns: ['Client', 'Failed checks', 'Last check'],
      rows: [
        ['Harbor', failed, checked],
        ['Northline', '0', 'OK 2026-10-01'],
      ],
    });
    expect(compareReportSections(summary('0', 'OK 2026-10-01'), summary('0', 'OK 2026-10-20')).changed).toEqual([]);
    expect(
      compareReportSections(summary('0', 'OK 2026-10-01'), summary('1', 'Failed 2026-10-20: timeout')).changed,
    ).toEqual([{ index: 0, columns: [1, 2], previous: ['Harbor', '0', 'OK 2026-10-01'] }]);
  });
  it('compares with the latest earlier run of the same report for the same clients', () => {
    const run = (id: string, kind: string, createdAt: string, clients: string[]) => ({
      id,
      kind: kind as 'endpoints',
      createdAt,
      clients: clients.map((c) => ({ id: c, name: c })),
    });
    const current = run('now', 'endpoints', '2026-10-20T10:00:00Z', ['a', 'b']);
    const runs = [
      current,
      run('older', 'endpoints', '2026-10-01T10:00:00Z', ['b', 'a']),
      run('latest', 'endpoints', '2026-10-15T10:00:00Z', ['a', 'b']),
      run('other-kind', 'assets', '2026-10-19T10:00:00Z', ['a', 'b']),
      run('other-clients', 'endpoints', '2026-10-19T10:00:00Z', ['a']),
      run('later', 'endpoints', '2026-10-21T10:00:00Z', ['a', 'b']),
    ];
    expect(previousReportRun(runs, current)?.id).toBe('latest');
    expect(previousReportRun(runs, runs[1]!)).toBeNull();
  });
  it('says where each selected row sits in its section', () => {
    const snapshot = {
      ...({} as ReportSnapshot),
      sections: [
        {
          title: 'S',
          columns: ['Client', 'Status'],
          rows: [
            ['A', 'active'],
            ['B', 'inactive'],
            ['C', 'active'],
          ],
        },
      ],
    };
    expect(selectReportSection(snapshot, reportSelectionSchema.parse({ query: 'active', field: 1 })).indexes).toEqual([
      0, 1, 2,
    ]);
    expect(selectReportSection(snapshot, reportSelectionSchema.parse({ attention: true })).indexes).toEqual([1]);
  });
});

describe('report exports', () => {
  it('matches field search, attention filters and selected columns and neutralizes CSV formulas', () => {
    expect(reportDefinitionSchema.parse({ ...sample.definition, clientIds: [TENANT.toUpperCase()] }).clientIds).toEqual(
      [TENANT],
    );
    expect(
      reportDefinitionSchema.safeParse({ ...sample.definition, clientIds: [TENANT, TENANT.toUpperCase()] }).success,
    ).toBe(false);
    const selection = reportSelectionSchema.parse({ field: 1, query: 'printer', columns: [1, 2], attention: true });
    expect(selectReportSection(sample, selection).rows).toEqual([['Printer', 'inactive']]);
    const csv = reportCsv(sample, selection);
    expect(csv).toContain('"Asset","Status"\r\n"Printer","inactive"');
    expect(csv).not.toContain('FORMULA');
    const attack = {
      ...sample,
      sections: [
        {
          title: 'Test',
          columns: ['Cell'],
          rows: ['=x', '+x', '-x', '@x', ' \t=x', '\tx', '\r=x', '\u0001=x', 'a,"b"\nc'].map((s) => [s]),
        },
      ],
    };
    const exported = reportCsv(attack, reportSelectionSchema.parse({}));
    for (const row of attack.sections[0]!.rows.slice(0, 8)) expect(exported).toContain(`"'${row[0]}"`);
    expect(exported).toContain('"a,""b""\nc"');
    expect(() => selectReportSection(sample, reportSelectionSchema.parse({ columns: [20] }))).toThrow();
  });
  it('renders an embedded-font multipage PDF and rejects oversized exports explicitly', async () => {
    const snapshot = {
      ...sample,
      sections: [
        {
          title: 'Asset inventory',
          columns: ['Client', 'Asset', 'Status'],
          rows: Array.from({ length: 100 }, (_, i) => [
            'Harbor Dental',
            `Office workstation ${i + 1} – café network`,
            i % 4 ? 'active' : 'inactive',
          ]),
        },
      ],
    };
    const pdf = await reportPdf(snapshot, reportSelectionSchema.parse({}));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/FontFile2');
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(2);
    if (process.env.ATLAS_PDF_SAMPLE_DIR) {
      mkdirSync(process.env.ATLAS_PDF_SAMPLE_DIR, { recursive: true });
      writeFileSync(resolve(process.env.ATLAS_PDF_SAMPLE_DIR, 'atlas-report-sample.pdf'), pdf);
    }
    await expect(
      reportPdf(
        { ...snapshot, sections: [{ ...snapshot.sections[0]!, rows: Array(2001).fill(['A', 'B', 'C']) }] },
        reportSelectionSchema.parse({}),
      ),
    ).rejects.toThrow('2,000');
  });
  it('brands PDFs with the organization logo and accent, and falls back to its name', async () => {
    // A 1×1 PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const selection = reportSelectionSchema.parse({});
    const branded = await reportPdf(sample, selection, {
      name: 'Harbor IT',
      logo: `data:image/png;base64,${png}`,
      accent: '#0f766e',
    });
    expect(branded.toString('latin1')).toContain('/Subtype /Image');
    // SVG can't be embedded and a bad colour is ignored: the name and Atlas blue are used instead.
    const fallback = await reportPdf(sample, selection, {
      name: 'Harbor IT',
      logo: 'data:image/svg+xml;base64,PHN2Zy8+',
      accent: 'not-a-colour',
    });
    expect(fallback.subarray(0, 5).toString()).toBe('%PDF-');
    expect(fallback.toString('latin1')).not.toContain('/Subtype /Image');
    // A broken image is skipped rather than failing the export.
    const broken = await reportPdf(sample, selection, { name: '', logo: 'data:image/png;base64,AAAA', accent: null });
    expect(broken.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('lays out a whole review pack as a document: a cover, then each report it is made of', async () => {
    const section = (part: string, title: string, columns: string[], rows: string[][]) => ({
      part,
      title,
      columns,
      rows,
    });
    const trend = section(
      'Service review',
      'Device health trend',
      ['Client', 'From', 'To', 'Devices', 'Online'],
      [['Harbor Dental', '2026-07-21', '2026-10-19', '10 → 12', '9 → 11']],
    );
    const pack: ReportSnapshot = {
      ...sample,
      definition: { ...sample.definition, kind: 'review', title: 'Harbor Dental quarterly review' },
      sections: [
        section(
          'Executive summary',
          'Client overview',
          ['Client', 'Assets', 'Offline'],
          [['Harbor Dental', '12', '1']],
        ),
        section(
          'Security posture',
          'Device protection and encryption',
          ['Client', 'Device', 'Online'],
          [
            ['Harbor Dental', 'WS-1', 'Offline'],
            ['Harbor Dental', 'WS-2', 'Online'],
          ],
        ),
        trend,
        section(
          'Upcoming renewals',
          'Renewals',
          ['Client', 'Item', 'Due date', 'Status'],
          [['Harbor Dental', 'Firewall', '2026-11-01', 'Upcoming']],
        ),
      ],
    };
    const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    const whole = await reportPdf(pack, 'all');
    if (process.env.ATLAS_PDF_SAMPLE_DIR)
      writeFileSync(resolve(process.env.ATLAS_PDF_SAMPLE_DIR, 'atlas-review-pack-sample.pdf'), whole);
    // The cover, a page for each of the four reports, then the notices and sources.
    expect(pages(whole)).toBe(6);
    // One section of it, as filtered on screen, is a plain export.
    expect(pages(await reportPdf(pack, reportSelectionSchema.parse({ section: 1 })))).toBe(1);
    expect(reportSectionGroups(pack.sections).map((g) => [g.part, g.items.map((i) => i.index)])).toEqual([
      ['Executive summary', [0]],
      ['Security posture', [1]],
      ['Service review', [2]],
      ['Upcoming renewals', [3]],
    ]);
    // A health trend's online count isn't a device that is offline.
    expect(reportNeedsAttention(trend, trend.rows[0]!)).toBe(false);
    expect(reportNeedsAttention(pack.sections[1]!, pack.sections[1]!.rows[0]!)).toBe(true);
    // A review pack is for one client.
    expect(reportDefinitionSchema.safeParse({ ...pack.definition, clientIds: [TENANT, APP] }).success).toBe(false);
  });
});

describe('private client reports', () => {
  let t: TestApp, owner: Browser, orgId: string, clientId: string, otherId: string, settings: SettingsService;
  let graphCalls = 0,
    grantTypes: string[],
    rejectCustomer = false;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') {
      grantTypes.push(new URLSearchParams(String(init?.body)).get('grant_type')!);
      return Response.json({ access_token: 'synthetic-access' });
    }
    graphCalls++;
    if (url.pathname.endsWith('/delegatedAdminRelationships'))
      return Response.json({
        value: [
          {
            id: 'synthetic',
            status: 'active',
            endDateTime: new Date(Date.now() + 86400000).toISOString(),
            customer: { tenantId: TENANT, displayName: 'Harbor Dental' },
          },
        ],
      });
    if (url.pathname.endsWith('/subscribedSkus'))
      return rejectCustomer
        ? Response.json({ error: { message: 'private vendor error' } }, { status: 403 })
        : Response.json({
            value: [
              {
                skuId: APP,
                skuPartNumber: 'SPB',
                prepaidUnits: { enabled: 10 },
                consumedUnits: 4,
                capabilityStatus: 'Enabled',
              },
            ],
          });
    if (url.pathname.endsWith('/users'))
      return Response.json({
        value: [
          {
            id: USER,
            displayName: 'Avery Example',
            userPrincipalName: 'avery@harbor.example',
            accountEnabled: true,
            userType: 'Member',
            usageLocation: 'US',
            assignedLicenses: [{ skuId: APP }],
            // Microsoft returns these whenever they're selected; Atlas refuses licenses without them.
            licenseAssignmentStates: [{ skuId: APP, assignedByGroup: null, state: 'Active' }],
          },
        ],
      });
    if (url.pathname === '/v1.0/reports/authenticationMethods/userRegistrationDetails')
      return Response.json({
        value: [{ userPrincipalName: 'Avery@harbor.example', isMfaRegistered: false, isAdmin: false }],
      });
    if (url.pathname.startsWith('/v1.0/reports/'))
      return new Response(
        'Display Name,User Principal Name,Is Deleted,Exchange Last Activity Date,Last Activity Date\nAvery Example,avery@harbor.example,False,2026-10-20,2026-10-20\n',
      );
    throw new Error('Unexpected request');
  }) as typeof fetch;
  beforeEach(async () => {
    graphCalls = 0;
    grantTypes = [];
    rejectCustomer = false;
    const keys = staticKeyProvider([randomBytes(32)]);
    t = await startApp({}, { keys, m365Fetch: fetcher });
    owner = (await setupOwner(t.app)).b;
    orgId = (await owner.call('GET', '/api/session')).data.actor.orgId;
    settings = new SettingsService(t.handle.db, keys);
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    otherId = (await owner.call('POST', '/api/clients', { name: 'Other Client' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });
  const definition = (kind = 'assets', ids?: string[]) => ({
    kind,
    title: `${kind} report`,
    clientIds: ids ?? [clientId],
    withinDays: 90,
    includeMicrosoft: false,
  });
  const generate = (kind = 'assets', ids?: string[]) => owner.call('POST', '/api/reports/runs', definition(kind, ids));
  async function seed() {
    const [layout] = await t.handle.db
      .insert(schema.assetLayouts)
      .values({
        orgId,
        key: 'report-workstation',
        name: 'Workstation',
        fields: [{ key: 'renewal', label: 'Warranty', type: 'date', expires: true }],
      })
      .returning();
    const [asset] = await t.handle.db
      .insert(schema.assets)
      .values({
        orgId,
        clientId,
        layoutId: layout!.id,
        name: 'Office workstation',
        fields: { renewal: '2020-01-01', privateField: 'never-export-this' },
        notes: 'never-export-this',
      })
      .returning();
    await t.handle.db.insert(schema.assets).values([
      { orgId, clientId, layoutId: layout!.id, name: 'Archived workstation', archived: true },
      { orgId, clientId: otherId, layoutId: layout!.id, name: 'Other client asset' },
    ]);
    await t.handle.db.insert(schema.documents).values({
      orgId,
      clientId,
      title: 'Network guide',
      content: { type: 'doc' },
      contentText: 'never-export-this',
      status: 'needs_review',
      reviewDate: '2020-01-01',
    });
    await owner.call('POST', `/api/clients/${clientId}/licenses`, {
      name: 'Design Suite',
      seats: 10,
      assignments: ['Avery'],
      unitCostCents: 1500,
      renewalDate: '2020-01-01',
      notes: 'never-export-this',
    });
    await t.handle.db.insert(schema.rmmDeviceStatus).values({
      orgId,
      clientId,
      assetId: asset!.id,
      source: 'test',
      externalId: '1',
      kind: 'workstation',
      online: false,
      protection: null,
      updatedAt: new Date('2020-01-01'),
    });
  }
  it('scores documentation coverage from the essentials on record', async () => {
    await seed();
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    await owner.call('POST', `/api/clients/${clientId}/contacts`, { name: 'Dana Morales', primary: true });
    await owner.call('POST', `/api/clients/${clientId}/assets`, {
      layoutId: layouts.find((l) => l.key === 'internet')!.id,
      name: 'Main line',
      fields: { provider: 'Spectrum' },
    });
    await t.handle.db.insert(schema.documents).values({
      orgId,
      clientId,
      title: 'Backup and restore runbook',
      content: { type: 'doc' },
    });
    await owner.call('POST', `/api/clients/${clientId}/passwords`, {
      name: 'Office Wi-Fi',
      category: 'wifi',
      secret: 'x',
    });
    const run = await owner.call('POST', '/api/reports/runs', definition('documentation'));
    const coverage = (run.data.snapshot as ReportSnapshot).sections[0]!;
    expect(coverage.rows[0]!.slice(0, 2)).toEqual(['Harbor Dental', '57%']);
    expect(coverage.rows[0]!.at(-1)).toBe('Location, Network diagram, Admin accounts');
  });

  it('reports domains and certificates by expiry, with the latest automatic check', async () => {
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const domainLayout = layouts.find((l) => l.key === 'domain')!.id;
    const sslLayout = layouts.find((l) => l.key === 'ssl_certificate')!.id;
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const asset = async (client: string, layoutId: string, name: string, fields: Record<string, unknown>) => {
      const r = await owner.call('POST', `/api/clients/${client}/assets`, { layoutId, name, fields });
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    const expired = await asset(clientId, domainLayout, 'harbordental.example', {
      registrar: 'Example Registrar',
      expires: inDays(-3),
      auto_renew: true,
    });
    await asset(clientId, domainLayout, 'harbor-later.example', { expires: inDays(300) });
    await asset(clientId, sslLayout, 'Portal certificate', {
      common_name: 'portal.harbordental.example',
      issuer: 'Example CA',
      expires: inDays(20),
    });
    await asset(otherId, domainLayout, 'other-client.example', { expires: inDays(1) });
    await t.handle.db.insert(schema.trackerChecks).values({
      orgId,
      clientId,
      assetId: expired,
      kind: 'domain',
      host: 'harbordental.example',
      checkedAt: new Date(),
      ok: false,
      detail: 'Registry lookup failed',
    });
    const run = await generate('domains');
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const snapshot = run.data.snapshot as ReportSnapshot;
    expect(snapshot.sections.map((s) => s.title)).toEqual(['Summary', 'Domains', 'SSL certificates']);
    expect(snapshot.sections[0]!.rows).toEqual([['Harbor Dental', '2', '1', '0', '1', '0', '1', '1']]);
    const [first, second] = snapshot.sections[1]!.rows;
    expect(first).toEqual([
      'Harbor Dental',
      'harbordental.example',
      'Example Registrar',
      '',
      inDays(-3),
      '-3',
      'Yes',
      'Expired',
      expect.stringMatching(/^Failed \d{4}-\d{2}-\d{2}: Registry lookup failed$/),
    ]);
    expect(second![7]).toBe('Active');
    expect(snapshot.sections[2]!.rows[0]!.slice(2, 4)).toEqual(['portal.harbordental.example', 'Example CA']);
    expect(snapshot.sections[2]!.rows[0]!.at(-2)).toBe('Expiring soon');
    expect(snapshot.warnings).toContain(
      '2 domain or certificate records have not been checked automatically yet. Their dates are as entered.',
    );
    expect(JSON.stringify(snapshot)).not.toContain('other-client.example');
    // "Needs review" picks out the expired domain and its failed check, not the healthy one.
    expect(
      selectReportSection(snapshot, reportSelectionSchema.parse({ section: 1, attention: true })).rows.map((r) => r[1]),
    ).toEqual(['harbordental.example']);
  });
  it('reports installed software with flags and who signs in, from the RMM inventory', async () => {
    await seed();
    const [layout] = await t.handle.db
      .select({ id: schema.assetLayouts.id })
      .from(schema.assetLayouts)
      .where(eq(schema.assetLayouts.key, 'report-workstation'));
    const [pc] = await t.handle.db
      .insert(schema.assets)
      .values({ orgId, clientId, layoutId: layout!.id, name: 'Reception PC' })
      .returning();
    await t.handle.db.insert(schema.rmmDeviceStatus).values({
      orgId,
      clientId,
      assetId: pc!.id,
      source: 'test',
      externalId: '2',
      kind: 'workstation',
      online: true,
      software: [
        { name: 'Adobe Flash Player 32', version: '32.0', publisher: 'Adobe', installedAt: null },
        { name: '7-Zip 23.01', version: '23.01', publisher: 'Igor Pavlov', installedAt: null },
      ],
      signIns: [{ username: 'avery', domain: 'HDG', lastLogonAt: '2026-10-01T08:00:00.000Z', contactId: null }],
      inventoryAt: new Date(),
    });
    const run = await generate('software');
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const snapshot = run.data.snapshot as ReportSnapshot;
    expect(snapshot.sections.map((s) => s.title)).toEqual(['Summary', 'Software', 'Sign-ins']);
    expect(snapshot.sections[0]!.rows).toEqual([['Harbor Dental', '1 of 2', '2', '1', '0', '0', '1']]);
    expect(snapshot.sections[1]!.rows[0]).toEqual([
      'Harbor Dental',
      'Adobe Flash Player 32',
      'Adobe',
      '32.0',
      '1',
      'End of life',
      expect.any(String),
    ]);
    expect(snapshot.sections[1]!.rows[1]!.slice(1, 2)).toEqual(['7-Zip 23.01']);
    expect(snapshot.sections[2]!.rows).toEqual([
      ['Harbor Dental', 'Reception PC', 'HDG\\avery', '', '2026-10-01T08:00:00.000Z'],
    ]);
    expect(snapshot.warnings).toContain('Harbor Dental: 1 of 2 devices have not reported software or sign-ins.');
    expect(
      selectReportSection(snapshot, reportSelectionSchema.parse({ section: 1, attention: true })).rows.map((r) => r[1]),
    ).toEqual(['Adobe Flash Player 32']);
  });
  it('reviews the work done for a client over the chosen period', async () => {
    await seed();
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    const ticket = { orgId, source: 'test', companyId: '1' };
    await t.handle.db.insert(schema.tickets).values([
      {
        ...ticket,
        externalId: 't1',
        clientId,
        number: '1001',
        summary: 'Printer offline',
        status: 'Closed',
        closed: true,
        openedAt: ago(10),
        closedAt: ago(9),
      },
      { ...ticket, externalId: 't2', clientId, number: '1002', summary: 'New starter laptop', openedAt: ago(3) },
      {
        ...ticket,
        externalId: 't3',
        clientId,
        number: '0900',
        summary: 'Long-closed ticket',
        closed: true,
        openedAt: ago(200),
        closedAt: ago(150),
      },
      {
        ...ticket,
        externalId: 't4',
        clientId: otherId,
        number: '2001',
        summary: 'Other client ticket',
        openedAt: ago(2),
      },
    ]);
    await t.handle.db.insert(schema.checklistRuns).values([
      { orgId, clientId, title: 'Monthly patch review', completedAt: ago(5) },
      { orgId, clientId, title: 'Unfinished onboarding' },
    ]);
    const change = { orgId, clientId, actorName: 'Avery', action: 'Updated' };
    await t.handle.db.insert(schema.activity).values([
      { ...change, entityType: 'document', entityId: randomUUID(), title: 'Network guide' },
      {
        ...change,
        action: 'Changed the password for',
        entityType: 'password',
        entityId: randomUUID(),
        title: 'Firewall admin login',
      },
      { ...change, entityType: 'asset', entityId: randomUUID(), title: 'Last year change', createdAt: ago(400) },
    ]);
    const counts = (total: number, online: number, protectionRunning: number, offlineServers: number) => ({
      total,
      online,
      protectionRunning,
      offlineServers,
    });
    const today = new Date().toISOString().slice(0, 10);
    await t.handle.db.insert(schema.rmmHealthSnapshots).values([
      { orgId, clientId, day: ago(20).toISOString().slice(0, 10), counts: counts(4, 3, 2, 1) },
      { orgId, clientId, day: today, counts: counts(5, 5, 5, 0) },
    ]);
    const run = await generate('service');
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const snapshot = run.data.snapshot as ReportSnapshot;
    expect(snapshot.sections.map((s) => s.title)).toEqual([
      expect.stringMatching(/^Service summary, \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/),
      'Device health trend',
      'Tickets',
      'Completed checklists',
      'Activity',
    ]);
    const summary = snapshot.sections[0]!.rows[0]!;
    // Opened in the period, closed in the period, still open, checklists, documentation, assets added.
    expect(summary.slice(0, 7)).toEqual(['Harbor Dental', '2', '1', '1', '1', '1', '1']);
    expect(Number(summary[7])).toBeGreaterThanOrEqual(2);
    expect(snapshot.sections[1]!.rows).toEqual([
      ['Harbor Dental', ago(20).toISOString().slice(0, 10), today, '4 → 5', '3 → 5', '2 → 5', '1 → 0'],
    ]);
    expect(snapshot.sections[2]!.rows.map((r) => r[1])).toEqual(['1001', '1002']);
    expect(snapshot.sections[3]!.rows.map((r) => r[1])).toEqual(['Monthly patch review']);
    const activity = JSON.stringify(snapshot.sections[4]);
    expect(activity).toContain('Network guide');
    const serialized = JSON.stringify(snapshot);
    for (const hidden of ['Firewall admin login', 'Last year change', 'Long-closed ticket', 'Other client ticket'])
      expect(serialized).not.toContain(hidden);
  });
  it('builds a review pack for one client from the reports it is made of, as one PDF and one link', async () => {
    await seed();
    expect((await generate('review', [clientId, otherId])).status).toBe(400);
    const made = await generate('review');
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const { sections } = made.data.snapshot as ReportSnapshot;
    expect([...new Set(sections.map((s) => s.part))]).toEqual([
      'Executive summary',
      'Security posture',
      'Service review',
      'Upcoming renewals',
    ]);
    expect(sections[0]!.title).toBe('Client overview');
    // The client gets the count of changes, not the internal change log.
    expect(sections.map((s) => s.title)).not.toContain('Activity');
    expect(sections.some((s) => s.title.startsWith('Service summary'))).toBe(true);

    // The whole pack as one PDF, named after the report.
    const pdf = await owner.call('GET', `/api/reports/runs/${made.data.id}/export?format=pdf&whole=1`);
    expect(pdf.status).toBe(200);
    expect(String(pdf.data).startsWith('%PDF-')).toBe(true);
    expect(pdf.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent(`review report ${made.data.createdAt.slice(0, 10)}.pdf`)}`,
    );
    // And from a link: the client downloads all of it.
    const link = await owner.call('POST', `/api/reports/runs/${made.data.id}/shares`, { expiresDays: 30 });
    const token = link.data.url.split('/').pop() as string;
    const shared = await t.app.inject({ method: 'GET', url: `/api/shared-reports/${token}` });
    expect(shared.json().sections[0]).toMatchObject({ part: 'Executive summary', title: 'Client overview' });
    const whole = await t.app.inject({ method: 'GET', url: `/api/shared-reports/${token}/pdf?section=all` });
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
  it('links each row to its record on screen, never in what the client is sent', async () => {
    await seed();
    const made = await generate('assets');
    const inventory = (made.data.snapshot.sections as ReportSection[]).find((s) => s.title === 'Asset inventory')!;
    expect(inventory.links).toHaveLength(inventory.rows.length);
    expect(inventory.links!.every((l) => !!l && REPORT_LINK.test(l) && l.startsWith('/assets/'))).toBe(true);
    // The link opens the asset in that row.
    const first = await owner.call('GET', `/api${inventory.links![0]}`);
    expect(first.data.name).toBe(inventory.rows[0]![1]);
    const docs = (await generate('documentation')).data.snapshot.sections[0] as ReportSection;
    expect(docs.links!.every((l) => l?.startsWith('/documents/'))).toBe(true);

    const link = await owner.call('POST', `/api/reports/runs/${made.data.id}/shares`, { expiresDays: 7 });
    const token = link.data.url.split('/').pop() as string;
    const shared = (await t.app.inject({ method: 'GET', url: `/api/shared-reports/${token}` })).json();
    expect(JSON.stringify(shared)).not.toContain('/assets/');
    expect(shared.sections[0].links).toBeUndefined();
  });

  it('adds chosen asset fields to the inventory, never long text or fields that no longer exist', async () => {
    await seed();
    await t.handle.db
      .update(schema.assetLayouts)
      .set({
        fields: [
          { key: 'renewal', label: 'Warranty', type: 'date', expires: true },
          { key: 'serial', label: 'Serial', type: 'text' },
          { key: 'managed', label: 'Managed', type: 'checkbox' },
          { key: 'notes', label: 'Build notes', type: 'textarea' },
        ],
      })
      .where(eq(schema.assetLayouts.key, 'report-workstation'));
    await t.handle.db
      .update(schema.assets)
      .set({ fields: { renewal: '2020-01-01', serial: 'SN-123', managed: true, notes: 'never-export-this' } })
      .where(eq(schema.assets.name, 'Office workstation'));
    const fields = [
      'report-workstation:serial',
      'report-workstation:managed',
      'report-workstation:notes',
      'report-workstation:gone',
    ];
    const run = await owner.call('POST', '/api/reports/runs', { ...definition('assets'), assetFields: fields });
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const snapshot = run.data.snapshot as ReportSnapshot;
    expect(snapshot.sections[0]!.columns).toEqual([
      'Client',
      'Asset',
      'Type',
      'Status',
      'Workstation: Serial',
      'Workstation: Managed',
      'Last updated',
    ]);
    expect(snapshot.sections[0]!.rows[0]!.slice(1, 6)).toEqual([
      'Office workstation',
      'Workstation',
      'active',
      'SN-123',
      'Yes',
    ]);
    expect(snapshot.warnings).toEqual([
      'The asset field "report-workstation:notes" no longer exists or can\'t be reported, so it was left out.',
      'The asset field "report-workstation:gone" no longer exists or can\'t be reported, so it was left out.',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('never-export-this');
    // The warranty that ran out in 2020 is due for replacement now.
    const forecast = snapshot.sections.find((s) => s.title === 'Hardware replacement forecast')!;
    expect(forecast.columns).toHaveLength(8);
    expect(forecast.columns.at(-2)).toBe('Over 5 years old');
    expect(forecast.rows).toEqual([['Harbor Dental', '1', '0', '0', '0', '0', '0', '0']]);

    // With a purchase date and price, old devices count too, and the cost of replacing what's due is added up.
    await t.handle.db
      .update(schema.assetLayouts)
      .set({
        fields: [
          { key: 'renewal', label: 'Warranty', type: 'date', expires: true },
          { key: 'purchased', label: 'Purchase date', type: 'date' },
          { key: 'price', label: 'Purchase price', type: 'number' },
        ],
      })
      .where(eq(schema.assetLayouts.key, 'report-workstation'));
    await t.handle.db
      .update(schema.assets)
      .set({ fields: { renewal: '2099-01-01', purchased: '2015-06-01', price: 1250 } })
      .where(eq(schema.assets.name, 'Office workstation'));
    const priced = (await owner.call('POST', '/api/reports/runs', definition('assets'))).data
      .snapshot as ReportSnapshot;
    const costed = priced.sections.find((s) => s.title === 'Hardware replacement forecast')!;
    expect(costed.columns.at(-1)).toBe('Replacement cost');
    expect(costed.rows).toEqual([['Harbor Dental', '0', '0', '0', '0', '0', '1', '0', '1,250']]);
    const tooMany = Array.from({ length: 13 }, (_, i) => `report-workstation:f${i}`);
    expect(
      (await owner.call('POST', '/api/reports/runs', { ...definition('assets'), assetFields: tooMany })).status,
    ).toBe(400);
  });
  it('shares a single-client snapshot by an expiring link, without people or IDs, until revoked', async () => {
    await seed();
    const run = (await generate('assets')).data;
    const made = await owner.call('POST', `/api/reports/runs/${run.id}/shares`, { expiresDays: 7 });
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    expect(made.data.url).toMatch(/\/report\/[A-Za-z0-9_-]{32}$/);
    expect(made.data.status).toBe('active');
    const token = made.data.url.split('/').pop() as string;
    const open = (path = '') => t.app.inject({ method: 'GET', url: `/api/shared-reports/${token}${path}` });

    const shared = await open();
    expect(shared.statusCode).toBe(200);
    expect(shared.headers['cache-control']).toBe('no-store');
    const body = shared.json();
    expect(body).toMatchObject({ title: 'assets report', client: 'Harbor Dental' });
    expect(body.sections[0].rows[0]).toContain('Office workstation');
    // Who ran it and the report's settings (with client IDs) stay inside Atlas.
    const runner = (await owner.call('GET', '/api/session')).data.actor.name as string;
    expect(JSON.stringify(body)).not.toContain(runner);
    expect(JSON.stringify(body)).not.toContain(clientId);
    const pdf = await open('/pdf?section=0');
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await open('/pdf?section=9')).statusCode).toBe(400);
    const listed = (await owner.call('GET', `/api/reports/runs/${run.id}/shares`)).data;
    // Each opening counts: the page, the PDF, and the request for a section that doesn't exist.
    expect(listed[0]).toMatchObject({ views: 3, status: 'active' });

    // Only one client's report can go outside Atlas.
    const both = (await generate('assets', [clientId, otherId])).data;
    expect((await owner.call('POST', `/api/reports/runs/${both.id}/shares`, {})).status).toBe(400);
    // Links never last forever.
    expect((await owner.call('POST', `/api/reports/runs/${run.id}/shares`, { expiresDays: null })).status).toBe(400);

    // Someone else can't see or share this person's report.
    const temporary = 'temporary share pass 1234';
    await owner.call('POST', '/api/users', {
      email: 'share-viewer@atlas.test',
      name: 'Share Viewer',
      role: 'client_viewer',
      password: temporary,
      grants: [{ clientId, level: 'read' }],
    });
    const { b } = await signIn(t.app, 'share-viewer@atlas.test', temporary);
    await b.call('POST', '/api/account/password', { current: temporary, next: 'replaced share pass 4321' });
    expect((await b.call('GET', `/api/reports/runs/${run.id}/shares`)).status).toBe(404);
    expect((await b.call('POST', `/api/reports/runs/${run.id}/shares`, {})).status).toBe(404);
    expect((await b.call('DELETE', `/api/report-shares/${made.data.id}`)).status).toBe(404);

    // Revoked, expired, mistyped or deleted: all look like no link at all.
    expect((await owner.call('DELETE', `/api/report-shares/${made.data.id}`)).data[0].status).toBe('revoked');
    expect((await open()).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/api/shared-reports/short' })).statusCode).toBe(404);
    const second = (await owner.call('POST', `/api/reports/runs/${run.id}/shares`, { expiresDays: 30 })).data;
    await t.handle.db
      .update(schema.reportShares)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.reportShares.id, second.id));
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/shared-reports/${second.url.split('/').pop()}` })).statusCode,
    ).toBe(404);
    const events = await t.handle.db
      .select({ action: schema.securityEvents.action })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.orgId, orgId));
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['Report shared by link', 'Report link revoked']),
    );
    expect((await owner.call('DELETE', `/api/reports/runs/${run.id}`)).status).toBe(200);
    expect(await t.handle.db.select().from(schema.reportShares).where(eq(schema.reportShares.runId, run.id))).toEqual(
      [],
    );
  });
  it('collects every report type without private contents, archived records or other clients', async () => {
    await seed();
    await owner.call('PUT', '/api/integrations/m365', {
      clientId: APP,
      clientSecret: 'synthetic-secret',
      partnerTenantId: USER,
      authMode: 'gdap',
      autoSync: false,
    });
    await settings.saveGdap(
      orgId,
      (await settings.m365(orgId))!,
      {
        refreshSealed: '',
        oid: USER,
        name: 'Partner',
        email: 'partner@atlas.test',
        connectedAt: new Date().toISOString(),
      },
      'synthetic-refresh',
    );
    await settings.patchM365(orgId, {
      tenants: {
        [clientId]: { tenantId: TENANT, tenantName: 'Harbor Dental', status: 'ok', checkedAt: null, detail: null },
      },
    });
    for (const kind of REPORT_KINDS) {
      const result = await generate(kind);
      expect(result.status, JSON.stringify(result.data)).toBe(201);
      expect(result.data.snapshot.sections[0].rows.length, kind).toBeGreaterThan(0);
      if (kind === 'accounts' || kind === 'usage') {
        expect(JSON.stringify(result.data.snapshot)).toContain('avery@harbor.example');
        expect(result.data.snapshot.warnings).toEqual([]);
      }
      const serialized = JSON.stringify(result.data);
      for (const hidden of ['never-export-this', 'Archived workstation', 'Other client asset'])
        expect(serialized).not.toContain(hidden);
      if (kind === 'documentation') {
        expect(serialized).toContain('Review overdue');
        expect(result.data.snapshot.sections[0]).toMatchObject({
          title: 'Documentation coverage',
          columns: ['Client', 'Coverage', 'Contacts', 'Locations', 'Assets', 'Passwords', 'Articles', 'Missing'],
          rows: [
            [
              'Harbor Dental',
              '0%',
              '0',
              '0',
              '1',
              '0',
              '1',
              'Primary contact, Location, Network diagram, Backup runbook, Internet provider, Admin accounts, Wi-Fi',
            ],
          ],
        });
      }
      if (kind === 'endpoints') {
        expect(serialized).toContain('Unknown');
        expect(serialized).toContain('24 hours');
      }
      if (kind === 'licenses') expect(serialized).toContain('USD 150.00 / monthly');
      if (kind === 'renewals') expect(result.data.snapshot.sections[0].rows).toHaveLength(2);
    }
    const run = (await generate()).data;
    await t.handle.db
      .update(schema.assets)
      .set({ name: 'Changed workstation' })
      .where(eq(schema.assets.clientId, clientId));
    const stored = await owner.call('GET', `/api/reports/runs/${run.id}`);
    expect(JSON.stringify(stored.data)).toContain('Office workstation');
    expect(JSON.stringify(stored.data)).not.toContain('Changed workstation');
    const exported = await owner.call(
      'GET',
      `/api/reports/runs/${run.id}/export?format=csv&selection=${encodeURIComponent(JSON.stringify({ columns: [1], query: 'Office', field: 1 }))}`,
    );
    expect(exported.status).toBe(200);
    expect(exported.data).toContain('"Office workstation"');
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(
      (await owner.call('GET', `/api/reports/runs/${run.id}/export?format=csv&selection=${encodeURIComponent('{bad')}`))
        .status,
    ).toBe(400);
  });
  it('reports security posture only where the reader may see passwords and rotation', async () => {
    await seed();
    expect(
      (
        await owner.call('POST', `/api/clients/${clientId}/passwords`, {
          name: 'Shared router login',
          username: 'never-export-this',
          secret: 'password1',
        })
      ).status,
    ).toBe(201);
    await owner.call('POST', `/api/clients/${otherId}/passwords`, { name: 'Other client login', secret: 'password1' });
    const [enrollment] = await t.handle.db
      .insert(schema.bitlockerEnrollments)
      .values({ orgId, clientId, name: 'Report test', tokenHash: 'report-test', publicKey: 'x', privateKey: 'x' })
      .returning();
    await t.handle.db.insert(schema.bitlockerDevices).values({
      orgId,
      clientId,
      enrollmentId: enrollment!.id,
      machineId: randomUUID(),
      hostname: 'HDG-LAPTOP-01',
      volumes: [
        {
          volumeId: 'c',
          mountPoint: 'C:',
          protection: 'Off',
          encryptionMethod: 'None',
          encryptionPercentage: 0,
          conversionStatus: 'FullyDecrypted',
          keyIds: [],
        },
      ],
      collectedAt: new Date(),
    });
    const run = await generate('security');
    expect(run.status, JSON.stringify(run.data)).toBe(201);
    const { sections } = run.data.snapshot as ReportSnapshot;
    expect(sections.map((s) => s.title)).toEqual([
      'Security overview',
      'Password issues',
      'Device protection and encryption',
      'Automatic password rotation',
    ]);
    const overview = sections[0]!;
    const cell = (name: string) => overview.rows[0]![overview.columns.indexOf(name)];
    expect([cell('Passwords'), cell('Password issues'), cell('Not encrypted'), cell('Rotation failing')]).toEqual([
      '1',
      '1',
      '1',
      '0',
    ]);
    expect(sections[1]!.rows).toEqual([
      ['Harbor Dental', 'Shared router login', expect.any(String), expect.stringContaining('Weak')],
    ]);
    expect(sections[2]!.rows).toContainEqual([
      'Harbor Dental',
      'HDG-LAPTOP-01',
      'Not in RMM',
      'Not in RMM',
      'Not encrypted',
      expect.any(String),
    ]);
    expect(sections[2]!.rows).toContainEqual([
      'Harbor Dental',
      'Office workstation',
      'Offline',
      'Unknown',
      'Not reported',
      'Unknown',
    ]);
    const serialized = JSON.stringify(run.data);
    for (const hidden of ['never-export-this', 'password1', 'Other client login'])
      expect(serialized).not.toContain(hidden);

    // A client account can run it too, but sees no passwords or rotation.
    const temporary = 'temporary security pass 1234';
    await owner.call('POST', '/api/users', {
      email: 'security-viewer@atlas.test',
      name: 'Security Viewer',
      role: 'client_viewer',
      password: temporary,
      grants: [{ clientId, level: 'read' }],
    });
    const { b } = await signIn(t.app, 'security-viewer@atlas.test', temporary);
    await b.call('POST', '/api/account/password', { current: temporary, next: 'replaced security pass 4321' });
    const limited = await b.call('POST', '/api/reports/runs', definition('security'));
    expect(limited.status, JSON.stringify(limited.data)).toBe(201);
    const snapshot = limited.data.snapshot as ReportSnapshot;
    expect(snapshot.sections.map((s) => s.title)).toEqual(['Security overview', 'Device protection and encryption']);
    expect(snapshot.sections[0]!.rows[0]!.slice(1, 4)).toEqual(['Not available', 'Not available', 'Not available']);
    expect(snapshot.warnings).toContain(
      "Harbor Dental: passwords are not included because you don't have password access here.",
    );
    expect(snapshot.warnings).toContain('Automatic password rotation is shown to administrators only.');
    expect(JSON.stringify(snapshot)).not.toContain('Shared router login');
  });
  it('keeps templates private, checks stale edits, validates inputs and purges client snapshots on deletion', async () => {
    const created = await owner.call('POST', '/api/reports/templates', {
      name: 'Monthly inventory',
      definition: definition(),
    });
    expect(created.status).toBe(201);
    const path = `/api/reports/templates/${created.data.id}`;
    expect(
      (await owner.call('PUT', path, { name: 'Updated inventory', definition: definition(), version: 1 })).data.version,
    ).toBe(2);
    expect((await owner.call('PUT', path, { name: 'Stale', definition: definition(), version: 1 })).status).toBe(409);
    expect((await owner.call('DELETE', path, { version: 1 })).status).toBe(409);
    const run = (await generate()).data;
    expect((await owner.call('GET', '/api/reports/runs')).data).toHaveLength(1);
    expect(
      (await owner.call('POST', '/api/reports/runs', { ...definition(), clientIds: [clientId, clientId] })).status,
    ).toBe(400);
    expect((await owner.call('POST', '/api/reports/runs', { ...definition(), withinDays: 45 })).status).toBe(400);
    expect((await owner.call('DELETE', `/api/clients/${clientId}`, { confirmName: 'Harbor Dental' })).status).toBe(200);
    expect((await owner.call('GET', `/api/reports/runs/${run.id}`)).status).toBe(404);
    expect(await t.handle.db.select().from(schema.reportTemplates)).toHaveLength(0);
    expect(await t.handle.db.select().from(schema.reportRuns)).toHaveLength(0);
  });
  it('upgrades existing report data without retaining removed clients or deleting valid snapshots', async () => {
    // Recreate the pre-cleanup schema in this disposable database, then apply the actual upgrade migration.
    await t.handle.db.execute(sql`DROP TRIGGER atlas_purge_client_reports ON public.clients`);
    await t.handle.db.execute(sql`DROP FUNCTION public.atlas_purge_client_reports()`);
    await generate();
    const kept = (await generate('assets', [otherId])).data;
    await owner.call('POST', '/api/reports/templates', { name: 'Removed client', definition: definition() });
    await owner.call('POST', '/api/reports/templates', {
      name: 'Kept client',
      definition: definition('assets', [otherId]),
    });
    await t.handle.db.delete(schema.clients).where(eq(schema.clients.id, clientId));
    expect(await t.handle.db.select().from(schema.reportRuns)).toHaveLength(2);
    const migration = readFileSync(
      new URL('../../../packages/db/drizzle/0037_report_client_cleanup.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint'))
      if (statement.trim()) await t.handle.db.execute(sql.raw(statement));
    expect((await t.handle.db.select().from(schema.reportRuns)).map((r) => r.id)).toEqual([kept.id]);
    expect((await t.handle.db.select().from(schema.reportTemplates)).map((r) => r.name)).toEqual(['Kept client']);
    await t.handle.db.delete(schema.clients).where(eq(schema.clients.id, otherId));
    expect(await t.handle.db.select().from(schema.reportRuns)).toHaveLength(0);
    expect(await t.handle.db.select().from(schema.reportTemplates)).toHaveLength(0);
  });
  it('purges removed-client snapshots during merges and bulk organization deletion', async () => {
    const removed = (await generate()).data;
    await owner.call('POST', '/api/reports/templates', { name: 'Removed client template', definition: definition() });
    const kept = (await generate('assets', [otherId])).data;
    await owner.call('POST', '/api/reports/templates', {
      name: 'Kept client template',
      definition: definition('assets', [otherId]),
    });
    const merged = await owner.call('POST', '/api/duplicates/merge', {
      type: 'clients',
      keepId: otherId,
      mergeIds: [clientId],
    });
    expect(merged.status).toBe(200);
    expect((await owner.call('GET', `/api/reports/runs/${removed.id}`)).status).toBe(404);
    expect((await owner.call('GET', `/api/reports/runs/${kept.id}`)).status).toBe(200);
    expect(await t.handle.db.select().from(schema.reportRuns)).toHaveLength(1);
    expect(await t.handle.db.select().from(schema.reportTemplates)).toHaveLength(1);
    // Organization erasure also deletes clients in bulk rather than using the individual client service.
    await t.handle.db.delete(schema.clients).where(eq(schema.clients.orgId, orgId));
    expect(await t.handle.db.select().from(schema.reportRuns)).toHaveLength(0);
    expect(await t.handle.db.select().from(schema.reportTemplates)).toHaveLength(0);
  });
  it('purges a report committed while client deletion is waiting on its shared lock', async () => {
    const initial = (await generate()).data;
    const actor = (await owner.call('GET', '/api/session')).data.actor;
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = t.handle.db.transaction(async (tx) => {
      await tx
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(eq(schema.clients.id, clientId))
        .for('share');
      locked();
      await gate;
      await tx.insert(schema.reportRuns).values({
        orgId,
        ownerId: actor.id,
        kind: 'assets',
        title: 'Concurrent snapshot',
        clientIds: [clientId],
        clients: initial.clients,
        warningCount: 0,
        rowCount: 0,
        snapshot: initial.snapshot,
      });
    });
    await ready;
    const deleting = owner.call('DELETE', `/api/clients/${clientId}`, { confirmName: 'Harbor Dental' });
    try {
      // Wait until deletion reaches the client lock rather than relying on a timing assumption.
      for (let i = 0; i < 100; i++) {
        const waiting = await t.handle.db.execute(
          sql`select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%"clients"%'`,
        );
        if (waiting.rows.length) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      unlock();
    }
    await writer;
    expect((await deleting).status).toBe(200);
    expect(await t.handle.db.select().from(schema.reportRuns)).toHaveLength(0);
  });
  it('enforces owner, organization and current client access for generation, templates, history and downloads', async () => {
    const ownerRun = (await generate()).data;
    const ownerTemplate = (
      await owner.call('POST', '/api/reports/templates', { name: 'Owner private', definition: definition() })
    ).data;
    const temporary = 'temporary reports pass 1234';
    const user = (
      await owner.call('POST', '/api/users', {
        email: 'viewer@atlas.test',
        name: 'Viewer',
        role: 'client_viewer',
        password: temporary,
        grants: [{ clientId, level: 'read' }],
      })
    ).data;
    const { b } = await signIn(t.app, 'viewer@atlas.test', temporary);
    await b.call('POST', '/api/account/password', { current: temporary, next: 'replaced reports pass 4321' });
    expect((await b.call('GET', `/api/reports/runs/${ownerRun.id}`)).status).toBe(404);
    expect((await b.call('DELETE', `/api/reports/runs/${ownerRun.id}`)).status).toBe(404);
    expect((await b.call('GET', `/api/reports/runs/${ownerRun.id}/export?format=pdf`)).status).toBe(404);
    expect((await b.call('GET', '/api/reports/templates')).data).toEqual([]);
    expect(
      (
        await b.call('PUT', `/api/reports/templates/${ownerTemplate.id}`, {
          name: 'Hijack',
          definition: definition(),
          version: 1,
        })
      ).status,
    ).toBe(409);
    const [foreignOrg] = await t.handle.db.insert(schema.orgs).values({ name: 'Foreign Org' }).returning();
    const [foreign] = await t.handle.db
      .insert(schema.clients)
      .values({ orgId: foreignOrg!.id, name: 'Foreign Client' })
      .returning();
    for (const id of [otherId, foreign!.id, randomUUID()]) {
      expect((await b.call('POST', '/api/reports/runs', definition('assets', [id]))).status).toBe(404);
      expect(
        (await b.call('POST', '/api/reports/templates', { name: 'No access', definition: definition('assets', [id]) }))
          .status,
      ).toBe(404);
    }
    const ownRun = await b.call('POST', '/api/reports/runs', definition());
    expect(ownRun.status).toBe(201);
    await b.call('POST', '/api/reports/templates', { name: 'Private viewer', definition: definition() });
    await t.handle.db.delete(schema.clientAccess).where(eq(schema.clientAccess.userId, user.id));
    expect((await b.call('GET', `/api/reports/runs/${ownRun.data.id}`)).status).toBe(404);
    expect((await b.call('GET', `/api/reports/runs/${ownRun.data.id}/export?format=csv`)).status).toBe(404);
    expect((await b.call('GET', '/api/reports/runs')).data).toEqual([]);
    expect((await b.call('GET', '/api/reports/templates')).data).toEqual([]);
    expect(graphCalls).toBe(0);
    const token = (
      await owner.call('POST', '/api/api-keys', { name: 'Synthetic integration', scopes: ['read', 'write'] })
    ).data.token;
    for (const path of ['/reports/runs', '/reports/templates', `/reports/runs/${ownerRun.id}/export?format=csv`]) {
      expect(
        (await t.app.inject({ method: 'GET', url: '/api/v1' + path, headers: { authorization: `Bearer ${token}` } }))
          .statusCode,
      ).toBe(403);
    }
  });
  it('reads Microsoft inventory through GDAP only and reports connection failures without secret details', async () => {
    await owner.call('PUT', '/api/integrations/m365', {
      clientId: APP,
      clientSecret: 'synthetic-secret',
      partnerTenantId: USER,
      authMode: 'gdap',
      autoSync: false,
    });
    await settings.saveGdap(
      orgId,
      (await settings.m365(orgId))!,
      {
        refreshSealed: '',
        oid: USER,
        name: 'Partner',
        email: 'partner@atlas.test',
        connectedAt: new Date().toISOString(),
      },
      'synthetic-refresh',
    );
    await settings.patchM365(orgId, {
      tenants: {
        [clientId]: { tenantId: TENANT, tenantName: 'Harbor Dental', status: 'ok', checkedAt: null, detail: null },
      },
    });
    const body = { ...definition('licenses'), includeMicrosoft: true };
    const result = await owner.call('POST', '/api/reports/runs', body);
    expect(result.status).toBe(201);
    expect(result.data.snapshot.sections[1].rows[0]).toEqual([
      'Harbor Dental',
      'Microsoft 365 Business Premium',
      'Enabled',
      '10',
      '4',
      '6',
    ]);
    expect(new Set(grantTypes)).toEqual(new Set(['refresh_token']));
    rejectCustomer = true;
    const failure = await owner.call('POST', '/api/reports/runs', body);
    expect(failure.status).toBe(201);
    expect(JSON.stringify(failure.data)).toContain('could not be read through GDAP');
    expect(JSON.stringify(failure.data)).not.toContain('private vendor error');
    graphCalls = 0;
    grantTypes = [];
    await settings.patchM365(orgId, { authMode: 'application' });
    const blocked = await owner.call('POST', '/api/reports/runs', body);
    expect(JSON.stringify(blocked.data)).toContain('Application credentials were not used');
    expect(graphCalls).toBe(0);
    expect(grantTypes).toEqual([]);
  });
});
