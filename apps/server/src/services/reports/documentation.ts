import { and, count, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { DOCUMENT_REVIEW_DAYS, documentFreshness } from '@atlas/shared';
import { DAY, iso, type Collector, type ReportContext } from './context.js';

/**
 * The essentials every client's documentation should have, each checked from the records themselves: titles for
 * documents, layouts for assets, names and categories for passwords (never their contents).
 */
// Each check is given the client ids as a ready-made SQL list, `(id1, id2)`.
const MUST_HAVES: { label: string; check: (ids: SQL, orgId: string) => SQL }[] = [
  {
    label: 'Primary contact',
    check: (ids, orgId) =>
      sql`select client_id from contacts where org_id = ${orgId} and client_id in ${ids} and is_primary`,
  },
  {
    label: 'Location',
    check: (ids, orgId) => sql`select client_id from locations where org_id = ${orgId} and client_id in ${ids}`,
  },
  {
    label: 'Network diagram',
    check: (ids, orgId) =>
      sql`select client_id from documents where org_id = ${orgId} and client_id in ${ids} and not archived
          and title ~* '(diagram|topology|network map)'`,
  },
  {
    label: 'Backup runbook',
    check: (ids, orgId) =>
      sql`select client_id from documents where org_id = ${orgId} and client_id in ${ids} and not archived
          and title ~* '(backup|restore|disaster recovery)'`,
  },
  {
    label: 'Internet provider',
    check: (ids, orgId) =>
      sql`select a.client_id from assets a join asset_layouts l on l.id = a.layout_id
          where a.org_id = ${orgId} and a.client_id in ${ids} and not a.archived and l.key = 'internet'`,
  },
  {
    label: 'Admin accounts',
    check: (ids, orgId) =>
      sql`select client_id from passwords where org_id = ${orgId} and client_id in ${ids} and not archived
          and (name ~* 'admin' or username ~* 'admin')`,
  },
  {
    label: 'Wi-Fi',
    check: (ids, orgId) =>
      sql`select client_id from passwords where org_id = ${orgId} and client_id in ${ids} and not archived
          and category = 'wifi'
          union select a.client_id from assets a join asset_layouts l on l.id = a.layout_id
          where a.org_id = ${orgId} and a.client_id in ${ids} and not a.archived and l.key = 'wireless'`,
  },
];

/**
 * How complete each client's documentation is: the share of MUST_HAVES on record, what's missing, and how many
 * contacts, locations, assets, passwords, and articles there are. Counts and titles only, never content.
 */
export async function documentationCoverage(report: ReportContext) {
  const ids = report.clients.map((c) => c.id);
  if (!ids.length) return;
  const tally = async (table: typeof schema.contacts | typeof schema.locations) => {
    const rows = await report.db
      .select({ clientId: table.clientId, n: count() })
      .from(table)
      .where(and(eq(table.orgId, report.actor.orgId), inArray(table.clientId, ids)))
      .groupBy(table.clientId);
    return new Map(rows.map((r) => [r.clientId, r.n]));
  };
  const live = async (table: typeof schema.assets | typeof schema.passwords | typeof schema.documents) => {
    const rows = await report.db
      .select({ clientId: table.clientId, n: count() })
      .from(table)
      .where(and(eq(table.orgId, report.actor.orgId), inArray(table.clientId, ids), eq(table.archived, false)))
      .groupBy(table.clientId);
    return new Map(rows.map((r) => [r.clientId, r.n]));
  };
  const kinds = [
    ['Contacts', await tally(schema.contacts)],
    ['Locations', await tally(schema.locations)],
    ['Assets', await live(schema.assets)],
    ['Passwords', await live(schema.passwords)],
    ['Articles', await live(schema.documents)],
  ] as const;
  const list = sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
  const have = await Promise.all(
    MUST_HAVES.map(async (m) => {
      const rows = (await report.db.execute(m.check(list, report.actor.orgId))).rows as { client_id: string }[];
      return new Set(rows.map((r) => r.client_id));
    }),
  );
  report.section(
    'Documentation coverage',
    ['Client', 'Coverage', ...kinds.map(([label]) => label), 'Missing'],
    report.clients.map((c) => {
      const missing = MUST_HAVES.filter((_, i) => !have[i]!.has(c.id)).map((m) => m.label);
      const percent = Math.round(((MUST_HAVES.length - missing.length) / MUST_HAVES.length) * 100);
      return [
        report.client(c.id),
        `${percent}%`,
        ...kinds.map(([, m]) => String(m.get(c.id) ?? 0)),
        missing.length ? missing.join(', ') : 'Nothing',
      ];
    }),
  );
}

/** Every current article, and whether its review is overdue, flagged, or long untouched. */
export const documentation: Collector = async (report) => {
  await documentationCoverage(report);
  const documents = await report.documents();
  const attention = (d: (typeof documents)[number]) => {
    if (d.reviewDate && d.reviewDate < report.today) return 'Review overdue';
    if (d.status === 'needs_review') return 'Marked for review';
    const fresh = documentFreshness(
      { verifiedAt: d.verifiedAt?.toISOString() ?? null, updatedAt: d.updatedAt.toISOString() },
      Date.parse(report.generatedAt),
    );
    if (fresh.stale) return `Not verified or updated in ${DOCUMENT_REVIEW_DAYS} days`;
    return 'No date-based issue detected';
  };
  report.section(
    'Documentation health',
    ['Client', 'Article', 'Status', 'Review due', 'Last updated', 'Last verified', 'Attention'],
    documents.map((d) => [
      report.client(d.clientId),
      d.title,
      d.status,
      d.reviewDate ?? 'Not recorded',
      iso(d.updatedAt),
      iso(d.verifiedAt) || 'Never',
      attention(d),
    ]),
    documents.map((d) => `/documents/${d.id}`),
  );
};
