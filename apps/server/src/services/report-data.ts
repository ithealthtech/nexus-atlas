import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import type { LayoutField, ReportDefinition, ReportSnapshot } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { requireClient } from '../authz.js';
import { gdapClient } from '../routes/m365-gdap.js';
import type { SettingsService } from './settings.js';
import type { Scope } from './scope.js';
import { standing } from './trackers.js';

export const MAX_REPORT_ROWS = 10_000;
const DAY = 86_400_000;
const iso = (value: Date | null) => value?.toISOString() ?? '';
const dateValue = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

/** Export explicit metadata only: never include vault secrets, document content, or arbitrary custom fields. */
export async function collectReport(
  scope: Scope,
  definition: ReportDefinition,
  settings: SettingsService,
  fetcher?: typeof fetch,
): Promise<ReportSnapshot> {
  const db = scope.db;
  const actor = scope.actor;
  const clients = [];
  for (const id of definition.clientIds) {
    const { client } = await requireClient(db, actor, id, 'read');
    clients.push({ id: client.id, name: client.name });
  }
  clients.sort((a, b) => a.name.localeCompare(b.name));
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const [org] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, actor.orgId));
  const generatedAt = new Date().toISOString();
  const today = generatedAt.slice(0, 10);
  const cutoff = new Date(Date.parse(today) + definition.withinDays * DAY).toISOString().slice(0, 10);
  const result: ReportSnapshot = {
    schemaVersion: 1,
    organization: org!.name,
    definition,
    generatedAt,
    generatedBy: actor.name,
    clients,
    sources: [],
    warnings: [],
    sections: [],
  };
  const source = (name: string, detail: string, updatedAt: string | null = generatedAt) =>
    result.sources.push({ name, detail, updatedAt });
  const section = (title: string, columns: string[], rows: string[][]) =>
    result.sections.push({ title, columns, rows });
  const selected = (table: { orgId: AnyPgColumn; clientId: AnyPgColumn }) =>
    and(eq(table.orgId, actor.orgId), inArray(table.clientId, definition.clientIds));
  const needAssets = ['executive', 'assets', 'renewals'].includes(definition.kind);
  const needDocs = ['executive', 'documentation'].includes(definition.kind);
  const needLicenses = ['executive', 'licenses', 'renewals'].includes(definition.kind);
  const needEndpoints = ['executive', 'endpoints'].includes(definition.kind);
  const assets = needAssets
    ? await db
        .select({
          clientId: schema.assets.clientId,
          name: schema.assets.name,
          status: schema.assets.status,
          updatedAt: schema.assets.updatedAt,
          fields: schema.assets.fields,
          layoutName: schema.assetLayouts.name,
          layoutFields: schema.assetLayouts.fields,
        })
        .from(schema.assets)
        .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
        .where(and(selected(schema.assets), eq(schema.assets.archived, false)))
        .orderBy(asc(schema.assets.name))
        .limit(MAX_REPORT_ROWS + 1)
    : [];
  const documents = needDocs
    ? await db
        .select({
          clientId: schema.documents.clientId,
          title: schema.documents.title,
          status: schema.documents.status,
          reviewDate: schema.documents.reviewDate,
          updatedAt: schema.documents.updatedAt,
        })
        .from(schema.documents)
        .where(
          and(
            eq(schema.documents.orgId, actor.orgId),
            inArray(schema.documents.clientId, definition.clientIds),
            eq(schema.documents.archived, false),
          ),
        )
        .orderBy(asc(schema.documents.title))
        .limit(MAX_REPORT_ROWS + 1)
    : [];
  const licenses = needLicenses
    ? await db
        .select({
          clientId: schema.licenses.clientId,
          name: schema.licenses.name,
          status: schema.licenses.status,
          seats: schema.licenses.seats,
          assignments: schema.licenses.assignments,
          unitCostCents: schema.licenses.unitCostCents,
          currency: schema.licenses.currency,
          billingCycle: schema.licenses.billingCycle,
          renewalDate: schema.licenses.renewalDate,
          autoRenew: schema.licenses.autoRenew,
        })
        .from(schema.licenses)
        .where(selected(schema.licenses))
        .orderBy(asc(schema.licenses.name))
        .limit(MAX_REPORT_ROWS + 1)
    : [];
  const endpoints = needEndpoints
    ? await db
        .select({
          clientId: schema.rmmDeviceStatus.clientId,
          name: schema.assets.name,
          kind: schema.rmmDeviceStatus.kind,
          online: schema.rmmDeviceStatus.online,
          lastSeenAt: schema.rmmDeviceStatus.lastSeenAt,
          protection: schema.rmmDeviceStatus.protection,
          updatedAt: schema.rmmDeviceStatus.updatedAt,
        })
        .from(schema.rmmDeviceStatus)
        .innerJoin(schema.assets, eq(schema.assets.id, schema.rmmDeviceStatus.assetId))
        .where(
          and(
            eq(schema.rmmDeviceStatus.orgId, actor.orgId),
            inArray(schema.rmmDeviceStatus.clientId, definition.clientIds),
            eq(schema.assets.orgId, actor.orgId),
            eq(schema.assets.archived, false),
          ),
        )
        .orderBy(asc(schema.assets.name))
        .limit(MAX_REPORT_ROWS + 1)
    : [];
  if ([assets, documents, licenses, endpoints].some((list) => list.length > MAX_REPORT_ROWS))
    throw new HttpError(422, 'This report is too large. Choose fewer clients (maximum 10,000 source rows per type).');
  if (needAssets)
    source(
      'Atlas assets',
      'Current non-archived asset records. Custom field contents are excluded except configured expiration dates.',
    );
  if (needDocs) source('Atlas documentation', 'Current non-archived article metadata. Article bodies are excluded.');
  if (needLicenses)
    source(
      'Atlas subscriptions',
      'Manual tracking records. Costs are per billing period and currency; they are not Microsoft reseller billing.',
    );
  if (needEndpoints) {
    for (const c of clients) {
      const rows = endpoints.filter((e) => e.clientId === c.id);
      const last =
        rows
          .map((r) => iso(r.updatedAt))
          .sort()
          .at(-1) ?? null;
      source(`RMM: ${c.name}`, 'Last stored device health. Unknown status is not counted as healthy.', last);
      if (!last) result.warnings.push(`${c.name}: no RMM device health data is available.`);
      else {
        const stale = rows.filter((row) => Date.parse(generatedAt) - row.updatedAt.getTime() > DAY).length;
        if (stale) result.warnings.push(`${c.name}: ${stale} RMM device records are more than 24 hours old.`);
      }
    }
  }
  if (definition.kind === 'executive')
    section(
      'Client overview',
      [
        'Client',
        'Assets',
        'Documents',
        'Reviews overdue',
        'Tracked subscriptions',
        'Endpoints',
        'Offline',
        'Protection missing / stopped',
        'Unknown protection',
      ],
      clients.map((c) => {
        const devices = endpoints.filter((e) => e.clientId === c.id);
        return [
          c.name,
          String(assets.filter((a) => a.clientId === c.id).length),
          String(documents.filter((d) => d.clientId === c.id).length),
          String(documents.filter((d) => d.clientId === c.id && d.reviewDate && d.reviewDate < today).length),
          String(licenses.filter((l) => l.clientId === c.id && l.status === 'active').length),
          devices.length ? String(devices.length) : 'Not available',
          devices.length ? String(devices.filter((e) => e.online === false).length) : 'Not available',
          devices.length
            ? String(devices.filter((e) => e.protection === 'missing' || e.protection === 'not_running').length)
            : 'Not available',
          devices.length ? String(devices.filter((e) => e.protection === null).length) : 'Not available',
        ];
      }),
    );
  if (definition.kind === 'assets')
    section(
      'Asset inventory',
      ['Client', 'Asset', 'Type', 'Status', 'Last updated'],
      assets.map((a) => [names.get(a.clientId)!, a.name, a.layoutName, a.status, iso(a.updatedAt)]),
    );
  if (definition.kind === 'documentation')
    section(
      'Documentation health',
      ['Client', 'Article', 'Status', 'Review due', 'Last updated', 'Attention'],
      documents.map((d) => [
        names.get(d.clientId!)!,
        d.title,
        d.status,
        d.reviewDate ?? 'Not recorded',
        iso(d.updatedAt),
        d.reviewDate && d.reviewDate < today
          ? 'Review overdue'
          : d.status === 'needs_review'
            ? 'Marked for review'
            : Date.parse(generatedAt) - d.updatedAt.getTime() > 180 * DAY
              ? 'Not updated in 180 days'
              : 'No date-based issue detected',
      ]),
    );
  if (definition.kind === 'endpoints')
    section(
      'Endpoint health',
      ['Client', 'Device', 'Type', 'Online', 'Last check-in', 'Protection', 'Last sync'],
      endpoints.map((e) => [
        names.get(e.clientId)!,
        e.name,
        e.kind,
        e.online === null ? 'Unknown' : e.online ? 'Online' : 'Offline',
        iso(e.lastSeenAt) || 'Unknown',
        e.protection ?? 'Unknown',
        iso(e.updatedAt),
      ]),
    );
  if (definition.kind === 'licenses') {
    section(
      'Manually tracked subscriptions',
      ['Client', 'Product', 'Status', 'Seats', 'Assigned', 'Available', 'Cost / billing period', 'Renewal'],
      licenses.map((l) => [
        names.get(l.clientId)!,
        l.name,
        l.status,
        String(l.seats),
        String(l.assignments.length),
        String(Math.max(0, l.seats - l.assignments.length)),
        `${l.currency} ${((l.unitCostCents * l.seats) / 100).toFixed(2)} / ${l.billingCycle}`,
        l.renewalDate ?? 'Not recorded',
      ]),
    );
    if (definition.includeMicrosoft) {
      const saved = await settings.m365(actor.orgId);
      const linked = clients.filter((c) => saved?.tenants[c.id]);
      for (const c of clients.filter((c) => !saved?.tenants[c.id]))
        result.warnings.push(`${c.name}: no Microsoft 365 tenant is linked.`);
      if (linked.length && saved?.authMode !== 'gdap')
        result.warnings.push(
          'Microsoft inventory is unavailable: the connection must use GDAP. Application credentials were not used.',
        );
      else if (linked.length) {
        let microsoft;
        try {
          microsoft = await gdapClient(settings, actor.orgId, fetcher, true);
        } catch {
          result.warnings.push('Microsoft inventory is unavailable. Check the GDAP connection and refresh the report.');
        }
        if (microsoft) {
          const rows: string[][] = [];
          for (const c of linked) {
            try {
              const data = await microsoft.licenses(saved!.tenants[c.id]!.tenantId);
              source(
                `Microsoft 365: ${c.name}`,
                'Read through GDAP. Purchased enabled seats and assignment totals; pricing and renewal dates are not provided.',
                data.checkedAt,
              );
              for (const sku of data.skus)
                rows.push([
                  c.name,
                  sku.name,
                  sku.status,
                  String(sku.enabled),
                  String(sku.assigned),
                  String(Math.max(0, sku.enabled - sku.assigned)),
                ]);
            } catch {
              result.warnings.push(
                `${c.name}: Microsoft inventory could not be read through GDAP. No application fallback or inferred seat counts were used.`,
              );
            }
          }
          section(
            'Microsoft 365 via GDAP',
            ['Client', 'Product', 'Status', 'Enabled seats', 'Assigned', 'Available'],
            rows,
          );
        }
      }
    } else result.warnings.push('Microsoft 365 inventory was excluded from this snapshot.');
  }
  if (definition.kind === 'renewals') {
    const rows: string[][] = [];
    for (const a of assets)
      for (const f of a.layoutFields as LayoutField[]) {
        const value = (a.fields as Record<string, unknown>)[f.key];
        if (f.type === 'date' && f.expires && dateValue(value) && value <= cutoff)
          rows.push([
            names.get(a.clientId)!,
            a.name,
            `${a.layoutName}: ${f.label}`,
            value,
            value < today ? 'Overdue' : 'Upcoming',
            'Asset date',
          ]);
      }
    for (const l of licenses)
      if (l.status === 'active' && l.renewalDate && l.renewalDate <= cutoff)
        rows.push([
          names.get(l.clientId)!,
          l.name,
          'Subscription renewal',
          l.renewalDate,
          l.renewalDate < today ? 'Overdue' : 'Upcoming',
          l.autoRenew ? 'Auto-renew enabled' : 'Manual tracking',
        ]);
    rows.sort((a, b) => a[3]!.localeCompare(b[3]!) || a[0]!.localeCompare(b[0]!));
    section(
      `Renewals through ${cutoff} (including overdue)`,
      ['Client', 'Item', 'Type', 'Due date', 'Status', 'Source / renewal'],
      rows,
    );
    result.warnings.push(
      'Microsoft reseller renewal dates are not supplied by the GDAP directory API. Missing dates are not treated as no renewal risk.',
    );
  }
  if (definition.kind === 'domains') {
    // The Domains and SSL certificates layouts, read the way the trackers read them.
    const layouts = await db
      .select({ id: schema.assetLayouts.id, key: schema.assetLayouts.key })
      .from(schema.assetLayouts)
      .where(
        and(
          eq(schema.assetLayouts.orgId, actor.orgId),
          inArray(schema.assetLayouts.key, ['domain', 'ssl_certificate']),
        ),
      );
    const isDomain = new Set(layouts.filter((l) => l.key === 'domain').map((l) => l.id));
    const records = layouts.length
      ? await db
          .select({
            id: schema.assets.id,
            layoutId: schema.assets.layoutId,
            clientId: schema.assets.clientId,
            name: schema.assets.name,
            fields: schema.assets.fields,
          })
          .from(schema.assets)
          .where(
            and(
              selected(schema.assets),
              eq(schema.assets.archived, false),
              inArray(
                schema.assets.layoutId,
                layouts.map((l) => l.id),
              ),
            ),
          )
          .orderBy(asc(schema.assets.name))
          .limit(MAX_REPORT_ROWS + 1)
      : [];
    if (records.length > MAX_REPORT_ROWS)
      throw new HttpError(422, 'This report is too large. Choose fewer clients (maximum 10,000 source rows per type).');
    const checks = await db
      .select({
        assetId: schema.trackerChecks.assetId,
        kind: schema.trackerChecks.kind,
        checkedAt: schema.trackerChecks.checkedAt,
        ok: schema.trackerChecks.ok,
        detail: schema.trackerChecks.detail,
      })
      .from(schema.trackerChecks)
      .where(selected(schema.trackerChecks));
    const checkOf = new Map(checks.map((c) => [`${c.assetId}:${c.kind}`, c]));
    const start = Date.parse(`${today}T00:00:00Z`);
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const items = records.map((r) => {
      const domain = isDomain.has(r.layoutId);
      const fields = (r.fields ?? {}) as Record<string, unknown>;
      const expires = dateValue(fields.expires) ? fields.expires : null;
      // "Expiring soon" follows the report's own lookahead rather than the trackers' 30 days.
      const state = standing(expires, today, definition.withinDays);
      const check = checkOf.get(`${r.id}:${domain ? 'domain' : 'ssl'}`);
      return {
        ...r,
        domain,
        fields,
        expires,
        state,
        daysLeft: expires ? String(Math.round((Date.parse(`${expires}T00:00:00Z`) - start) / DAY)) : '',
        status: { expired: 'Expired', soon: 'Expiring soon', active: 'Active', unknown: 'No expiry date' }[state],
        check: !check
          ? 'Not checked yet'
          : check.ok
            ? `OK ${iso(check.checkedAt).slice(0, 10)}`
            : `Failed ${iso(check.checkedAt).slice(0, 10)}${check.detail ? `: ${check.detail}` : ''}`,
        checkedAt: check?.checkedAt ?? null,
      };
    });
    source(
      'Atlas domain and SSL trackers',
      'Expiry dates from Domains and SSL certificates records, with the latest automatic registration or certificate check.',
      items
        .map((i) => iso(i.checkedAt))
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
    );
    const unchecked = items.filter((i) => !i.checkedAt).length;
    if (unchecked)
      result.warnings.push(
        `${unchecked} domain or certificate records have not been checked automatically yet. Their dates are as entered.`,
      );
    const domains = items.filter((i) => i.domain);
    const certificates = items.filter((i) => !i.domain);
    const count = (list: typeof items, clientId: string, state: string) =>
      String(list.filter((i) => i.clientId === clientId && i.state === state).length);
    section(
      'Summary',
      [
        'Client',
        'Domains',
        'Expired domains',
        'Expiring domains',
        'Certificates',
        'Expired certificates',
        'Expiring certificates',
        'Failed checks',
      ],
      clients.map((c) => [
        c.name,
        String(domains.filter((i) => i.clientId === c.id).length),
        count(domains, c.id, 'expired'),
        count(domains, c.id, 'soon'),
        String(certificates.filter((i) => i.clientId === c.id).length),
        count(certificates, c.id, 'expired'),
        count(certificates, c.id, 'soon'),
        String(items.filter((i) => i.clientId === c.id && i.check.startsWith('Failed')).length),
      ]),
    );
    // Soonest first; records without a date last.
    const bySoonest = (a: (typeof items)[number], b: (typeof items)[number]) =>
      (a.expires ?? '9999').localeCompare(b.expires ?? '9999') ||
      names.get(a.clientId)!.localeCompare(names.get(b.clientId)!) ||
      a.name.localeCompare(b.name);
    section(
      'Domains',
      ['Client', 'Domain', 'Registrar', 'DNS host', 'Expires', 'Days left', 'Auto-renew', 'Status', 'Last check'],
      domains
        .sort(bySoonest)
        .map((i) => [
          names.get(i.clientId)!,
          i.name,
          text(i.fields.registrar),
          text(i.fields.dns_host),
          i.expires ?? 'Not recorded',
          i.daysLeft,
          i.fields.auto_renew === true ? 'Yes' : 'No',
          i.status,
          i.check,
        ]),
    );
    section(
      'SSL certificates',
      [
        'Client',
        'Certificate',
        'Common name',
        'Issuer',
        'Installed on',
        'Expires',
        'Days left',
        'Status',
        'Last check',
      ],
      certificates
        .sort(bySoonest)
        .map((i) => [
          names.get(i.clientId)!,
          i.name,
          text(i.fields.common_name),
          text(i.fields.issuer),
          text(i.fields.installed_on),
          i.expires ?? 'Not recorded',
          i.daysLeft,
          i.status,
          i.check,
        ]),
    );
  }
  if (
    result.sections.reduce((n, s) => n + s.rows.length, 0) > MAX_REPORT_ROWS ||
    Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024
  )
    throw new HttpError(422, 'This report is too large. Choose fewer clients.');
  return result;
}
