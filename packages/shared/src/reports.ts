import { z } from 'zod';
import { FIELD_TYPES, type FieldType } from './docs.js';

export const REPORT_KINDS = [
  'review',
  'executive',
  'security',
  'insurance',
  'service',
  'assets',
  'licenses',
  'savings',
  'renewals',
  'domains',
  'documentation',
  'endpoints',
  'software',
  'accounts',
  'usage',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_INFO: Record<ReportKind, { name: string; description: string }> = {
  review: {
    name: 'Client review pack',
    description:
      'A quarterly business review for one client in a single branded PDF: executive summary, security posture, service review and renewals.',
  },
  executive: {
    name: 'Executive summary',
    description: 'Assets, documentation, subscriptions, and endpoint coverage at a glance.',
  },
  security: {
    name: 'Security posture',
    description: 'Password health, endpoint protection, disk encryption, and automatic password rotation.',
  },
  insurance: {
    name: 'Cyber insurance readiness',
    description:
      'The questions cyber insurers ask, answered from your records with the evidence for each, and the gaps to close before renewal.',
  },
  service: {
    name: 'Service review',
    description: 'What was done for each client over a period: tickets, checklists, changes, and device health trend.',
  },
  assets: {
    name: 'Asset inventory',
    description: 'Asset records, types, status, and when they were last updated.',
  },
  licenses: {
    name: 'License utilization',
    description: 'Purchased, assigned, and available seats; manual costs and GDAP inventory.',
  },
  savings: {
    name: 'Savings finder',
    description:
      'Unused seats and licenses on blocked accounts, priced per month, and the renewals coming up to cut before they renew.',
  },
  renewals: {
    name: 'Upcoming renewals',
    description: 'Subscription renewals and asset expiration dates, including overdue items.',
  },
  domains: {
    name: 'Domains & SSL',
    description:
      'Registered domains and SSL certificates: expiry, registrar or issuer, and the latest automatic check.',
  },
  documentation: {
    name: 'Documentation health',
    description: 'Review dates, outdated articles, and documentation needing attention.',
  },
  endpoints: {
    name: 'Endpoint health',
    description: 'RMM online status, last check-in, and endpoint protection coverage.',
  },
  accounts: {
    name: 'Microsoft 365 accounts',
    description:
      'Every account in each linked Microsoft 365 tenant: enabled or blocked, member or guest, its licenses, and blocked accounts still holding them.',
  },
  usage: {
    name: 'Microsoft 365 usage',
    description:
      "Who uses Microsoft 365 and how: overall activity, Exchange email, Teams, OneDrive, SharePoint, and the Microsoft 365 apps, from Microsoft's usage reports.",
  },
  software: {
    name: 'Software & sign-ins',
    description: 'Installed software with end-of-life and license flags, and who signs in to each device.',
  },
};
/** The reports a review pack is made of, in order. Each one's sections are marked with its name (`part`). */
export const REVIEW_PACK_PARTS = [
  'executive',
  'security',
  'service',
  'renewals',
] as const satisfies readonly ReportKind[];
/** Asset layout fields an asset inventory can show: everything but long text, which can hold notes and configuration. */
export const REPORTABLE_FIELD_TYPES: readonly FieldType[] = FIELD_TYPES.filter((t) => t !== 'textarea');
export const MAX_REPORT_ASSET_FIELDS = 12;
export const reportDefinitionSchema = z
  .object({
    kind: z.enum(REPORT_KINDS),
    title: z.string().trim().min(1).max(120),
    clientIds: z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .min(1, 'Choose at least one client.')
      .max(25, 'Choose up to 25 clients per report.')
      .refine((ids) => new Set(ids).size === ids.length, 'Choose each client once.'),
    withinDays: z.union([z.literal(30), z.literal(60), z.literal(90), z.literal(180), z.literal(365)]).default(90),
    includeMicrosoft: z.boolean().default(true),
    /** Extra Asset inventory columns, each "layout key:field key". */
    assetFields: z
      .array(z.string().regex(/^[a-z0-9_-]{1,60}:[a-z][a-z0-9_]{0,39}$/))
      .max(MAX_REPORT_ASSET_FIELDS, `Choose up to ${MAX_REPORT_ASSET_FIELDS} asset fields.`)
      .refine((v) => new Set(v).size === v.length, 'Choose each asset field once.')
      .optional(),
  })
  .refine((d) => d.kind !== 'review' || d.clientIds.length === 1, {
    message: 'A review pack is for one client.',
    path: ['clientIds'],
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

// ---------- scheduled reports ----------
export const REPORT_CADENCES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];
export const REPORT_CADENCE_LABELS: Record<ReportCadence, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every quarter',
};
/**
 * When a run is emailed. With "attention" or "new", a schedule works as an alert: a daily security posture report
 * that sends only when something new needs review tells you about a breached password or a device that lost its
 * protection, and stays quiet otherwise.
 */
export const REPORT_SEND_WHEN = ['always', 'attention', 'new'] as const;
export type ReportSendWhen = (typeof REPORT_SEND_WHEN)[number];
export const REPORT_SEND_WHEN_LABELS: Record<ReportSendWhen, string> = {
  always: 'Every time',
  attention: 'Only when something needs review',
  new: 'Only when something new needs review',
};
export const MAX_SCHEDULE_RECIPIENTS = 20;
export const reportScheduleSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the schedule.').max(120),
    definition: reportDefinitionSchema,
    cadence: z.enum(REPORT_CADENCES),
    /** Weekly: the day of the week, 0 (Sunday) to 6. Monthly and quarterly: the day of the month, 1 to 28. */
    day: z.number().int().min(0).max(28),
    /** The hour it goes out, 0 to 23, in the server's time zone. */
    hour: z.number().int().min(0).max(23).default(7),
    recipients: z
      .array(z.string().trim().toLowerCase().max(254).email('Enter valid email addresses.'))
      .min(1, 'Add at least one recipient.')
      .max(MAX_SCHEDULE_RECIPIENTS, `Send to up to ${MAX_SCHEDULE_RECIPIENTS} people.`)
      .refine((list) => new Set(list).size === list.length, 'List each recipient once.'),
    /** Attach the whole report as a branded PDF. */
    attachPdf: z.boolean().default(true),
    /** Include a 30-day link to the report that needs no account (single-client reports only). */
    clientLink: z.boolean().default(false),
    sendWhen: z.enum(REPORT_SEND_WHEN).default('always'),
    enabled: z.boolean().default(true),
  })
  .refine((s) => s.cadence === 'daily' || (s.cadence === 'weekly' ? s.day <= 6 : s.day >= 1), {
    message: 'Choose a day of the week, or a day of the month from 1 to 28.',
    path: ['day'],
  })
  .refine((s) => !s.clientLink || s.definition.clientIds.length === 1, {
    message: 'A client link can only be included for a report about one client.',
    path: ['clientLink'],
  });
