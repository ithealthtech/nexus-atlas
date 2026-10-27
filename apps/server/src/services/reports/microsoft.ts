import { gdapClient } from '../../routes/m365-gdap.js';
import type { M365Account, M365Client } from '../integrations/m365.js';
import { USAGE_DAYS, concealed, usagePeriod, type UsageReport } from '../integrations/m365-usage.js';
import type { Collector, ReportContext } from './context.js';

/**
 * The clients in the report with a Microsoft 365 tenant linked, and a client that reads them through GDAP (never
 * application credentials). Clients without one, or a connection that isn't GDAP, get a notice and are left out.
 */
export async function gdapTenants(
  report: ReportContext,
  { quiet = false } = {},
): Promise<{ microsoft: M365Client; linked: { id: string; name: string; tenantId: string }[] } | null> {
  const saved = await report.settings.m365(report.actor.orgId);
  // Reports that only add Microsoft evidence (quiet) don't warn about clients without a tenant.
  if (!quiet)
    for (const c of report.clients.filter((c) => !saved?.tenants[c.id]))
      report.warn(`${c.name}: no Microsoft 365 tenant is linked.`);
  const linked = report.clients
    .filter((c) => saved?.tenants[c.id])
    .map((c) => ({ ...c, tenantId: saved!.tenants[c.id]!.tenantId }));
  if (!linked.length) return null;
  if (saved?.authMode !== 'gdap') {
    report.warn('Microsoft 365 is unavailable: the connection must use GDAP. Application credentials were not used.');
    return null;
  }
  try {
    return { microsoft: await gdapClient(report.settings, report.actor.orgId, report.fetcher, true), linked };
  } catch {
    report.warn('Microsoft 365 is unavailable. Check the GDAP connection and refresh the report.');
    return null;
  }
}

// ---------- accounts ----------
export const ACCOUNT_SUMMARY_COLUMNS = [
  'Client',
  'Accounts',
  'Members',
  'Guests',
  'Enabled',
  'Blocked',
  'Licensed',
  'Unlicensed',
  'Blocked & licensed',
  'No usage location',
  'Without MFA',
];
export const ACCOUNT_COLUMNS = [
  'Client',
  'Name',
  'Sign-in name',
  'Status',
  'Type',
  'Licenses',
  'Usage location',
  'MFA',
];
const MFA_TEXT = { registered: 'Registered', not_registered: 'Not registered' } as const;
/** An enabled member account that hasn't registered a second factor; guests use their own organization's MFA. */
const withoutMfa = (a: M365Account) => a.enabled && !a.guest && a.mfa === 'not_registered';

/** One client's line in the account summary. "No usage location" counts licensed accounts only: that's when it matters. */
export function accountSummary(client: string, accounts: M365Account[]): string[] {
  const n = (test: (a: M365Account) => boolean) => String(accounts.filter(test).length);
  return [
    client,
    String(accounts.length),
    n((a) => !a.guest),
    n((a) => a.guest),
    n((a) => a.enabled),
    n((a) => !a.enabled),
    n((a) => a.licenses > 0),
    n((a) => a.licenses === 0),
    n((a) => !a.enabled && a.licenses > 0),
    n((a) => a.licenses > 0 && !a.usageLocation),
    accounts.some((a) => a.mfa) ? n(withoutMfa) : 'Not read',
  ];
}
export const accountRow = (client: string, a: M365Account): string[] => [
  client,
  a.name,
  a.upn,
  a.enabled ? 'Enabled' : 'Blocked',
  a.guest ? 'Guest' : 'Member',
  String(a.licenses),
  a.usageLocation,
  a.mfa ? MFA_TEXT[a.mfa] : 'Not read',
];

/**
 * For each client with a Microsoft 365 tenant, its enabled member accounts and how many have registered MFA. Clients
 * without a tenant, or whose registration report couldn't be read, are left out.
 */
export async function mfaCoverage(
  report: ReportContext,
): Promise<Map<string, { accounts: number; registered: number }>> {
  const out = new Map<string, { accounts: number; registered: number }>();
  const found = await gdapTenants(report, { quiet: true });
  for (const c of found?.linked ?? []) {
    try {
      const people = (
        await withMfa(report, found!.microsoft, c.tenantId, c.name, await found!.microsoft.accounts(c.tenantId))
      ).filter((a) => a.enabled && !a.guest);
      if (!people.some((a) => a.mfa)) continue;
      out.set(c.id, { accounts: people.length, registered: people.filter((a) => a.mfa === 'registered').length });
      report.source(`Microsoft 365 MFA: ${c.name}`, 'MFA registration of enabled member accounts, read through GDAP.');
    } catch (e) {
      report.warn(`${c.name}: Microsoft 365 accounts could not be read. ${(e as Error).message}`);
    }
  }
  return out;
}

