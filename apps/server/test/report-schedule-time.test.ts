import { describe, expect, it } from 'vitest';
import { nextReportRun, reportScheduleSchema } from '@atlas/shared';

// Local times, as the server sees them.
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe('when a scheduled report next runs', () => {
  it('weekly: the next chosen weekday at the hour, a week on once today has passed', () => {
    // 2026-10-20 is a Tuesday (2).
    const tuesday9 = local(2026, 10, 20, 9);
    expect(nextReportRun({ cadence: 'weekly', day: 1, hour: 7 }, tuesday9)).toEqual(local(2026, 10, 26, 7));
    expect(nextReportRun({ cadence: 'weekly', day: 2, hour: 10 }, tuesday9)).toEqual(local(2026, 10, 20, 10));
    expect(nextReportRun({ cadence: 'weekly', day: 2, hour: 9 }, tuesday9)).toEqual(local(2026, 10, 27, 9));
    expect(nextReportRun({ cadence: 'weekly', day: 0, hour: 7 }, local(2026, 12, 30))).toEqual(local(2027, 1, 3, 7));
  });

  it('monthly: the chosen day this month if still ahead, else next month, across the year end', () => {
    expect(nextReportRun({ cadence: 'monthly', day: 1, hour: 7 }, local(2026, 10, 20, 9))).toEqual(
      local(2026, 11, 1, 7),
    );
    expect(nextReportRun({ cadence: 'monthly', day: 28, hour: 7 }, local(2026, 10, 20))).toEqual(
      local(2026, 10, 28, 7),
    );
    expect(nextReportRun({ cadence: 'monthly', day: 5, hour: 7 }, local(2026, 12, 6))).toEqual(local(2027, 1, 5, 7));
    // Exactly at the run time counts as passed, so a delivered run never schedules itself again.
    expect(nextReportRun({ cadence: 'monthly', day: 5, hour: 7 }, local(2026, 10, 5, 7))).toEqual(
      local(2026, 11, 5, 7),
    );
  });

  it('quarterly: January, April, July and October', () => {
    expect(nextReportRun({ cadence: 'quarterly', day: 1, hour: 8 }, local(2026, 10, 20))).toEqual(local(2027, 1, 1, 8));
    expect(nextReportRun({ cadence: 'quarterly', day: 25, hour: 8 }, local(2026, 10, 20))).toEqual(
      local(2026, 10, 25, 8),
    );
    expect(nextReportRun({ cadence: 'quarterly', day: 15, hour: 8 }, local(2026, 2, 3))).toEqual(local(2026, 4, 15, 8));
  });

  it('validates days, recipients and client links', () => {
    const base = {
      name: 'Monthly review',
      definition: { kind: 'service', title: 'Service review', clientIds: ['aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'] },
      cadence: 'monthly',
      day: 1,
      recipients: ['Office.Manager@Harbor.example'],
    };
    const ok = reportScheduleSchema.parse(base);
    expect(ok.recipients).toEqual(['office.manager@harbor.example']);
    expect(ok.hour).toBe(7);
    expect(ok.attachPdf).toBe(true);
    expect(reportScheduleSchema.safeParse({ ...base, day: 0 }).success).toBe(false);
    expect(reportScheduleSchema.safeParse({ ...base, cadence: 'weekly', day: 7 }).success).toBe(false);
    expect(reportScheduleSchema.safeParse({ ...base, recipients: [] }).success).toBe(false);
    expect(reportScheduleSchema.safeParse({ ...base, recipients: ['a@x.example', 'A@x.example'] }).success).toBe(false);
    expect(
      reportScheduleSchema.safeParse({
        ...base,
        clientLink: true,
        definition: {
          ...base.definition,
          clientIds: [...base.definition.clientIds, 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
        },
      }).success,
    ).toBe(false);
  });
});
