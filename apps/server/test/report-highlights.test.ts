import { describe, expect, it } from 'vitest';
import { addMoney, reportHighlights, type ReportDefinition, type ReportSection } from '@atlas/shared';

const definition = (kind: ReportDefinition['kind']): ReportDefinition => ({
  kind,
  title: 'Report',
  clientIds: ['00000000-0000-4000-8000-000000000001'],
  withinDays: 90,
  includeMicrosoft: true,
});
const clients = [{ id: '00000000-0000-4000-8000-000000000001', name: 'Harbor Dental Group' }];
const value = (highlights: { label: string; value: string }[], label: string) =>
  highlights.find((h) => h.label === label)?.value;

describe('report highlights', () => {
  it('adds money per currency', () => {
    expect(addMoney(['USD 1,200.50', 'USD 99.50 + EUR 10.00', '', 'Not priced'])).toBe('USD 1,300.00 + EUR 10.00');
    expect(addMoney(['', 'Not priced'])).toBe('—');
  });

  it('leads a license report with seats, leaving free products out of the totals', () => {
    const sections: ReportSection[] = [
      {
        title: 'Manually tracked subscriptions',
        columns: ['Client', 'Product', 'Status', 'Seats', 'Assigned', 'Available', 'Cost / billing period', 'Renewal'],
        rows: [['Harbor Dental Group', 'Dentrix', 'Active', '10', '8', '2', 'USD 900.00 / yearly', '2027-01-01']],
      },
      {
        title: 'Microsoft 365 via GDAP',
        columns: ['Client', 'Product', 'Status', 'Enabled seats', 'Assigned', 'Available'],
        rows: [
          ['Harbor Dental Group', 'Microsoft 365 Business Premium', 'Enabled', '20', '17', '3'],
          ['Harbor Dental Group', 'Microsoft Power Automate Free', 'Enabled', '10000', '4', '9996'],
        ],
      },
    ];
    const highlights = reportHighlights({ definition: definition('licenses'), sections, clients });
    expect(value(highlights, 'Products')).toBe('3');
    expect(value(highlights, 'Seats purchased')).toBe('30');
    expect(value(highlights, 'Assigned')).toBe('25');
    expect(value(highlights, 'Available')).toBe('5');
    expect(value(highlights, 'In use')).toBe('83%');
    expect(value(highlights, 'Client')).toBeUndefined();
  });

  it('leads the savings finder with what is going to waste', () => {
    const sections: ReportSection[] = [
      {
        title: 'Savings summary',
        columns: ['Client', 'Seats to reclaim', 'Monthly waste', 'Yearly waste', 'Renewals due', 'Renewal value'],
        rows: [['Harbor Dental Group', '4', 'USD 88.00', 'USD 1,056.00', '1', 'USD 900.00']],
      },
    ];
    const highlights = reportHighlights({ definition: definition('savings'), sections, clients });
    expect(value(highlights, 'Seats to reclaim')).toBe('4');
    expect(value(highlights, 'Monthly waste')).toBe('USD 88.00');
    expect(value(highlights, 'Yearly waste')).toBe('USD 1,056.00');
    expect(value(highlights, 'Renewals due')).toBe('1');
    expect(value(highlights, 'Needs review')).toBe('1');
  });

  it('counts records and what needs review for any other report', () => {
    const sections: ReportSection[] = [
      {
        title: 'Endpoints',
        columns: ['Client', 'Device', 'Type', 'Online', 'Last check-in', 'Protection', 'Last sync'],
        rows: [
          ['Harbor Dental Group', 'HDG-DC-01', 'Server', 'Online', '', 'Running', ''],
          ['Harbor Dental Group', 'HDG-FD-02', 'Workstation', 'Offline', '', 'Running', ''],
        ],
      },
    ];
    const highlights = reportHighlights({ definition: definition('endpoints'), sections, clients });
    expect(highlights.map((h) => [h.label, h.value])).toEqual([
      ['Records', '2'],
      ['Needs review', '1'],
      ['Client', '1'],
    ]);
  });
});
