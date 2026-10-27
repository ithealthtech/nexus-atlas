import { and, count, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { DAY, iso, type Collector, type ReportContext } from './context.js';

/**
 * What each client has documented at all: contacts, locations, assets, passwords, and articles, with the kinds that
 * have nothing yet named as gaps. Counts only, never content.
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
  report.section(
    'Documentation coverage',
    ['Client', ...kinds.map(([label]) => label), 'Gaps'],
    report.clients.map((c) => {
      const counts = kinds.map(([, m]) => m.get(c.id) ?? 0);
      const gaps = kinds.filter((_, i) => !counts[i]).map(([label]) => label.toLowerCase());
      return [report.client(c.id), ...counts.map(String), gaps.length ? `No ${gaps.join(', ')}` : 'None'];
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
    if (Date.parse(report.generatedAt) - d.updatedAt.getTime() > 180 * DAY) return 'Not updated in 180 days';
    return 'No date-based issue detected';
  };
  report.section(
    'Documentation health',
    ['Client', 'Article', 'Status', 'Review due', 'Last updated', 'Attention'],
    documents.map((d) => [
      report.client(d.clientId),
      d.title,
      d.status,
      d.reviewDate ?? 'Not recorded',
      iso(d.updatedAt),
      attention(d),
    ]),
  );
};
