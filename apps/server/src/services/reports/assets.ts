import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { REPORTABLE_FIELD_TYPES, type LayoutField } from '@atlas/shared';
import { WarrantyService } from '../warranty.js';
import { iso, type Collector, type ReportContext } from './context.js';

/** A layout field's value as one cell. */
const cell = (value: unknown, type: string) => {
  if (value === undefined || value === null || value === '') return '';
  if (type === 'checkbox') return value === true ? 'Yes' : 'No';
  return Array.isArray(value) ? value.join(', ') : String(value);
};

/** The quarter a YYYY-MM-DD date falls in, such as 2027 Q1. */
const quarter = (date: string) => `${date.slice(0, 4)} Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;

/**
 * Hardware whose warranty has run out or runs out in the next four quarters, per client: what to budget for
 * replacing. Nothing is added when no chosen client has warranty dates.
 */
export async function hardwareForecast(report: ReportContext) {
  const chosen = new Set(report.clients.map((c) => c.id));
  const rows = (await new WarrantyService(report.settings).rows(report.scope)).filter((r) => chosen.has(r.clientId));
  if (!rows.some((r) => r.date)) return;
  const quarters: string[] = [];
  for (let m = 0; quarters.length < 4; m += 3) {
    const d = new Date(`${report.today}T00:00:00Z`);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + m);
    quarters.push(quarter(d.toISOString().slice(0, 10)));
  }
  report.section(
    'Hardware replacement forecast',
    ['Client', 'Out of warranty', ...quarters, 'No warranty date'],
    report.clients.flatMap((c) => {
      const mine = rows.filter((r) => r.clientId === c.id);
      if (!mine.length) return [];
      const count = (test: (date: string) => boolean) => String(mine.filter((r) => r.date && test(r.date)).length);
      return [
        [
          report.client(c.id),
          count((d) => d < report.today),
          ...quarters.map((q) => count((d) => d >= report.today && quarter(d) === q)),
          String(mine.filter((r) => !r.date).length),
        ],
      ];
    }),
  );
}

/** Every current asset, with any layout fields chosen for the report as extra columns. */
export const assets: Collector = async (report) => {
  const rows = await report.assets();
  // Chosen fields are read from the layouts as they are now: a field since removed, or turned into long text, is
  // left out rather than guessed at.
  const wanted = report.definition.assetFields ?? [];
  const layoutKeys = [...new Set(wanted.map((w) => w.split(':')[0]!))];
  const layouts = layoutKeys.length
    ? await report.db
        .select({ key: schema.assetLayouts.key, name: schema.assetLayouts.name, fields: schema.assetLayouts.fields })
        .from(schema.assetLayouts)
        .where(and(eq(schema.assetLayouts.orgId, report.actor.orgId), inArray(schema.assetLayouts.key, layoutKeys)))
    : [];
  const columns = wanted.flatMap((id) => {
    const [layoutKey, fieldKey] = id.split(':') as [string, string];
    const layout = layouts.find((l) => l.key === layoutKey);
    const field = (layout?.fields as LayoutField[] | undefined)?.find((f) => f.key === fieldKey);
    if (!layout || !field || !REPORTABLE_FIELD_TYPES.includes(field.type)) {
      report.warn(`The asset field "${id}" no longer exists or can't be reported, so it was left out.`);
      return [];
    }
    return [{ layoutKey, fieldKey, type: field.type, label: `${layout.name}: ${field.label}` }];
  });
  report.section(
    'Asset inventory',
    ['Client', 'Asset', 'Type', 'Status', ...columns.map((c) => c.label), 'Last updated'],
    rows.map((a) => [
      report.client(a.clientId),
      a.name,
      a.layoutName,
      a.status,
      ...columns.map((c) =>
        a.layoutKey === c.layoutKey ? cell((a.fields as Record<string, unknown>)[c.fieldKey], c.type) : '',
      ),
      iso(a.updatedAt),
    ]),
  );
  await hardwareForecast(report);
};
