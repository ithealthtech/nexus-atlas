import { z } from 'zod';

export const REPORT_KINDS = ['executive', 'assets', 'licenses', 'renewals', 'documentation', 'endpoints'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_INFO: Record<ReportKind, { name: string; description: string }> = {
  executive: {
    name: 'Executive summary',
    description: 'Assets, documentation, subscriptions, and endpoint coverage at a glance.',
  },
  assets: {
    name: 'Asset inventory',
    description: 'Asset records, types, status, and when they were last updated.',
  },
  licenses: {
    name: 'License utilization',
    description: 'Purchased, assigned, and available seats; manual costs and GDAP inventory.',
  },
  renewals: {
    name: 'Upcoming renewals',
    description: 'Subscription renewals and asset expiration dates, including overdue items.',
  },
  documentation: {
    name: 'Documentation health',
    description: 'Review dates, outdated articles, and documentation needing attention.',
  },
  endpoints: {
    name: 'Endpoint health',
    description: 'RMM online status, last check-in, and endpoint protection coverage.',
  },
};
export const reportDefinitionSchema = z.object({
  kind: z.enum(REPORT_KINDS),
  title: z.string().trim().min(1).max(120),
  clientIds: z
    .array(z.uuid().transform((id) => id.toLowerCase()))
    .min(1, 'Choose at least one client.')
    .max(25, 'Choose up to 25 clients per report.')
    .refine((ids) => new Set(ids).size === ids.length, 'Choose each client once.'),
  withinDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180), z.literal(365)]).default(90),
  includeMicrosoft: z.boolean().default(true),
});
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export const reportTemplateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  definition: reportDefinitionSchema,
});
export interface ReportTemplateView extends z.infer<typeof reportTemplateSchema> {
  id: string;
  version: number;
  updatedAt: string;
}
export interface ReportSection {
  title: string;
  columns: string[];
  rows: string[][];
}
export interface ReportSnapshot {
  schemaVersion: 1;
  organization: string;
  definition: ReportDefinition;
  generatedAt: string;
  generatedBy: string;
  clients: { id: string; name: string }[];
  sources: { name: string; updatedAt: string | null; detail: string }[];
  warnings: string[];
  sections: ReportSection[];
}
export interface ReportRunView {
  id: string;
  title: string;
  kind: ReportKind;
  createdAt: string;
  clients: { id: string; name: string }[];
  warningCount: number;
  rowCount: number;
}
export interface ReportRunDetail extends ReportRunView {
  snapshot: ReportSnapshot;
}

export const reportSelectionSchema = z.object({
  section: z.number().int().min(0).max(20).default(0),
  query: z.string().max(200).default(''),
  field: z.number().int().min(0).max(30).optional(),
  columns: z
    .array(z.number().int().min(0).max(30))
    .min(1)
    .max(30)
    .refine((v) => new Set(v).size === v.length)
    .optional(),
  attention: z.boolean().default(false),
});
export type ReportSelection = z.infer<typeof reportSelectionSchema>;

/** Shared by the workspace and exports so they show exactly the same rows and columns. */
export function reportNeedsAttention(section: ReportSection, row: string[]): boolean {
  return section.columns.some((column, i) => {
    const value = row[i] ?? '';
    if (column === 'Attention') return value !== 'No date-based issue detected';
    if (column === 'Online') return value !== 'Online';
    if (column === 'Protection') return !['running', 'protected', 'healthy'].includes(value.toLowerCase());
    if (column === 'Status')
      return ['overdue', 'outdated', 'inactive', 'suspended', 'warning'].includes(value.toLowerCase());
    if (['Reviews overdue', 'Offline', 'Protection missing / stopped', 'Unknown protection'].includes(column))
      return Number(value) > 0 || value === 'Not available';
    if (column === 'Available') return Number(value) <= 0;
    return false;
  });
}
export function selectReportSection(
  snapshot: ReportSnapshot,
  selection: ReportSelection,
): ReportSection & { indexes: number[] } {
  const source = snapshot.sections[selection.section];
  if (!source) throw new Error('Choose a report section.');
  const columns = selection.columns ?? source.columns.map((_, i) => i);
  if (
    columns.some((i) => i >= source.columns.length) ||
    (selection.field !== undefined && selection.field >= source.columns.length)
  )
    throw new Error('Choose valid report columns.');
  const query = selection.query.trim().toLocaleLowerCase();
  // Where each matching row sits in the section, so a view can line it up with other data (a comparison).
  const indexes = source.rows.flatMap((row, i) =>
    (!selection.attention || reportNeedsAttention(source, row)) &&
    (!query ||
      (selection.field === undefined ? row.join(' ') : (row[selection.field] ?? ''))
        .toLocaleLowerCase()
        .includes(query))
      ? [i]
      : [],
  );
  return {
    title: source.title,
    columns: columns.map((i) => source.columns[i]!),
    rows: indexes.map((r) => columns.map((i) => source.rows[r]![i] ?? '')),
    indexes,
  };
}

