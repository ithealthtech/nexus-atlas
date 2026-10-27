import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { REPORTABLE_FIELD_TYPES, type LayoutField } from '@atlas/shared';
import { warrantyFields } from '../warranty.js';
import { iso, type Collector, type ReportContext } from './context.js';

/** A layout field's value as one cell. */
const cell = (value: unknown, type: string) => {
  if (value === undefined || value === null || value === '') return '';
  if (type === 'checkbox') return value === true ? 'Yes' : 'No';
  return Array.isArray(value) ? value.join(', ') : String(value);
};

/** The quarter a YYYY-MM-DD date falls in, such as 2027 Q1. */
const quarter = (date: string) => `${date.slice(0, 4)} Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;

/** Devices older than this are due for replacement whatever their warranty says. */
export const HARDWARE_AGE_LIMIT_YEARS = 5;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
/** A layout's purchase date and price fields, found by their names like the warranty date is. */
const purchaseField = (fields: LayoutField[]) =>
  fields.find((f) => f.type === 'date' && /purchas|bought|acqui/i.test(`${f.key} ${f.label}`))?.key;
const priceField = (fields: LayoutField[]) =>
  fields.find((f) => f.type === 'number' && /price|cost|value/i.test(`${f.key} ${f.label}`))?.key;

/**
 * Hardware due for replacement, per client: out of warranty now, running out in each of the next four quarters, or
 * older than HARDWARE_AGE_LIMIT_YEARS from its purchase date; and, where a purchase price is recorded, what replacing
 * all of that would cost at today's prices. Nothing is added when no chosen client has warranty or purchase dates.
 */
export async function hardwareForecast(report: ReportContext) {
  const quarters: string[] = [];
  for (let m = 0; quarters.length < 4; m += 3) {
    const d = new Date(`${report.today}T00:00:00Z`);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + m);
    quarters.push(quarter(d.toISOString().slice(0, 10)));
  }
  const horizon = quarters.at(-1)!;
  const ageCutoff = `${Number(report.today.slice(0, 4)) - HARDWARE_AGE_LIMIT_YEARS}${report.today.slice(4)}`;
  const devices = (await report.assets()).flatMap((a) => {
    const fields = a.layoutFields as LayoutField[];
    const values = a.fields as Record<string, unknown>;
    const warranty =
      warrantyFields(fields)
        .map((k) => values[k])
        .find(isDate) ?? null;
    const purchaseKey = purchaseField(fields);
    const purchased = purchaseKey && isDate(values[purchaseKey]) ? (values[purchaseKey] as string) : null;
    if (!warrantyFields(fields).length && !purchaseKey) return [];
    const priceKey = priceField(fields);
    const price = priceKey ? Number(values[priceKey]) : NaN;
    const old = !!purchased && purchased <= ageCutoff;
    const due = old || (!!warranty && (warranty < report.today || quarter(warranty) <= horizon));
    return [{ clientId: a.clientId, warranty, old, due, price: Number.isFinite(price) && price > 0 ? price : null }];
  });
  if (!devices.some((d) => d.warranty || d.old)) return;
  const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const priced = devices.some((d) => d.price !== null);
  report.section(
    'Hardware replacement forecast',
    [
      'Client',
      'Out of warranty',
      ...quarters,
      `Over ${HARDWARE_AGE_LIMIT_YEARS} years old`,
      'No warranty date',
      ...(priced ? ['Replacement cost'] : []),
    ],
    report.clients.flatMap((c) => {
      const mine = devices.filter((d) => d.clientId === c.id);
      if (!mine.length) return [];
      const count = (test: (date: string) => boolean) =>
        String(mine.filter((d) => d.warranty && test(d.warranty)).length);
      const due = mine.filter((d) => d.due);
      const cost = due.reduce((n, d) => n + (d.price ?? 0), 0);
      const unpriced = due.filter((d) => d.price === null).length;
      return [
        [
          report.client(c.id),
          count((d) => d < report.today),
          ...quarters.map((q) => count((d) => d >= report.today && quarter(d) === q)),
          String(mine.filter((d) => d.old).length),
          String(mine.filter((d) => !d.warranty).length),
          ...(priced
            ? [
                cost
                  ? `${money(cost)}${unpriced ? ` (+${unpriced} without a price)` : ''}`
                  : unpriced
                    ? `${unpriced} without a price`
                    : '0',
              ]
            : []),
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
    rows.map((a) => `/assets/${a.id}`),
  );
  await hardwareForecast(report);
};
