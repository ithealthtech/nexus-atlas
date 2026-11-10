import { describe, expect, it } from 'vitest';
import { alertReminder, alertRuleFires, dateSeverity, type AlertEvent, type AlertRule } from '../src/index.js';

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
