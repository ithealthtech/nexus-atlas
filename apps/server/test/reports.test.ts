import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  REPORT_KINDS,
  reportDefinitionSchema,
  reportSelectionSchema,
  selectReportSection,
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
    if (url.pathname.endsWith('/users')) return Response.json({ value: [] });
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
  it('collects every report type without private contents, archived records or other clients', async () => {
    await seed();
    for (const kind of REPORT_KINDS) {
      const result = await generate(kind);
      expect(result.status, JSON.stringify(result.data)).toBe(201);
      expect(result.data.snapshot.sections[0].rows.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(result.data);
      for (const hidden of ['never-export-this', 'Archived workstation', 'Other client asset'])
        expect(serialized).not.toContain(hidden);
      if (kind === 'documentation') expect(serialized).toContain('Review overdue');
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
