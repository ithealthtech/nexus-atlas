import { and, asc, desc, eq, gte, inArray, ne, or } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import type { LayoutField, ReportDefinition, ReportSnapshot, RmmHealthCounts } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { requireClient } from '../authz.js';
import { gdapClient } from '../routes/m365-gdap.js';
import type { SettingsService } from './settings.js';
import type { Scope } from './scope.js';

export const MAX_REPORT_ROWS = 10_000;
const DAY = 86_400_000;
const iso = (value: Date | null) => value?.toISOString() ?? '';
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