// ---------- comparing a run with the one before it ----------
/** Columns that move on every capture (check-in times, days left), so a comparison doesn't call them changes. */
const VOLATILE_COLUMNS = new Set([
  'Last updated',
  'Last check-in',
  'Last sync',
  'Last sign-in',
  'Last rotated',
  'Days left',
  'Next due',
]);
/** "Last check" carries the check's date: only OK against Failed is a change. */
const comparable = (column: string, value: string) =>
  column === 'Last check' ? value.replace(/ \d{4}-\d{2}-\d{2}/, '') : value;

export interface ReportSectionDiff {
  /** Rows of the current section that weren't in the previous one (their indexes). */
  added: number[];
  /** Rows in both whose values moved: the current row's index, the columns that moved, and the previous row. */
  changed: { index: number; columns: number[]; previous: string[] }[];
  /** Previous rows no longer present, laid out in the current columns ('' where a column didn't exist). */
  removed: string[][];
}

/**
 * Lines the previous run's section up with the current one: rows match on their first column (the client, in
 * per-client summaries) or, where that repeats, on the first two (client and item). Columns match by name.
 */
export function compareReportSections(previous: ReportSection, current: ReportSection): ReportSectionDiff {
  const from = current.columns.map((c) => previous.columns.indexOf(c));
  const aligned = previous.rows.map((row) => from.map((i) => (i < 0 ? '' : (row[i] ?? ''))));
  const unique = (rows: string[][]) => new Set(rows.map((r) => r[0])).size === rows.length;
  const byFirst = unique(current.rows) && unique(aligned);
  const keys = (rows: string[][]) => {
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const base = byFirst ? (r[0] ?? '') : `${r[0] ?? ''}\u0000${r[1] ?? ''}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n ? `${base}\u0000${n}` : base;
    });
  };
  const before = new Map(keys(aligned).map((k, i) => [k, aligned[i]!]));
  const now = keys(current.rows);
  const diff: ReportSectionDiff = { added: [], changed: [], removed: [] };
  now.forEach((key, index) => {
    const old = before.get(key);
    if (!old) return void diff.added.push(index);
    const row = current.rows[index]!;
    const columns = current.columns.flatMap((column, j) =>
      !VOLATILE_COLUMNS.has(column) &&
      from[j]! >= 0 &&
      comparable(column, row[j] ?? '') !== comparable(column, old[j] ?? '')
        ? [j]
        : [],
    );
    if (columns.length) diff.changed.push({ index, columns, previous: old });
  });
  const present = new Set(now);
  for (const [key, row] of before) if (!present.has(key)) diff.removed.push(row);
  return diff;
}

/** The run to compare with: the same report for the same clients, captured most recently before this one. */
export function previousReportRun<T extends Pick<ReportRunView, 'id' | 'kind' | 'createdAt' | 'clients'>>(
  runs: T[],
  current: Pick<ReportRunView, 'id' | 'kind' | 'createdAt' | 'clients'>,
): T | null {
  const scope = (r: Pick<ReportRunView, 'clients'>) =>
    r.clients
      .map((c) => c.id)
      .sort()
      .join();
  return (
    runs
      .filter((r) => r.id !== current.id && r.kind === current.kind && r.createdAt < current.createdAt)
      .filter((r) => scope(r) === scope(current))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}
