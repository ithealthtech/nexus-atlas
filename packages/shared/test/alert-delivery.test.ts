import { describe, expect, it } from 'vitest';
import {
  alertReminder,
  alertRuleFires,
  alertSendAt,
  dateSeverity,
  inQuietHours,
  nextLocalHour,
  type AlertEvent,
  type AlertRule,
} from '../src/index.js';

const rule = (over: Partial<AlertRule> = {}): AlertRule => ({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Renewals',
  kind: 'expiration',
  templateId: '00000000-0000-4000-8000-000000000002',
  clientIds: [],
  itemKinds: ['asset'],
  daysBefore: [30, 14, 7],
  includeOverdue: true,
  severities: ['info', 'warning', 'critical'],
  emailUserIds: [],
  teams: true,
  ...over,
});
const event = (over: Partial<AlertEvent> = {}): AlertEvent => ({
  kind: 'expiration',
  key: 'expiration:asset:a1:SSL:2026-12-01',
  clientId: 'c1',
  clientName: 'Harbor Dental',
  itemKind: 'asset',
  itemId: 'a1',
  itemName: 'portal.harbordental.test',
  itemType: 'SSL certificate · Expires',
  dueDate: '2026-12-01',
  daysRemaining: 20,
  severity: 'warning',
  path: '/assets/a1',
  ...over,
});

describe('alert reminders', () => {
  it('fires the nearest reminder an item has reached, once per threshold', () => {
    expect(alertReminder(rule(), 45)).toBeNull();
    expect(alertReminder(rule(), 30)).toEqual({ key: 'day-30', reason: '30-day reminder' });
    expect(alertReminder(rule(), 20)).toEqual({ key: 'day-30', reason: '30-day reminder' });
    expect(alertReminder(rule(), 14)?.key).toBe('day-14');
    // A server that was off on the exact day still sends the reminder the next time it runs.
    expect(alertReminder(rule(), 5)?.key).toBe('day-7');
    expect(alertReminder(rule({ daysBefore: [0] }), 0)).toEqual({ key: 'day-0', reason: 'Due today' });
    expect(alertReminder(rule(), -3)).toEqual({ key: 'overdue', reason: 'Overdue' });
    expect(alertReminder(rule({ includeOverdue: false }), -3)).toBeNull();
  });

  it('matches a rule only for its type, clients, items and severities', () => {
    expect(alertRuleFires(rule(), event())?.reason).toBe('30-day reminder');
    expect(alertRuleFires(rule({ kind: 'review' }), event())).toBeNull();
    expect(alertRuleFires(rule({ clientIds: ['c2'] }), event())).toBeNull();
    expect(alertRuleFires(rule({ itemKinds: ['document'] }), event())).toBeNull();
    expect(alertRuleFires(rule({ severities: ['critical'] }), event())).toBeNull();
    const breach = event({ kind: 'breach', itemKind: 'password', severity: 'critical', daysRemaining: null });
    expect(alertRuleFires(rule({ kind: 'breach', itemKinds: ['password'] }), breach)).toEqual({
      key: 'once',
      reason: 'Found in a breach',
    });
  });

  it('grades dates: within a week or overdue is critical, within 30 days a warning', () => {
    expect([dateSeverity(-1), dateSeverity(7), dateSeverity(8), dateSeverity(30), dateSeverity(31)]).toEqual([
      'critical',
      'critical',
      'warning',
      'warning',
      'info',
    ]);
  });
});

describe('alert timing', () => {
  const schedule = { timeZone: 'America/New_York', quietStart: 18, quietEnd: 8, summaryHour: 9 };
  // 23:30 UTC on 2 Nov 2026 is 18:30 in New York (EST, UTC-5).
  const evening = new Date('2026-11-02T23:30:00Z');
  it('holds routine reminders through quiet hours, never breaches or infections', () => {
    expect(inQuietHours(evening, schedule)).toBe(true);
    expect(inQuietHours(new Date('2026-11-02T15:00:00Z'), schedule)).toBe(false);
    expect(alertSendAt(evening, 'expiration', 'each', schedule).toISOString()).toBe('2026-11-03T13:00:00.000Z');
    expect(alertSendAt(evening, 'breach', 'each', schedule)).toBe(evening);
    expect(alertSendAt(evening, 'infection', 'daily', schedule)).toBe(evening);
    expect(inQuietHours(evening, { ...schedule, quietStart: 0, quietEnd: 0 })).toBe(false);
  });
  it('sends daily summaries at the summary hour, or straight away during it', () => {
    expect(alertSendAt(evening, 'review', 'daily', schedule).toISOString()).toBe('2026-11-03T14:00:00.000Z');
    const nine = new Date('2026-11-03T14:20:00Z');
    expect(nextLocalHour(nine, 'America/New_York', 9)).toBe(nine);
  });
});
