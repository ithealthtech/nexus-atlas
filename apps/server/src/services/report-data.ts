import { and, asc, desc, eq, gte, inArray, ne, or } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import {
  type LayoutField,
  PASSWORD_ISSUE_LABELS,
  type PasswordHealthReport,
  type ReportDefinition,
  type ReportSnapshot,
  type RmmHealthCounts,
  ROLE_INFO,
  type RotationRunStatus,
  type RotationTargetView,
  type SoftwareFlag,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { requireClient } from '../authz.js';
import { gdapClient } from '../routes/m365-gdap.js';
import type { SettingsService } from './settings.js';
import type { Scope } from './scope.js';
import { standing } from './trackers.js';

/** Where the security posture report reads passwords and rotation, with each service's own access rules. */
export interface SecuritySources {
  /** Only what this person may see in the vault (vault access and restricted items apply). */
  passwordHealth(scope: Scope): Promise<PasswordHealthReport>;
  /** Administrators only; anyone else gets an error and the report leaves rotation out. */
  rotationTargets(scope: Scope): Promise<RotationTargetView[]>;
}

const ROTATION_RESULT: Record<RotationRunStatus, string> = {
  dispatched: 'In progress',
  candidate: 'In progress',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
/** A machine's BitLocker state: any unprotected volume counts against it, and no volumes is not "encrypted". */
const encryptionOf = (volumes: schema.BitlockerVolume[]) =>
  !volumes.length
    ? 'Unknown'
    : volumes.some((v) => v.protection === 'Off')
      ? 'Not encrypted'
      : volumes.every((v) => v.protection === 'On')
        ? 'Encrypted'
        : 'Unknown';
import { DeviceInventoryService } from './device-inventory.js';

export const MAX_REPORT_ROWS = 10_000;
const DAY = 86_400_000;
const iso = (value: Date | null) => value?.toISOString() ?? '';
const FLAG_LABEL: Record<SoftwareFlag, string> = {
  end_of_life: 'End of life',
  unlicensed: 'Unlicensed',
  over_seats: 'Over seats',
};
/** How many activity entries a service review lists; the summary still counts them all. */
const MAX_ACTIVITY_ROWS = 2000;
const dayOf = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value));
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
  security?: SecuritySources,
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
  const needEndpoints = ['executive', 'endpoints', 'security'].includes(definition.kind);
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
          assetId: schema.rmmDeviceStatus.assetId,
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
  if (definition.kind === 'security') {
    // Passwords only for the clients whose vault this person can open, through the vault's own access rules.
    const vaultIds = new Set<string>();
    if (security && ROLE_INFO[actor.role].staff)
      for (const c of clients) if ((await scope.level(c.id)) === 'edit_passwords') vaultIds.add(c.id);
    for (const c of clients.filter((c) => !vaultIds.has(c.id)))
      result.warnings.push(`${c.name}: passwords are not included because you don't have password access here.`);
    const health = vaultIds.size ? await security!.passwordHealth(scope) : null;
    const issues = health?.items.filter((i) => vaultIds.has(i.clientId)) ?? [];
    const totals = new Map(health?.clients.map((c) => [c.id, c]) ?? []);
    if (health) {
      source(
        'Atlas password vault',
        'Password names and health flags only. Passwords, usernames, notes and custom fields are excluded.',
        health.breach.lastRunAt,
      );
      if (!health.breach.enabled)
        result.warnings.push('Breach checks are turned off, so passwords found in data breaches are not detected.');
      else if (health.breach.unchecked)
        result.warnings.push(
          'Some logins have not been checked against known breaches yet. They are not counted as breached.',
        );
    }
    const devices = await db
      .select({
        clientId: schema.bitlockerDevices.clientId,
        assetId: schema.bitlockerDevices.assetId,
        hostname: schema.bitlockerDevices.hostname,
        volumes: schema.bitlockerDevices.volumes,
        collectedAt: schema.bitlockerDevices.collectedAt,
      })
      .from(schema.bitlockerDevices)
      .where(and(selected(schema.bitlockerDevices), eq(schema.bitlockerDevices.blocked, false)))
      .orderBy(asc(schema.bitlockerDevices.hostname))
      .limit(MAX_REPORT_ROWS + 1);
    if (devices.length > MAX_REPORT_ROWS)
      throw new HttpError(422, 'This report is too large. Choose fewer clients (maximum 10,000 source rows per type).');
    source(
      'BitLocker collector',
      'Volume protection reported by enrolled machines. Recovery keys are excluded.',
      devices
        .map((d) => iso(d.collectedAt))
        .sort()
        .at(-1) ?? null,
    );
    // Rotation is administration: anyone else's report leaves it out rather than failing.
    const targets = security
      ? await security
          .rotationTargets(scope)
          .then((all) => all.filter((r) => names.has(r.clientId)))
          .catch(() => null)
      : null;
    if (targets)
      source('Automatic password rotation', 'Rotation targets and their last result. Passwords are excluded.');
    else result.warnings.push('Automatic password rotation is shown to administrators only.');
    section(
      'Security overview',
      [
        'Client',
        'Passwords',
        'Password issues',
        'Breached',
        'Endpoints',
        'Offline',
        'Protection missing / stopped',
        'Not encrypted',
        'Rotation failing',
      ],
      clients.map((c) => {
        const vault = vaultIds.has(c.id);
        const total = totals.get(c.id);
        const machines = endpoints.filter((e) => e.clientId === c.id);
        const encrypted = devices.filter((d) => d.clientId === c.id);
        return [
          c.name,
          vault ? String(total?.total ?? 0) : 'Not available',
          vault ? String(total?.withIssues ?? 0) : 'Not available',
          vault
            ? String(issues.filter((i) => i.clientId === c.id && i.issues.includes('breached')).length)
            : 'Not available',
          machines.length ? String(machines.length) : 'Not available',
          machines.length ? String(machines.filter((e) => e.online === false).length) : 'Not available',
          machines.length
            ? String(machines.filter((e) => e.protection === 'missing' || e.protection === 'not_running').length)
            : 'Not available',
          encrypted.length
            ? String(encrypted.filter((d) => encryptionOf(d.volumes) === 'Not encrypted').length)
            : 'Not available',
          targets
            ? String(targets.filter((r) => r.clientId === c.id && r.lastStatus === 'failed').length)
            : 'Not available',
        ];
      }),
    );
    if (health)
      section(
        'Password issues',
        ['Client', 'Password', 'Category', 'Issues'],
        issues.map((i) => [
          names.get(i.clientId)!,
          i.name,
          i.category,
          i.issues.map((x) => PASSWORD_ISSUE_LABELS[x]).join(', '),
        ]),
      );
    // One row per machine: RMM devices with their BitLocker state, then BitLocker machines RMM doesn't know.
    const byAsset = new Map(devices.filter((d) => d.assetId).map((d) => [d.assetId!, d]));
    const machineRows = endpoints.map((e) => {
      const disk = byAsset.get(e.assetId);
      return [
        names.get(e.clientId)!,
        e.name,
        e.online === null ? 'Unknown' : e.online ? 'Online' : 'Offline',
        e.protection ?? 'Unknown',
        disk ? encryptionOf(disk.volumes) : 'Not reported',
        iso(e.lastSeenAt) || 'Unknown',
      ];
    });
    const known = new Set(endpoints.map((e) => e.assetId));
    for (const d of devices.filter((d) => !d.assetId || !known.has(d.assetId)))
      machineRows.push([
        names.get(d.clientId)!,
        d.hostname,
        'Not in RMM',
        'Not in RMM',
        encryptionOf(d.volumes),
        iso(d.collectedAt),
      ]);
    section(
      'Device protection and encryption',
      ['Client', 'Device', 'Online', 'Protection', 'Encryption', 'Last check-in'],
      machineRows.sort((a, b) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!)),
    );
    if (targets)
      section(
        'Automatic password rotation',
        ['Client', 'Device', 'Account', 'Enabled', 'Last rotated', 'Next due', 'Last result'],
        targets.map((r) => [
          r.clientName,
          r.assetName,
          r.passwordName,
          r.enabled ? 'Yes' : 'No',
          r.lastRotatedAt ?? 'Never',
          r.nextDueAt ?? 'No policy',
          r.lastStatus ? ROTATION_RESULT[r.lastStatus] : 'Not run yet',
        ]),
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
  if (definition.kind === 'software') {
    // The device inventory the RMM sync saved: never read is not the same as nothing installed.
    const devices = await db
      .select({
        clientId: schema.rmmDeviceStatus.clientId,
        name: schema.assets.name,
        signIns: schema.rmmDeviceStatus.signIns,
        inventoryAt: schema.rmmDeviceStatus.inventoryAt,
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
      .limit(MAX_REPORT_ROWS + 1);
    if (devices.length > MAX_REPORT_ROWS)
      throw new HttpError(422, 'This report is too large. Choose fewer clients (maximum 10,000 source rows per type).');
    const inventory = new DeviceInventoryService();
    const software = new Map<string, Awaited<ReturnType<DeviceInventoryService['forClient']>>>();
    for (const c of clients) software.set(c.id, await inventory.forClient(scope, c.id));
    type SignIn = { username: string; domain: string; lastLogonAt: string | null; contactId: string | null };
    const contactIds = devices.flatMap((d) =>
      ((d.signIns ?? []) as SignIn[]).flatMap((u) => (u.contactId ? [u.contactId] : [])),
    );
    const contacts = new Map(
      contactIds.length
        ? (
            await db
              .select({ id: schema.contacts.id, name: schema.contacts.name })
              .from(schema.contacts)
              .where(
                and(
                  eq(schema.contacts.orgId, actor.orgId),
                  inArray(schema.contacts.clientId, definition.clientIds),
                  inArray(schema.contacts.id, [...new Set(contactIds)]),
                ),
              )
          ).map((c) => [c.id, c.name])
        : [],
    );
    for (const c of clients) {
      const mine = devices.filter((d) => d.clientId === c.id);
      const last =
        mine
          .map((d) => iso(d.inventoryAt))
          .filter(Boolean)
          .sort()
          .at(-1) ?? null;
      source(
        `RMM inventory: ${c.name}`,
        'Installed applications and sign-ins from the last RMM inventory. Flags use the client license records.',
        last,
      );
      const missing = mine.filter((d) => !d.inventoryAt).length;
      if (!mine.length) result.warnings.push(`${c.name}: no RMM devices are linked to this client.`);
      else if (missing)
        result.warnings.push(`${c.name}: ${missing} of ${mine.length} devices have not reported software or sign-ins.`);
    }
    section(
      'Summary',
      ['Client', 'Devices reporting', 'Applications', 'End of life', 'Unlicensed', 'Over seats', 'Sign-in accounts'],
      clients.map((c) => {
        const apps = software.get(c.id) ?? [];
        const mine = devices.filter((d) => d.clientId === c.id && d.inventoryAt);
        const accounts = new Set(
          mine.flatMap((d) => ((d.signIns ?? []) as SignIn[]).map((u) => `${u.domain}\\${u.username}`.toLowerCase())),
        );
        return [
          c.name,
          `${mine.length} of ${devices.filter((d) => d.clientId === c.id).length}`,
          String(apps.length),
          String(apps.filter((a) => a.flag === 'end_of_life').length),
          String(apps.filter((a) => a.flag === 'unlicensed').length),
          String(apps.filter((a) => a.flag === 'over_seats').length),
          String(accounts.size),
        ];
      }),
    );
    // Flagged applications first, then the most installed, as on the client's Software tab.
    section(
      'Software',
      ['Client', 'Application', 'Publisher', 'Versions', 'Devices', 'Flag', 'Reason'],
      clients.flatMap((c) =>
        (software.get(c.id) ?? []).map((a) => [
          c.name,
          a.name,
          a.publisher,
          a.versions.join(', '),
          String(a.devices),
          a.flag ? FLAG_LABEL[a.flag] : '',
          a.flagReason,
        ]),
      ),
    );
    section(
      'Sign-ins',
      ['Client', 'Device', 'Account', 'Contact', 'Last sign-in'],
      devices.flatMap((d) =>
        ((d.signIns ?? []) as SignIn[]).map((u) => [
          names.get(d.clientId)!,
          d.name,
          u.domain ? `${u.domain}\\${u.username}` : u.username,
          (u.contactId && contacts.get(u.contactId)) || '',
          u.lastLogonAt ?? 'Not reported',
        ]),
      ),
    );
  }
  if (definition.kind === 'service') {
    // A look back over the chosen period, from midnight UTC that many days ago.
    const since = new Date(Date.parse(today) - definition.withinDays * DAY);
    const periodStart = since.toISOString().slice(0, 10);
    const inPeriod = (d: Date | null) => !!d && d >= since;
    const tickets = await db
      .select({
        clientId: schema.tickets.clientId,
        number: schema.tickets.number,
        summary: schema.tickets.summary,
        priority: schema.tickets.priority,
        status: schema.tickets.status,
        closed: schema.tickets.closed,
        openedAt: schema.tickets.openedAt,
        closedAt: schema.tickets.closedAt,
      })
      .from(schema.tickets)
      .where(
        and(
          selected(schema.tickets),
          or(
            eq(schema.tickets.closed, false),
            gte(schema.tickets.openedAt, since),
            gte(schema.tickets.closedAt, since),
          ),
        ),
      )
      .orderBy(asc(schema.tickets.openedAt))
      .limit(MAX_REPORT_ROWS + 1);
    const runs = await db
      .select({
        clientId: schema.checklistRuns.clientId,
        title: schema.checklistRuns.title,
        completedAt: schema.checklistRuns.completedAt,
      })
      .from(schema.checklistRuns)
      .where(and(selected(schema.checklistRuns), gte(schema.checklistRuns.completedAt, since)))
      .orderBy(asc(schema.checklistRuns.completedAt))
      .limit(MAX_REPORT_ROWS + 1);
    const added = await db
      .select({ clientId: schema.assets.clientId })
      .from(schema.assets)
      .where(and(selected(schema.assets), eq(schema.assets.archived, false), gte(schema.assets.createdAt, since)))
      .limit(MAX_REPORT_ROWS + 1);
    // Password entries (even their names) are for people who can use the client's vault, as in the activity feed.
    // They are counted here but never listed.
    const vaultIds = [...(await scope.levels())].filter(([, l]) => l === 'edit_passwords').map(([id]) => id);
    const changes = await db
      .select({
        clientId: schema.activity.clientId,
        actorName: schema.activity.actorName,
        action: schema.activity.action,
        entityType: schema.activity.entityType,
        entityId: schema.activity.entityId,
        title: schema.activity.title,
        createdAt: schema.activity.createdAt,
      })
      .from(schema.activity)
      .where(
        and(
          eq(schema.activity.orgId, actor.orgId),
          inArray(schema.activity.clientId, definition.clientIds),
          gte(schema.activity.createdAt, since),
          vaultIds.length
            ? or(ne(schema.activity.entityType, 'password'), inArray(schema.activity.clientId, vaultIds))
            : ne(schema.activity.entityType, 'password'),
        ),
      )
      .orderBy(desc(schema.activity.createdAt))
      .limit(MAX_REPORT_ROWS + 1);
    if ([tickets, runs, added, changes].some((list) => list.length > MAX_REPORT_ROWS))
      throw new HttpError(422, 'This report is too large. Choose fewer clients or a shorter period.');
    const snapshots = await db
      .select({
        clientId: schema.rmmHealthSnapshots.clientId,
        day: schema.rmmHealthSnapshots.day,
        counts: schema.rmmHealthSnapshots.counts,
      })
      .from(schema.rmmHealthSnapshots)
      .where(and(selected(schema.rmmHealthSnapshots), gte(schema.rmmHealthSnapshots.day, periodStart)))
      .orderBy(asc(schema.rmmHealthSnapshots.day));
    source(
      'Atlas tickets',
      'Tickets synced from ConnectWise: opened or closed in the period, and any still open.',
      tickets
        .map((t) => iso(t.closedAt ?? t.openedAt))
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
    );
    source('Atlas checklists', 'Checklist runs completed in the period.');
    source(
      'Atlas activity',
      'Changes recorded in Atlas in the period. Password changes are counted for clients whose vault you can use, and never listed.',
    );
    source(
      'RMM health history',
      'Daily device health snapshots from the RMM sync: the first day in the period against the latest.',
      snapshots.length ? dayOf(snapshots.at(-1)!.day) : null,
    );
    const docTypes = new Set(['document', 'checklist']);
    section(
      `Service summary, ${periodStart} to ${today}`,
      [
        'Client',
        'Tickets opened',
        'Tickets closed',
        'Open tickets',
        'Checklists completed',
        'Documentation updated',
        'Assets added',
        'Changes recorded',
      ],
      clients.map((c) => {
        const mine = changes.filter((a) => a.clientId === c.id);
        const theirs = tickets.filter((t) => t.clientId === c.id);
        return [
          c.name,
          String(theirs.filter((t) => inPeriod(t.openedAt)).length),
          String(theirs.filter((t) => t.closed && inPeriod(t.closedAt)).length),
          String(theirs.filter((t) => !t.closed).length),
          String(runs.filter((r) => r.clientId === c.id).length),
          String(new Set(mine.filter((a) => docTypes.has(a.entityType)).map((a) => a.entityId)).size),
          String(added.filter((a) => a.clientId === c.id).length),
          String(mine.length),
        ];
      }),
    );
    // Device health: the first snapshot in the period against the latest, as "before → now".
    const trend = (before: number, now: number) => (before === now ? String(now) : `${before} → ${now}`);
    section(
      'Device health trend',
      ['Client', 'From', 'To', 'Devices', 'Online', 'Protection running', 'Offline servers'],
      clients.map((c) => {
        const days = snapshots.filter((s) => s.clientId === c.id);
        if (!days.length) return [c.name, 'Not available', '', '', '', '', ''];
        const first = days[0]!.counts as RmmHealthCounts;
        const last = days.at(-1)!.counts as RmmHealthCounts;
        return [
          c.name,
          dayOf(days[0]!.day),
          dayOf(days.at(-1)!.day),
          trend(first.total, last.total),
          trend(first.online, last.online),
          trend(first.protectionRunning, last.protectionRunning),
          trend(first.offlineServers, last.offlineServers),
        ];
      }),
    );
    for (const c of clients.filter((c) => !snapshots.some((s) => s.clientId === c.id)))
      result.warnings.push(`${c.name}: no RMM health history is available for this period.`);
    section(
      'Tickets',
      ['Client', 'Ticket', 'Summary', 'Priority', 'Status', 'Opened', 'Closed'],
      tickets.map((t) => [
        names.get(t.clientId!)!,
        t.number,
        t.summary,
        t.priority,
        t.closed ? 'Closed' : t.status || 'Open',
        iso(t.openedAt),
        iso(t.closedAt),
      ]),
    );
    section(
      'Completed checklists',
      ['Client', 'Checklist', 'Completed'],
      runs.map((r) => [names.get(r.clientId!)!, r.title, iso(r.completedAt)]),
    );
    const listed = changes.filter((a) => a.entityType !== 'password');
    if (listed.length > MAX_ACTIVITY_ROWS)
      result.warnings.push(
        `Activity lists the latest ${MAX_ACTIVITY_ROWS.toLocaleString('en-US')} of ${listed.length.toLocaleString('en-US')} changes. The summary counts them all.`,
      );
    section(
      'Activity',
      ['Client', 'When', 'Who', 'Action', 'Item'],
      listed
        .slice(0, MAX_ACTIVITY_ROWS)
        .map((a) => [names.get(a.clientId!)!, iso(a.createdAt), a.actorName, a.action, a.title]),
    );
  }
  if (
    result.sections.reduce((n, s) => n + s.rows.length, 0) > MAX_REPORT_ROWS ||
    Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024
  )
    throw new HttpError(422, 'This report is too large. Choose fewer clients.');
  return result;
}
