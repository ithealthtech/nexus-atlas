import { describe, expect, it } from 'vitest';
import { reportHighlights, reportNeedsAttention, type ReportDefinition, type ReportSection } from '@atlas/shared';
import { M365Client, type M365Account } from '../src/services/integrations/m365.js';
import { concealed, parseCsv, usagePeriod } from '../src/services/integrations/m365-usage.js';
import {
  ACCOUNT_COLUMNS,
  ACCOUNT_SUMMARY_COLUMNS,
  ACTIVE_COLUMNS,
  USAGE_SECTIONS,
  USAGE_SUMMARY_COLUMNS,
  accountRow,
  accountSummary,
  activeRows,
  usageSummary,
} from '../src/services/reports/microsoft.js';

const definition = (kind: ReportDefinition['kind']): ReportDefinition => ({
  kind,
  title: 'Report',
  clientIds: ['00000000-0000-4000-8000-000000000001'],
  withinDays: 30,
  includeMicrosoft: true,
});
const clients = [{ id: '00000000-0000-4000-8000-000000000001', name: 'Harbor Dental Group' }];

describe('Microsoft 365 usage reports', () => {
  it('reads Microsoft’s CSV, quotes and all', () => {
    const csv =
      '﻿Report Refresh Date,User Principal Name,Display Name,Assigned Products\r\n' +
      '2026-10-20,ana@harbor.example,"Patel, Anika","Microsoft 365 Business Premium+""Exchange"""\r\n' +
      '2026-10-20,ben@harbor.example,Ben Okafor,"Line one\nline two"\r\n\r\n';
    expect(parseCsv(csv)).toEqual([
      {
        'Report Refresh Date': '2026-10-20',
        'User Principal Name': 'ana@harbor.example',
        'Display Name': 'Patel, Anika',
        'Assigned Products': 'Microsoft 365 Business Premium+"Exchange"',
      },
      {
        'Report Refresh Date': '2026-10-20',
        'User Principal Name': 'ben@harbor.example',
        'Display Name': 'Ben Okafor',
        'Assigned Products': 'Line one\nline two',
      },
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  it('maps the report window to the periods Microsoft keeps', () => {
    expect([30, 60, 90, 180, 365].map(usagePeriod)).toEqual(['D30', 'D90', 'D90', 'D180', 'D180']);
    expect(concealed('3A1F0C9E2B7D4F6A8C0E1B3D5F7A9C2E')).toBe(true);
    expect(concealed('ana@harbor.example')).toBe(false);
  });

  it('follows Microsoft’s download link without the token, and explains a refusal', async () => {
    const asked: { url: string; auth: string | null }[] = [];
    let refuse = false;
    const fetcher = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (refuse)
        return new Response(JSON.stringify({ error: { code: 'Forbidden', message: 'Insufficient privileges' } }), {
          status: 403,
        });
      if (url.startsWith('https://graph.microsoft.com/'))
        return new Response(null, { status: 302, headers: { location: 'https://reports.office.com/data/abc.csv' } });
      return new Response('User Principal Name,Last Activity Date\nana@harbor.example,2026-10-19\n');
    }) as typeof fetch;
    const client = new M365Client('app', 'secret', fetcher, async () => 'delegated-token');
    const rows = await client.usage('00000000-0000-4000-8000-0000000000aa', 'email', 'D30');
    expect(rows).toEqual([{ 'User Principal Name': 'ana@harbor.example', 'Last Activity Date': '2026-10-19' }]);
    expect(asked).toEqual([
      {
        url: "https://graph.microsoft.com/v1.0/reports/getEmailActivityUserDetail(period='D30')",
        auth: 'Bearer delegated-token',
      },
      { url: 'https://reports.office.com/data/abc.csv', auth: null },
    ]);
    refuse = true;
    await expect(client.usage('00000000-0000-4000-8000-0000000000aa', 'teams', 'D30')).rejects.toThrow(
      /Reports\.Read\.All.*Reports Reader/,
    );
  });

  it('builds the accounts report and flags blocked accounts still holding licenses', () => {
    const accounts = [
      { name: 'Anika Patel', upn: 'ana@harbor.example', enabled: true, guest: false, licenses: 2, usageLocation: 'US' },
      {
        name: 'Jordan Smith',
        upn: 'jordan@harbor.example',
        enabled: false,
        guest: false,
        licenses: 1,
        usageLocation: 'US',
      },
      {
        name: 'Old Reception',
        upn: 'old@harbor.example',
        enabled: false,
        guest: false,
        licenses: 0,
        usageLocation: '',
      },
      { name: 'Scanner', upn: 'scan@harbor.example', enabled: true, guest: false, licenses: 1, usageLocation: '' },
      { name: 'Auditor', upn: 'audit_ext#@harbor.example', enabled: true, guest: true, licenses: 0, usageLocation: '' },
    ];
    expect(accountSummary('Harbor Dental Group', accounts)).toEqual([
      'Harbor Dental Group',
      '5',
      '4',
      '1',
      '3',
      '2',
      '3',
      '2',
      '1',
      '1',
      // Microsoft's MFA registration report wasn't read for these.
      'Not read',
    ]);
    const section: ReportSection = {
      title: 'Accounts',
      columns: ACCOUNT_COLUMNS,
      rows: accounts.map((a) => accountRow('Harbor Dental Group', a)),
    };
    // Jordan (blocked, licensed) and Scanner (licensed, no usage location) need review; the others don't.
    expect(section.rows.filter((r) => reportNeedsAttention(section, r)).map((r) => r[1])).toEqual([
      'Jordan Smith',
      'Scanner',
    ]);
    const summary: ReportSection = {
      title: 'Account summary',
      columns: ACCOUNT_SUMMARY_COLUMNS,
      rows: [accountSummary('Harbor Dental Group', accounts)],
    };
    const highlights = reportHighlights({ definition: definition('accounts'), sections: [summary, section], clients });
    expect(highlights.map((h) => [h.label, h.value])).toEqual([
      ['Accounts', '5'],
      ['Enabled', '3'],
      ['Blocked', '2'],
      ['Licensed', '3'],
      ['Guests', '1'],
      ['Needs review', '3'],
    ]);
  });

  it('shows MFA registration, and flags enabled members without it', () => {
    const people: M365Account[] = [
      {
        name: 'Avery',
        upn: 'avery@h.example',
        enabled: true,
        guest: false,
        licenses: 1,
        usageLocation: 'US',
        mfa: 'registered',
      },
      {
        name: 'Blake',
        upn: 'blake@h.example',
        enabled: true,
        guest: false,
        licenses: 1,
        usageLocation: 'US',
        mfa: 'not_registered',
      },
      {
        name: 'Casey',
        upn: 'casey@h.example',
        enabled: false,
        guest: false,
        licenses: 0,
        usageLocation: '',
        mfa: 'not_registered',
      },
      {
        name: 'Guest',
        upn: 'g_ext#@h.example',
        enabled: true,
        guest: true,
        licenses: 0,
        usageLocation: '',
        mfa: 'not_registered',
      },
      { name: 'Unread', upn: 'new@h.example', enabled: true, guest: false, licenses: 1, usageLocation: 'US' },
    ];
    const section: ReportSection = {
      title: 'Accounts',
      columns: ACCOUNT_COLUMNS,
      rows: people.map((a) => accountRow('H', a)),
    };
    expect(section.rows.map((r) => r.at(-1))).toEqual([
      'Registered',
      'Not registered',
      'Not registered',
      'Not registered',
      'Not read',
    ]);
    // Only Blake: enabled, a member, and without MFA. A blocked account or a guest isn't flagged.
    expect(section.rows.filter((r) => reportNeedsAttention(section, r)).map((r) => r[1])).toEqual(['Blake']);
    expect(accountSummary('H', people).at(-1)).toBe('1');
  });

  it('builds the usage report: who was active, in which apps, and who wasn’t', () => {
    const active = activeRows('Harbor Dental Group', [
      {
        'User Principal Name': 'ana@harbor.example',
        'Display Name': 'Anika Patel',
        'Is Deleted': 'False',
        'Exchange Last Activity Date': '2026-10-19',
        'Teams Last Activity Date': '2026-10-20',
        'OneDrive Last Activity Date': '',
        'SharePoint Last Activity Date': '',
      },
      {
        'User Principal Name': 'ben@harbor.example',
        'Display Name': 'Ben Okafor',
        'Is Deleted': 'False',
        'Exchange Last Activity Date': '',
        'Teams Last Activity Date': '',
      },
      { 'User Principal Name': 'gone@harbor.example', 'Display Name': 'Gone', 'Is Deleted': 'True' },
    ]);
    expect(active).toEqual([
      ['Harbor Dental Group', 'Ben Okafor', 'ben@harbor.example', 'No', 'Never', '—', '—', '—', '—'],
      [
        'Harbor Dental Group',
        'Anika Patel',
        'ana@harbor.example',
        'Yes',
        '2026-10-20',
        '2026-10-19',
        '2026-10-20',
        '—',
        '—',
      ],
    ]);
    const summary = usageSummary('Harbor Dental Group', active);
    expect(summary).toEqual(['Harbor Dental Group', '2', '1', '1', '1', '1', '0', '0']);
    const sections: ReportSection[] = [
      { title: 'Usage summary', columns: USAGE_SUMMARY_COLUMNS, rows: [summary] },
      { title: 'Active users', columns: ACTIVE_COLUMNS, rows: active },
    ];
    expect(reportNeedsAttention(sections[1]!, active[0]!)).toBe(true);
    expect(reportNeedsAttention(sections[1]!, active[1]!)).toBe(false);
    expect(
      reportHighlights({ definition: definition('usage'), sections, clients }).map((h) => [h.label, h.value]),
    ).toEqual([
      ['Licensed accounts', '2'],
      ['Active', '1'],
      ['Inactive', '1'],
      ['Email', '1'],
      ['Teams', '1'],
      ['OneDrive', '0'],
    ]);
    const teams = USAGE_SECTIONS.find((s) => s.report === 'teams')!;
    expect(
      teams.row('Harbor Dental Group', {
        'User Principal Name': 'ana@harbor.example',
        'Display Name': 'Anika Patel',
        'Last Activity Date': '2026-10-20',
        'Team Chat Message Count': '12',
        'Private Chat Message Count': '30',
        'Call Count': '4',
        'Meeting Count': '',
      }),
    ).toEqual(['Harbor Dental Group', 'Anika Patel', 'ana@harbor.example', '2026-10-20', '42', '4', '0']);
  });
});
