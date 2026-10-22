import { and, asc, desc, eq, gte, inArray, ne, or } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { RmmHealthCounts } from '@atlas/shared';
import { DAY, MAX_REPORT_ROWS, capped, iso, newest, type Collector } from './context.js';

/** How many activity entries a service review lists; the summary still counts them all. */
const MAX_ACTIVITY_ROWS = 2000;
const dayOf = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value));
/** A number at the start of the period against now, as "before → now". */
const trend = (before: number, now: number) => (before === now ? String(now) : `${before} → ${now}`);
const shorterPeriod = 'Choose fewer clients or a shorter period.';

/** What was done for each client over the chosen period, and how its devices fared. */
export const service: Collector = async (report) => {
  const { db, actor, definition, today } = report;
  // A look back over the chosen period, from midnight UTC that many days ago.
  const since = new Date(Date.parse(today) - definition.withinDays * DAY);
  const periodStart = since.toISOString().slice(0, 10);
  const inPeriod = (d: Date | null) => !!d && d >= since;
  const tickets = capped(
    await db
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
          report.selected(schema.tickets),
          or(
            eq(schema.tickets.closed, false),
            gte(schema.tickets.openedAt, since),
            gte(schema.tickets.closedAt, since),
          ),
        ),
      )
      .orderBy(asc(schema.tickets.openedAt))
      .limit(MAX_REPORT_ROWS + 1),
    shorterPeriod,
  );
  const runs = capped(
    await db
      .select({
        clientId: schema.checklistRuns.clientId,
        title: schema.checklistRuns.title,
        completedAt: schema.checklistRuns.completedAt,
      })
      .from(schema.checklistRuns)
      .where(and(report.selected(schema.checklistRuns), gte(schema.checklistRuns.completedAt, since)))
      .orderBy(asc(schema.checklistRuns.completedAt))
      .limit(MAX_REPORT_ROWS + 1),
    shorterPeriod,
  );
  const added = capped(
    await db
      .select({ clientId: schema.assets.clientId })
      .from(schema.assets)
      .where(
        and(report.selected(schema.assets), eq(schema.assets.archived, false), gte(schema.assets.createdAt, since)),
      )
      .limit(MAX_REPORT_ROWS + 1),
    shorterPeriod,
  );
  // Password entries (even their names) are for people who can use the client's vault, as in the activity feed.
  // They are counted here but never listed.
  const vaultIds = [...(await report.scope.levels())].filter(([, l]) => l === 'edit_passwords').map(([id]) => id);
  const changes = capped(
    await db
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
      .limit(MAX_REPORT_ROWS + 1),
    shorterPeriod,
  );
  const snapshots = await db
    .select({
      clientId: schema.rmmHealthSnapshots.clientId,
      day: schema.rmmHealthSnapshots.day,
      counts: schema.rmmHealthSnapshots.counts,
    })
    .from(schema.rmmHealthSnapshots)
    .where(and(report.selected(schema.rmmHealthSnapshots), gte(schema.rmmHealthSnapshots.day, periodStart)))
    .orderBy(asc(schema.rmmHealthSnapshots.day));

  report.source(
    'Atlas tickets',
    'Tickets synced from ConnectWise: opened or closed in the period, and any still open.',
    newest(tickets.map((t) => t.closedAt ?? t.openedAt)),
  );
  report.source('Atlas checklists', 'Checklist runs completed in the period.');
  report.source(
    'Atlas activity',
    'Changes recorded in Atlas in the period. Password changes are counted for clients whose vault you can use, and never listed.',
  );
  report.source(
    'RMM health history',
    'Daily device health snapshots from the RMM sync: the first day in the period against the latest.',
    snapshots.length ? dayOf(snapshots.at(-1)!.day) : null,
  );

  const docTypes = new Set(['document', 'checklist']);
  report.section(
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
    report.clients.map((c) => {
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
  report.section(
    'Device health trend',
    ['Client', 'From', 'To', 'Devices', 'Online', 'Protection running', 'Offline servers'],
    report.clients.map((c) => {
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
  for (const c of report.clients.filter((c) => !snapshots.some((s) => s.clientId === c.id)))
    report.warn(`${c.name}: no RMM health history is available for this period.`);
  report.section(
    'Tickets',
    ['Client', 'Ticket', 'Summary', 'Priority', 'Status', 'Opened', 'Closed'],
    tickets.map((t) => [
      report.client(t.clientId),
      t.number,
      t.summary,
      t.priority,
      t.closed ? 'Closed' : t.status || 'Open',
      iso(t.openedAt),
      iso(t.closedAt),
    ]),
  );
  report.section(
    'Completed checklists',
    ['Client', 'Checklist', 'Completed'],
    runs.map((r) => [report.client(r.clientId), r.title, iso(r.completedAt)]),
  );
  // A review pack goes to the client: it keeps the count of changes, not the internal change log.
  if (definition.kind === 'review') return;
  const listed = changes.filter((a) => a.entityType !== 'password');
  if (listed.length > MAX_ACTIVITY_ROWS)
    report.warn(
      `Activity lists the latest ${MAX_ACTIVITY_ROWS.toLocaleString('en-US')} of ${listed.length.toLocaleString('en-US')} changes. The summary counts them all.`,
    );
  report.section(
    'Activity',
    ['Client', 'When', 'Who', 'Action', 'Item'],
    listed
      .slice(0, MAX_ACTIVITY_ROWS)
      .map((a) => [report.client(a.clientId), iso(a.createdAt), a.actorName, a.action, a.title]),
  );
};
