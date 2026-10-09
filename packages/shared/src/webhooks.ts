import { z } from 'zod';

// ---------- Webhooks ----------
// Atlas posts a small JSON message to an address you choose when something changes, so another system can react.

/** The kinds of item a webhook can hear about. */
export const WEBHOOK_TOPICS = ['client', 'asset', 'document', 'password', 'contact', 'location', 'checklist'] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];
export const WEBHOOK_TOPIC_LABELS: Record<WebhookTopic, string> = {
  client: 'Clients',
  asset: 'Assets',
  document: 'Documents',
  password: 'Passwords',
  contact: 'Contacts',
  location: 'Locations',
  checklist: 'Checklists',
};

const url = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'Enter an https:// address, without a username or password in it.');

export const webhookSchema = z.object({
  name: z.string().trim().min(1, 'Name the webhook, for example "Teams alerts".').max(80),
  url,
  topics: z.array(z.enum(WEBHOOK_TOPICS)).min(1, 'Choose at least one kind of item.'),
  enabled: z.boolean().default(true),
});
export const updateWebhookSchema = webhookSchema.partial();

export interface WebhookView {
  id: string;
  name: string;
  url: string;
  topics: WebhookTopic[];
  enabled: boolean;
  /** Atlas stopped trying after repeated failures; an administrator has to resume it. */
  paused: boolean;
  /** The latest delivery's outcome, if there has been one. */
  last: { status: 'pending' | 'delivered' | 'failed'; at: string; detail: string } | null;
  createdAt: string;
}
/** Returned when a webhook is made or its secret is replaced. The secret can't be shown again. */
export interface WebhookWithSecret extends WebhookView {
  secret: string;
}
export interface WebhookDeliveryView {
  id: string;
  event: string;
  title: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
}

/** What Atlas posts. The item's contents are never included: fetch them through the API if you need them. */
export interface WebhookMessage {
  /** Unique to this delivery; the same on every retry, so a receiver can ignore repeats. */
  id: string;
  /** For example asset.updated, password.created, checklist.completed, or ping for a test. */
  event: string;
  occurredAt: string;
  actor: { id: string | null; name: string };
  client: { id: string; name: string } | null;
  item: { type: string; id: string | null; title: string; url: string | null };
}
