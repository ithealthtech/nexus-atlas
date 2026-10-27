import { DAY, iso, type Collector } from './context.js';

/** Every current article, and whether its review is overdue, flagged, or long untouched. */
export const documentation: Collector = async (report) => {
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
    documents.map((d) => `/documents/${d.id}`),
  );
};
