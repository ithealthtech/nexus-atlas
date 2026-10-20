import { z } from 'zod';

export const REPORT_KINDS = [
  'executive',
  'security',
  'assets',
  'licenses',
  'renewals',
  'documentation',
  'endpoints',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_INFO: Record<ReportKind, { name: string; description: string }> = {
  executive: {
    name: 'Executive summary',
    description: 'Assets, documentation, subscriptions, and endpoint coverage at a glance.',
  },
  security: {
    name: 'Security posture',
    description: 'Password health, endpoint protection, disk encryption, and automatic password rotation.',
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
    if (['Password issues', 'Breached', 'Not encrypted', 'Rotation failing'].includes(column)) return Number(value) > 0;
    if (column === 'Issues') return value !== '';
    if (column === 'Encryption') return value === 'Not encrypted' || value === 'Unknown';
    if (column === 'Last result') return value === 'Failed';
    return false;
  });
}
export function selectReportSection(snapshot: ReportSnapshot, selection: ReportSelection): ReportSection {
  const source = snapshot.sections[selection.section];
  if (!source) throw new Error('Choose a report section.');
  const columns = selection.columns ?? source.columns.map((_, i) => i);
  if (
    columns.some((i) => i >= source.columns.length) ||
    (selection.field !== undefined && selection.field >= source.columns.length)
  )
    throw new Error('Choose valid report columns.');
  const query = selection.query.trim().toLocaleLowerCase();
  const rows = source.rows.filter(
    (row) =>
      (!selection.attention || reportNeedsAttention(source, row)) &&
      (!query ||
        (selection.field === undefined ? row.join(' ') : (row[selection.field] ?? ''))
          .toLocaleLowerCase()
          .includes(query)),
  );
  return {
    title: source.title,
    columns: columns.map((i) => source.columns[i]!),
    rows: rows.map((row) => columns.map((i) => row[i] ?? '')),
  };
}
