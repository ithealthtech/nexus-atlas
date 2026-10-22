import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { REPORTABLE_FIELD_TYPES, type LayoutField } from '@atlas/shared';
import { iso, type Collector } from './context.js';

/** A layout field's value as one cell. */
const cell = (value: unknown, type: string) => {
  if (value === undefined || value === null || value === '') return '';
  if (type === 'checkbox') return value === true ? 'Yes' : 'No';
  return Array.isArray(value) ? value.join(', ') : String(value);
};

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
};
