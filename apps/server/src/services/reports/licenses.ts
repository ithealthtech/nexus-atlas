import type { MicrosoftLicenseView } from '@atlas/shared';
import type { Collector, ReportContext } from './context.js';
import { gdapTenants } from './microsoft.js';

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
    rows.map((l) => `/clients/${l.clientId}/licenses`),
  );
  if (report.definition.includeMicrosoft) await microsoftSeats(report);
  else report.warn('Microsoft 365 inventory was excluded from this snapshot.');
};

/**
 * Each linked client's Microsoft 365 subscriptions and licensed users, through GDAP only: no application
 * credentials, and no guessed seat counts. Clients that can't be read get a notice and are left out.
 */
export async function microsoftInventory(report: ReportContext): Promise<Map<string, MicrosoftLicenseView>> {
  const found = new Map<string, MicrosoftLicenseView>();
  const tenants = await gdapTenants(report);
  if (!tenants) return found;
  const { microsoft, linked } = tenants;
  for (const c of linked) {
    try {
      const data = await microsoft.licenses(c.tenantId);
      report.source(
        `Microsoft 365: ${c.name}`,
        'Read through GDAP. Purchased enabled seats and assignment totals; pricing and renewal dates are not provided.',
        data.checkedAt,
      );
      found.set(c.id, data);
    } catch {
      report.warn(
        `${c.name}: Microsoft inventory could not be read through GDAP. No application fallback or inferred seat counts were used.`,
      );
    }
  }
  return found;
}

/** Seats per linked tenant. */
async function microsoftSeats(report: ReportContext) {
  const inventory = await microsoftInventory(report);
  if (!inventory.size) return;
  report.section(
    'Microsoft 365 via GDAP',
    ['Client', 'Product', 'Status', 'Enabled seats', 'Assigned', 'Available'],
    [...inventory].flatMap(([clientId, data]) =>
      data.skus.map((sku) => [
        report.client(clientId),
        sku.name,
        sku.status,
        String(sku.enabled),
        String(sku.assigned),
        String(Math.max(0, sku.enabled - sku.assigned)),
      ]),
    ),
  );
}
