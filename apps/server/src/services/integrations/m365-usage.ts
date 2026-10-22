/**
 * Microsoft 365's usage reports (Graph /reports) come as CSV: a header row of names, then one row per user. This
 * reads them into rows of named values. Quoted values may hold commas, quotes ("") and line breaks.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  // Microsoft starts the file with a byte-order mark.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        value += '"';
        i++;
      } else if (c === '"') quoted = false;
      else value += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(value);
      value = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += c;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((v) => v !== ''));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((name, i) => [name.trim(), (r[i] ?? '').trim()])));
}

/** The periods Microsoft keeps usage for. A longer window is read as the longest it has. */
export type UsagePeriod = 'D7' | 'D30' | 'D90' | 'D180';
export const usagePeriod = (days: number): UsagePeriod => (days <= 7 ? 'D7' : days <= 30 ? 'D30' : days <= 90 ? 'D90' : 'D180');
export const USAGE_DAYS: Record<UsagePeriod, number> = { D7: 7, D30: 30, D90: 90, D180: 180 };

/**
 * When a tenant hides names in its reports (the Microsoft 365 admin center's "Display concealed user, group, and
 * site names in all reports"), each user reads as a 32-character code instead of a name.
 */
export const concealed = (upn: string) => /^[0-9A-F]{32}$/i.test(upn);

/** The usage reports Atlas reads, and the Graph function for each. */
export const USAGE_REPORTS = {
  active: 'getOffice365ActiveUserDetail',
  email: 'getEmailActivityUserDetail',
  teams: 'getTeamsUserActivityUserDetail',
  onedrive: 'getOneDriveActivityUserDetail',
  sharepoint: 'getSharePointActivityUserDetail',
  apps: 'getM365AppUserDetail',
} as const;
export type UsageReport = keyof typeof USAGE_REPORTS;