export type ReportScheduleInput = z.infer<typeof reportScheduleSchema>;
export interface ReportScheduleView extends ReportScheduleInput {
  id: string;
  version: number;
  nextRunAt: string;
  lastRunAt: string | null;
  /** "quiet": it ran, and nothing (or nothing new) needed review, so nothing was sent. */
  lastStatus: 'sent' | 'failed' | 'quiet' | null;
  /** What went wrong last time, or which recipients a partly failed delivery missed. */
  lastError: string;
  /** The snapshot the last delivery sent, in the owner's history. */
  lastRunId: string | null;
}

/** One email a schedule sent or tried to send. */
export interface ReportDeliveryView {
  id: string;
  recipient: string;
  status: 'sent' | 'failed';
  /** Why it wasn't delivered. */
  error: string;
  trigger: 'schedule' | 'manual' | 'resend';
  createdAt: string;
  /** False once the snapshot it sent has left the owner's history: there is nothing left to resend. */
  canResend: boolean;
}

/**
 * When a schedule next runs, strictly after `after`: in the server's local time, at the schedule's hour on its day.
 * Quarterly schedules run in January, April, July and October. Days stop at 28 so every month has one.
 */
export function nextReportRun(schedule: Pick<ReportScheduleInput, 'cadence' | 'day' | 'hour'>, after: Date): Date {
  const at = (year: number, month: number, date: number) => new Date(year, month, date, schedule.hour, 0, 0, 0);
  const y = after.getFullYear();
  const m = after.getMonth();
  if (schedule.cadence === 'daily') {
    const today = at(y, m, after.getDate());
    return today > after ? today : at(y, m, after.getDate() + 1);
  }
  if (schedule.cadence === 'weekly') {
    const today = at(y, m, after.getDate());
    let ahead = (schedule.day - today.getDay() + 7) % 7;
    if (ahead === 0 && today <= after) ahead = 7;
    return at(y, m, after.getDate() + ahead);
  }
  const step = schedule.cadence === 'quarterly' ? 3 : 1;
  // The first month of this period, then onward until the date is after `after`.
  let month = schedule.cadence === 'quarterly' ? m - (m % 3) : m;
  let next = at(y, month, schedule.day);
  while (next <= after) {
    month += step;
    next = at(y, month, schedule.day);
  }
  return next;
}
export interface ReportSection {
  title: string;
  /** In a review pack, the report this section belongs to (its name, such as "Security posture"). */
  part?: string;
  columns: string[];
  rows: string[][];
  /**
   * The Atlas page for each row (same order as `rows`), opened from the row's name in the second column. In-app only
   * (see REPORT_LINK); never part of a link shared with the client, an export or a PDF.
   */
  links?: (string | null)[];
}
/** The pages a report row may link to: an asset, a document, or a client (and its tabs). */
export const REPORT_LINK = /^\/(?:assets|documents|clients)\/[0-9a-f-]{36}(?:\/[a-z-]+)?$/;
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