/** Each account with its MFA registration, where Microsoft's report could be read; a warning says why when not. */
export async function withMfa(
  report: ReportContext,
  microsoft: M365Client,
  tenantId: string,
  client: string,
  accounts: M365Account[],
): Promise<M365Account[]> {
  try {
    const mfa = await microsoft.mfaRegistration(tenantId);
    return accounts.map((a) => {
      const found = mfa.get(a.upn.toLowerCase());
      return found ? { ...a, mfa: found.registered ? 'registered' : 'not_registered' } : a;
    });
  } catch (e) {
    report.warn(`${client}: MFA registration could not be read. ${(e as Error).message}`);
    return accounts;
  }
}

/** Each linked tenant's accounts: who can sign in, who's a guest, and blocked accounts still holding licenses. */
export const accounts: Collector = async (report) => {
  const found = await gdapTenants(report);
  const read: { client: string; accounts: M365Account[] }[] = [];
  for (const c of found?.linked ?? []) {
    try {
      const listed = await found!.microsoft.accounts(c.tenantId);
      read.push({ client: c.name, accounts: await withMfa(report, found!.microsoft, c.tenantId, c.name, listed) });
      report.source(
        `Microsoft 365: ${c.name}`,
        'Accounts read through GDAP: state, type, licenses, usage location, and MFA registration.',
      );
    } catch (e) {
      report.warn(`${c.name}: Microsoft 365 accounts could not be read. ${(e as Error).message}`);
    }
  }
  report.section(
    'Account summary',
    ACCOUNT_SUMMARY_COLUMNS,
    read.map((r) => accountSummary(r.client, r.accounts)),
  );
  report.section(
    'Accounts',
    ACCOUNT_COLUMNS,
    read.flatMap((r) =>
      // Blocked accounts with licenses first, then by name.
      [...r.accounts]
        .sort(
          (a, b) =>
            Number(b.licenses > 0 && !b.enabled) - Number(a.licenses > 0 && !a.enabled) || a.name.localeCompare(b.name),
        )
        .map((a) => accountRow(r.client, a)),
    ),
  );
};

// ---------- usage ----------
type Row = Record<string, string>;
const latest = (...dates: string[]) => dates.filter(Boolean).sort().at(-1) ?? '';
const num = (value: string | undefined) => String(Number(value ?? 0) || 0);

/** What each section of the usage report reads from Microsoft, and how a row of it becomes a line in Atlas. */
export const USAGE_SECTIONS: {
  report: UsageReport;
  title: string;
  columns: string[];
  row: (client: string, r: Row) => string[];
}[] = [
  {
    report: 'email',
    title: 'Email (Exchange)',
    columns: ['Client', 'Name', 'Sign-in name', 'Last activity', 'Sent', 'Received', 'Read'],
    row: (client, r) => [
      client,
      r['Display Name'] ?? '',
      r['User Principal Name'] ?? '',
      r['Last Activity Date'] || 'Never',
      num(r['Send Count']),
      num(r['Receive Count']),
      num(r['Read Count']),
    ],
  },
  {
    report: 'teams',
    title: 'Teams',
    columns: ['Client', 'Name', 'Sign-in name', 'Last activity', 'Chat messages', 'Calls', 'Meetings'],
    row: (client, r) => [
      client,
      r['Display Name'] ?? '',
      r['User Principal Name'] ?? '',
      r['Last Activity Date'] || 'Never',
      String(Number(num(r['Team Chat Message Count'])) + Number(num(r['Private Chat Message Count']))),
      num(r['Call Count']),
      num(r['Meeting Count']),
    ],
  },
  {
    report: 'onedrive',
    title: 'OneDrive',
    columns: [
      'Client',
      'Name',
      'Sign-in name',
      'Last activity',
      'Viewed or edited',
      'Synced',
      'Shared inside',
      'Shared outside',
    ],
    row: (client, r) => [
      client,
      r['Display Name'] ?? '',
      r['User Principal Name'] ?? '',
      r['Last Activity Date'] || 'Never',
      num(r['Viewed Or Edited File Count']),
      num(r['Synced File Count']),
      num(r['Shared Internally File Count']),
      num(r['Shared Externally File Count']),
    ],
  },
  {
    report: 'sharepoint',
    title: 'SharePoint',
    columns: [
      'Client',
      'Name',
      'Sign-in name',
      'Last activity',
      'Viewed or edited',
      'Synced',
      'Pages visited',
      'Shared outside',
    ],
    row: (client, r) => [
      client,
      r['Display Name'] ?? '',
      r['User Principal Name'] ?? '',
      r['Last Activity Date'] || 'Never',
      num(r['Viewed Or Edited File Count']),
      num(r['Synced File Count']),
      num(r['Visited Page Count']),
      num(r['Shared Externally File Count']),
    ],
  },
  {
    report: 'apps',
    title: 'Microsoft 365 apps',
    columns: ['Client', 'Sign-in name', 'Last activity', 'Windows', 'Mac', 'Mobile', 'Web'],
    row: (client, r) => [
      client,
      r['User Principal Name'] ?? '',
      r['Last Activity Date'] || 'Never',
      r['Windows'] || 'No',
      r['Mac'] || 'No',
      r['Mobile'] || 'No',
      r['Web'] || 'No',
    ],
  },
];

