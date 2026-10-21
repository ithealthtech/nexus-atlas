import { gdapClient } from '../../routes/m365-gdap.js';
import type { Collector, ReportContext } from './context.js';

/** Manually tracked subscriptions, and (when asked) Microsoft 365 seats read through GDAP. */
export const licenses: Collector = async (report) => {
  const rows = await report.licenses();
  report.section(
    'Manually tracked subscriptions',
    ['Client', 'Product', 'Status', 'Seats', 'Assigned', 'Available', 'Cost / billing period', 'Renewal'],
    rows.map((l) => [
      report.client(l.clientId),
      l.name,
      l.status,
      String(l.seats),
      String(l.assignments.length),
      String(Math.max(0, l.seats - l.assignments.length)),
      `${l.currency} ${((l.unitCostCents * l.seats) / 100).toFixed(2)} / ${l.billingCycle}`,
      l.renewalDate ?? 'Not recorded',
    ]),
  );
  if (report.definition.includeMicrosoft) await microsoftSeats(report);
  else report.warn('Microsoft 365 inventory was excluded from this snapshot.');
};

/** Seats per linked tenant, through GDAP only: no application credentials, and no guessed seat counts. */
async function microsoftSeats(report: ReportContext) {
  const saved = await report.settings.m365(report.actor.orgId);
  const linked = report.clients.filter((c) => saved?.tenants[c.id]);
  for (const c of report.clients.filter((c) => !saved?.tenants[c.id]))
    report.warn(`${c.name}: no Microsoft 365 tenant is linked.`);
  if (!linked.length) return;
  if (saved?.authMode !== 'gdap') {
    report.warn(
      'Microsoft inventory is unavailable: the connection must use GDAP. Application credentials were not used.',
    );
    return;
  }
  let microsoft;
  try {
    microsoft = await gdapClient(report.settings, report.actor.orgId, report.fetcher, true);
  } catch {
    report.warn('Microsoft inventory is unavailable. Check the GDAP connection and refresh the report.');
    return;
  }
  const rows: string[][] = [];
  for (const c of linked) {
    try {
      const data = await microsoft.licenses(saved.tenants[c.id]!.tenantId);
      report.source(
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
      report.warn(
        `${c.name}: Microsoft inventory could not be read through GDAP. No application fallback or inferred seat counts were used.`,
      );
    }
  }
  report.section(
    'Microsoft 365 via GDAP',
    ['Client', 'Product', 'Status', 'Enabled seats', 'Assigned', 'Available'],
    rows,
  );
}
