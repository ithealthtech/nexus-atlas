import { DOCUMENT_REVIEW_DAYS, documentFreshness } from '@atlas/shared';
import { iso, type Collector } from './context.js';

/** Every current article, and whether its review is overdue, flagged, or long untouched. */
export const documentation: Collector = async (report) => {
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
  );
};
