import type { LayoutField } from '@atlas/shared';
import { dateValue, type Collector } from './context.js';

/** Asset expiry dates and subscription renewals up to the report's lookahead, overdue ones included. */
export const renewals: Collector = async (report) => {
  const assets = await report.assets();
  const licenses = await report.licenses();
  const { today, cutoff } = report;
  const rows: string[][] = [];
  for (const a of assets)
    for (const f of a.layoutFields as LayoutField[]) {
      const value = (a.fields as Record<string, unknown>)[f.key];
      if (f.type === 'date' && f.expires && dateValue(value) && value <= cutoff)
        rows.push([
          report.client(a.clientId),
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
        report.client(l.clientId),
        l.name,
        'Subscription renewal',
        l.renewalDate,
        l.renewalDate < today ? 'Overdue' : 'Upcoming',
        l.autoRenew ? 'Auto-renew enabled' : 'Manual tracking',
      ]);
  rows.sort((a, b) => a[3]!.localeCompare(b[3]!) || a[0]!.localeCompare(b[0]!));
  report.section(
    `Renewals through ${cutoff} (including overdue)`,
    ['Client', 'Item', 'Type', 'Due date', 'Status', 'Source / renewal'],
    rows,
  );
  report.warn(
    'Microsoft reseller renewal dates are not supplied by the GDAP directory API. Missing dates are not treated as no renewal risk.',
  );
};
