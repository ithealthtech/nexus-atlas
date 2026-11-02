import { z } from 'zod';
import type { AlertKind, AlertRule, AlertSeverity } from './alerting.js';

// ---------- live delivery from the alerting center ----------
/**
 * Which alerts an organization sends: the classic ones (expiry emails, the Bitdefender infection email, and Teams
 * notifications set up under Teams), or the published alerting center rules. Only one is ever live, so switching
 * never sends the same alert twice.
 */
export const ALERT_DELIVERY_MODES = ['classic', 'center'] as const;
export type AlertDeliveryMode = (typeof ALERT_DELIVERY_MODES)[number];

/** What stops sending when the alerting center goes live, for the confirmation and the docs. */
export const CLASSIC_ALERTS_REPLACED = [
  'Expiring soon emails (the daily alert emails; the Monday digest keeps coming)',
  'Bitdefender infection emails',
  'Teams notifications for expirations, document reviews, password breaches and infections',
];

export const alertDeliveryModeSchema = z.object({
  mode: z.enum(ALERT_DELIVERY_MODES),
  /** Going live needs an explicit yes; switching back doesn't. */
  confirm: z.boolean().default(false),
  /**
   * Also send reminders that are already due when going live. Off by default, since the classic alerts most likely
   * sent them already.
   */
  sendDue: z.boolean().default(false),
});

export const ALERT_DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'uncertain', 'skipped'] as const;
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];
export const ALERT_DELIVERY_STATUS_LABELS: Record<AlertDeliveryStatus, string> = {
  pending: 'Waiting',
  sending: 'Sending',
  sent: 'Sent',
  failed: 'Failed',
  uncertain: 'Check before retrying',
  skipped: 'Not sent',
};
export type AlertChannel = 'email' | 'teams';

export interface AlertDeliveryState {
  mode: AlertDeliveryMode;
  /** When and by whom the current mode was chosen; null while the organization has never switched. */
  since: string | null;
  by: string | null;
  /** The newest published version: what sends while the center is live. */
  publishedVersion: number | null;
  publishedRules: number;
  email: boolean;
  teams: boolean;
  /** The last 7 days. */
  counts: Record<'sent' | 'failed' | 'uncertain' | 'pending' | 'skipped', number>;
}

export interface AlertDeliveryView {
  id: string;
  test: boolean;
  version: number | null;
  ruleName: string;
  kind: AlertKind;
  clientId: string | null;
  clientName: string | null;
  itemName: string;
  channel: AlertChannel;
  destination: string;
  subject: string;
  /** Why it was sent, such as "14-day reminder" or "Found in a breach". */
  reason: string;
  link: string;
  status: AlertDeliveryStatus;
  attempts: number;
  error: string;
  createdAt: string;
  sentAt: string | null;
}
export interface AlertDeliveryPage {
  deliveries: AlertDeliveryView[];
  /** Pass as `before` for the next page, or null at the end. */
  nextBefore: string | null;
}
export const alertDeliveryQuerySchema = z.object({
  status: z.enum(ALERT_DELIVERY_STATUSES).optional(),
  before: z.string().datetime().optional(),
});
export const alertRetrySchema = z.object({ confirmUncertain: z.boolean().default(false) });

export const alertTestSendSchema = z.object({
  /** A template from the saved drafts, so it can be tried before publishing. */
  templateId: z.string().uuid(),
  channel: z.enum(['email', 'teams']),
  /** Teams needs a client whose channel to post in; email goes to the person sending the test. */
  clientId: z.string().uuid().nullable().default(null),
});

/** What the published rules would send right now, without sending anything: checked before going live. */
export interface AlertDryRun {
  version: number | null;
  events: number;
  matches: {
    ruleName: string;
    kind: AlertKind;
    clientName: string;
    itemName: string;
    reason: string;
    destinations: { channel: AlertChannel; label: string; ready: boolean; detail: string; alreadySent: boolean }[];
  }[];
}

// ---------- events and matching ----------
/** Something real Atlas knows about that a rule can alert on. */
export interface AlertEvent {
  kind: AlertKind;
  /** Stable identity of what happened, without the reminder: an item and its date, a password change, an endpoint. */
  key: string;
  clientId: string;
  clientName: string;
  itemKind: 'asset' | 'document' | 'password';
  itemId: string;
  /** Safe to show: never a password, a restricted entry's name, or a secret. */
  itemName: string;
  itemType: string;
  dueDate: string | null;
  daysRemaining: number | null;
  severity: AlertSeverity;
  path: string;
}

/** How urgent a date is: overdue or within a week is critical, within 30 days a warning. */
export function dateSeverity(daysRemaining: number): AlertSeverity {
  return daysRemaining <= 7 ? 'critical' : daysRemaining <= 30 ? 'warning' : 'info';
}

/**
 * The reminder an expiry or review is at for a rule: the nearest chosen day it has reached, or "overdue". Each one
 * fires once, so a server that was off on the exact day still sends it the next time it runs, and never twice.
 */
export function alertReminder(rule: Pick<AlertRule, 'daysBefore' | 'includeOverdue'>, daysRemaining: number) {
  if (daysRemaining < 0) return rule.includeOverdue ? { key: 'overdue', reason: 'Overdue' } : null;
  const day = [...rule.daysBefore].sort((a, b) => a - b).find((d) => daysRemaining <= d);
  if (day === undefined) return null;
  return { key: `day-${day}`, reason: day === 0 ? 'Due today' : `${day}-day reminder` };
}

/** Whether a rule fires for an event, and the reason it gives; null when it doesn't. */
export function alertRuleFires(rule: AlertRule, event: AlertEvent): { key: string; reason: string } | null {
  if (rule.kind !== event.kind) return null;
  if (rule.clientIds.length && !rule.clientIds.includes(event.clientId)) return null;
  if (!rule.itemKinds.includes(event.itemKind) || !rule.severities.includes(event.severity)) return null;
  if (event.kind === 'expiration' || event.kind === 'review')
    return event.daysRemaining === null ? null : alertReminder(rule, event.daysRemaining);
  return { key: 'once', reason: event.kind === 'breach' ? 'Found in a breach' : 'Infection reported' };
}