export const USAGE_SUMMARY_COLUMNS = [
  'Client',
  'Licensed accounts',
  'Active',
  'Inactive',
  'Email',
  'Teams',
  'OneDrive',
  'SharePoint',
];
export const ACTIVE_COLUMNS = [
  'Client',
  'Name',
  'Sign-in name',
  'Active',
  'Last active',
  'Email',
  'Teams',
  'OneDrive',
  'SharePoint',
];

/**
 * From Microsoft's active-user detail: each licensed account, whether it did anything in the period, and its last
 * activity in each app. Deleted accounts are left out.
 */
export function activeRows(client: string, rows: Row[]): string[][] {
  return rows
    .filter((r) => r['Is Deleted'] !== 'True')
    .map((r) => {
      const last = latest(
        r['Exchange Last Activity Date'] ?? '',
        r['Teams Last Activity Date'] ?? '',
        r['OneDrive Last Activity Date'] ?? '',
        r['SharePoint Last Activity Date'] ?? '',
        r['Yammer Last Activity Date'] ?? '',
      );
      return [
        client,
        r['Display Name'] ?? '',
        r['User Principal Name'] ?? '',
        last ? 'Yes' : 'No',
        last || 'Never',
        r['Exchange Last Activity Date'] || '—',
        r['Teams Last Activity Date'] || '—',
        r['OneDrive Last Activity Date'] || '—',
        r['SharePoint Last Activity Date'] || '—',
      ];
    })
    .sort((a, b) => a[3]!.localeCompare(b[3]!) || a[1]!.localeCompare(b[1]!));
}
/** One client's line in the usage summary, from its active-user rows (as `activeRows` makes them). */
export function usageSummary(client: string, active: string[][]): string[] {
  const used = (i: number) => String(active.filter((r) => r[i] && r[i] !== '—').length);
  const activeCount = active.filter((r) => r[3] === 'Yes').length;
  return [
    client,
    String(active.length),
    String(activeCount),
    String(active.length - activeCount),
    used(5),
    used(6),
    used(7),
    used(8),
  ];
}

/** Microsoft 365 usage for each linked tenant: overall, then each app, in one report. */
export const usage: Collector = async (report) => {
  const period = usagePeriod(report.definition.withinDays);
  if (report.definition.withinDays > USAGE_DAYS[period])
    report.warn(
      `Microsoft keeps ${USAGE_DAYS[period]} days of usage, so this report covers the last ${USAGE_DAYS[period]} days.`,
    );
  const found = await gdapTenants(report);
  const summary: string[][] = [];
  const active: string[][] = [];
  const sections = new Map(USAGE_SECTIONS.map((s) => [s.report, [] as string[][]]));
  for (const c of found?.linked ?? []) {
    try {
      const rows = activeRows(c.name, await found!.microsoft.usage(c.tenantId, 'active', period));
      summary.push(usageSummary(c.name, rows));
      active.push(...rows);
      if (rows.some((r) => concealed(r[2]!)))
        report.warn(
          `${c.name}: Microsoft is hiding names in this tenant's usage reports. To see them, turn off "Display concealed user, group, and site names in all reports" in the Microsoft 365 admin center (Settings > Org settings > Reports).`,
        );
      for (const s of USAGE_SECTIONS)
        sections
          .get(s.report)!
          .push(
            ...(await found!.microsoft.usage(c.tenantId, s.report, period))
              .filter((r) => r['Is Deleted'] !== 'True')
              .map((r) => s.row(c.name, r)),
          );
      report.source(
        `Microsoft 365 usage: ${c.name}`,
        `Microsoft's usage reports for the last ${USAGE_DAYS[period]} days, read through GDAP. Microsoft's figures can be a day or two behind.`,
      );
    } catch (e) {
      report.warn(`${c.name}: Microsoft 365 usage could not be read. ${(e as Error).message}`);
    }
  }
  report.section('Usage summary', USAGE_SUMMARY_COLUMNS, summary);
  report.section('Active users', ACTIVE_COLUMNS, active);
  for (const s of USAGE_SECTIONS) report.section(s.title, s.columns, sections.get(s.report)!);
};