// ---------- sharing a report by link ----------
export const createReportShareSchema = z.object({
  /** Days until the link stops working. Report links always expire. */
  expiresDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).default(30),
});
export interface ReportShareView {
  id: string;
  url: string;
  createdByName: string | null;
  createdAt: string;
  expiresAt: string;
  views: number;
  lastViewedAt: string | null;
  status: 'active' | 'expired' | 'revoked';
}
/** What someone with a report link sees: the snapshot's contents and whose it is. No people or internal IDs. */
export interface SharedReport {
  title: string;
  organization: string;
  client: string;
  generatedAt: string;
  expiresAt: string;
  sections: ReportSection[];
  warnings: string[];
  sources: ReportSnapshot['sources'];
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

/** Sections in order, grouped by the report each belongs to in a review pack (`part`, '' otherwise). */
export function reportSectionGroups(sections: ReportSection[]) {
  const groups: { part: string; items: { section: ReportSection; index: number }[] }[] = [];
  sections.forEach((section, index) => {
    const part = section.part ?? '';
    if (groups.at(-1)?.part !== part) groups.push({ part, items: [] });
    groups.at(-1)!.items.push({ section, index });
  });
  return groups;
}

// ---------- the figures at the top of a report ----------
export interface ReportHighlight {
  label: string;
  value: string;
  /** How the figure reads: worth a look ('warning'), fine ('success'), or just a figure. */
  tone?: 'warning' | 'success';
}

const count = (value: string | undefined) => {
  const n = Number((value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
/** Microsoft's free and trial products report 10,000 or more seats: they aren't seats anyone bought. */
const UNLIMITED_SEATS = 10_000;

/** Adds money written as "USD 1,234.00" (or several, joined by " + "), keeping each currency apart. */
export function addMoney(values: string[]): string {
  const totals = new Map<string, number>();
  for (const value of values)
    for (const [, currency, amount] of value.matchAll(/([A-Z]{3}) (-?[\d,]+(?:\.\d+)?)/g))
      totals.set(currency!, (totals.get(currency!) ?? 0) + Number(amount!.replace(/,/g, '')));
  if (!totals.size) return '—';
  return [...totals]
    .map(
      ([currency, amount]) =>
        `${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    )
    .join(' + ');
}

/**
 * The few figures a report leads with, from its sections: seats and how full they are for a license report, money
 * going to waste for the savings finder, and for every report how many rows need review and how many clients it covers.
 */
export function reportHighlights(
  snapshot: Pick<ReportSnapshot, 'definition' | 'sections' | 'clients'>,
): ReportHighlight[] {
  const { sections } = snapshot;
  const column = (section: ReportSection, name: string) => section.columns.indexOf(name);
  const total = (names: string[], filter: (s: ReportSection) => boolean = () => true) =>
    sections.filter(filter).reduce((sum, s) => {
      const i = names.map((n) => column(s, n)).find((x) => x >= 0) ?? -1;
      return i < 0 ? sum : sum + s.rows.reduce((n, r) => n + count(r[i]), 0);
    }, 0);
  const review = sections.reduce((n, s) => n + s.rows.filter((r) => reportNeedsAttention(s, r)).length, 0);
  const common: ReportHighlight[] = [
    { label: 'Needs review', value: String(review), tone: review ? 'warning' : 'success' },
    { label: snapshot.clients.length === 1 ? 'Client' : 'Clients', value: String(snapshot.clients.length) },
  ];

  if (snapshot.definition.kind === 'licenses') {
    const seated = (s: ReportSection) => column(s, 'Assigned') >= 0;
    // Seats per row, leaving out free products (which would swamp the totals).
    let seats = 0;
    let assigned = 0;
    let products = 0;
    for (const s of sections.filter(seated)) {
      const seatColumn = [column(s, 'Seats'), column(s, 'Enabled seats')].find((i) => i >= 0) ?? -1;
      for (const row of s.rows) {
        products++;
        const bought = count(row[seatColumn]);
        if (bought >= UNLIMITED_SEATS) continue;
        seats += bought;
        assigned += count(row[column(s, 'Assigned')]);
      }
    }
    const available = Math.max(0, seats - assigned);
    return [
      { label: 'Products', value: String(products) },
      { label: 'Seats purchased', value: seats.toLocaleString('en-US') },
      { label: 'Assigned', value: assigned.toLocaleString('en-US') },
      { label: 'Available', value: available.toLocaleString('en-US'), tone: available ? 'warning' : undefined },
      { label: 'In use', value: seats ? `${Math.round((assigned / seats) * 100)}%` : '—' },
      common[0]!,
    ];
  }
  if (snapshot.definition.kind === 'accounts') {
    const summary = sections.find((s) => s.title === 'Account summary');
    const sum = (name: string) => String(total([name], (s) => s === summary));
    return [
      { label: 'Accounts', value: sum('Accounts') },
      { label: 'Enabled', value: sum('Enabled') },
      { label: 'Blocked', value: sum('Blocked') },
      { label: 'Licensed', value: sum('Licensed') },
      { label: 'Guests', value: sum('Guests') },
      common[0]!,
    ];
  }
  if (snapshot.definition.kind === 'usage') {
    const summary = sections.find((s) => s.title === 'Usage summary');
    const sum = (name: string) => total([name], (s) => s === summary);
    const inactive = sum('Inactive');
    return [
      { label: 'Licensed accounts', value: String(sum('Licensed accounts')) },
      { label: 'Active', value: String(sum('Active')) },
      { label: 'Inactive', value: String(inactive), tone: inactive ? 'warning' : 'success' },
      { label: 'Email', value: String(sum('Email')) },
      { label: 'Teams', value: String(sum('Teams')) },
      { label: 'OneDrive', value: String(sum('OneDrive')) },
    ];
  }
  if (snapshot.definition.kind === 'savings') {
    const summary = sections.find((s) => s.title === 'Savings summary');
    const money = (name: string) =>
      summary && column(summary, name) >= 0 ? addMoney(summary.rows.map((r) => r[column(summary, name)] ?? '')) : '—';
    const reclaim = total(['Seats to reclaim'], (s) => s === summary);
    return [
      { label: 'Seats to reclaim', value: String(reclaim), tone: reclaim ? 'warning' : 'success' },
      { label: 'Monthly waste', value: money('Monthly waste') },
      { label: 'Yearly waste', value: money('Yearly waste') },
      { label: 'Renewals due', value: String(total(['Renewals due'], (s) => s === summary)) },
      common[0]!,
    ];
  }
  return [
    { label: 'Records', value: sections.reduce((n, s) => n + s.rows.length, 0).toLocaleString('en-US') },
    ...common,
    ...(sections.length > 1 ? [{ label: 'Sections', value: String(sections.length) }] : []),
  ];
}

/** Shared by the workspace and exports so they show exactly the same rows and columns. */
export function reportNeedsAttention(section: ReportSection, row: string[]): boolean {
  return section.columns.some((column, i) => {
    const value = row[i] ?? '';
    if (column === 'Attention') return value !== 'No date-based issue detected';
    // A device's state; a health trend's "Online" holds counts ("35 → 38"), which aren't a problem in themselves.
    if (column === 'Online') return value === 'Offline' || value === 'Unknown';
    if (column === 'Protection') return !['running', 'protected', 'healthy'].includes(value.toLowerCase());
    // A blocked Microsoft 365 account matters while it still holds licenses; a licensed one needs a usage location.
    if (column === 'Status' && section.columns.includes('Licenses'))
      return value === 'Blocked' && count(row[section.columns.indexOf('Licenses')]) > 0;
    if (column === 'Usage location') return !value && count(row[section.columns.indexOf('Licenses')]) > 0;
    // A licensed account with no activity in the period.
    if (column === 'Active') return value === 'No';
    if (['Blocked & licensed', 'No usage location', 'Inactive'].includes(column)) return Number(value) > 0;
    if (column === 'Status')
      return ['overdue', 'outdated', 'inactive', 'suspended', 'warning', 'expired', 'expiring soon'].includes(
        value.toLowerCase(),
      );
    if (['Reviews overdue', 'Offline', 'Protection missing / stopped', 'Unknown protection'].includes(column))
      return Number(value) > 0 || value === 'Not available';
    if (column === 'Available') return Number(value) <= 0;
    if (['Password issues', 'Breached', 'Not encrypted', 'Rotation failing'].includes(column)) return Number(value) > 0;
    if (column === 'Issues') return value !== '';
    if (column === 'Encryption') return value === 'Not encrypted' || value === 'Unknown';
    if (column === 'Last result') return value === 'Failed';
    // Money being spent on nothing: unused seats, and what they cost.
    if (['Unused', 'Seats to reclaim'].includes(column)) return Number(value) > 0;
    if (['Monthly waste', 'Monthly cost'].includes(column)) return /[1-9]/.test(value);
    // An insurer's question answered anything but Yes, and the counts of those answers.
    if (column === 'Answer') return value !== 'Yes';
    if (['Partly', 'No', 'Not evidenced'].includes(column)) return Number(value) > 0;
    // Below "Good" (see healthGrade): needs attention or at risk.
    if (column === 'Health score') return /^\d+$/.test(value) && Number(value) < 75;
    if (
      [
        'Expired domains',
        'Expiring domains',
        'Expired certificates',
        'Expiring certificates',
        'Failed checks',
      ].includes(column)
    )
      return Number(value) > 0;
    if (column === 'Last check') return value.startsWith('Failed');
    if (['End of life', 'Unlicensed', 'Over seats'].includes(column)) return Number(value) > 0;
    if (column === 'Flag') return value !== '';
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

/**
 * The rows of a snapshot that need review now but didn't in an earlier one: new rows that need review, and rows
 * that newly need it. Sections are matched by position, as reports always list them in the same order.
 */
export function newAttention(previous: ReportSnapshot | null, current: ReportSnapshot) {
  const found: { section: string; row: string[] }[] = [];
  current.sections.forEach((section, i) => {
    const flagged = (row: string[]) => reportNeedsAttention(section, row);
    const before = previous?.sections[i];
    if (!before) {
      for (const row of section.rows) if (flagged(row)) found.push({ section: section.title, row });
      return;
    }
    const diff = compareReportSections(before, section);
    for (const index of diff.added)
      if (flagged(section.rows[index]!)) found.push({ section: section.title, row: section.rows[index]! });
    for (const change of diff.changed) {
      const row = section.rows[change.index]!;
      if (flagged(row) && !reportNeedsAttention(section, change.previous)) found.push({ section: section.title, row });
    }
  });
  return found;
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
