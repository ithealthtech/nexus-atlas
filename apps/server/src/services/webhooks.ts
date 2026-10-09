import { createHmac, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  updateWebhookSchema,
  webhookSchema,
  type Actor,
  type WebhookDeliveryView,
  type WebhookMessage,
  type WebhookTopic,
  type WebhookView,
  type WebhookWithSecret,
} from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { VaultKeys } from '../crypto/vault-keys.js';
import { HttpError } from '../errors.js';
import { isUuid } from './scope.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type WebhookRow = typeof schema.webhooks.$inferSelect;
type DeliveryRow = typeof schema.webhookDeliveries.$inferSelect;

const TIMEOUT_MS = 10_000;
// After the first try: 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours. Then the delivery is given up on.
const RETRY_MINUTES = [1, 5, 30, 120, 360];
/** This many deliveries given up on in a row, and the webhook is paused until an administrator resumes it. */
const PAUSE_AFTER = 10;
const KEEP_DAYS = 14;
const secretAad = (id: string) => `webhook|${id}|secret`;

/** Which topic an activity entry belongs to, or null for kinds webhooks don't carry. */
function topicOf(entityType: string): WebhookTopic | null {
  if (entityType === 'checklist' || entityType === 'checklist_run') return 'checklist';
  if (entityType === 'client' || entityType === 'client_notes') return 'client';
  return (['asset', 'document', 'password', 'contact', 'location'] as const).find((t) => t === entityType) ?? null;
}

// Activity entries are written for people ("Attached a file to"); events get one steady word each.
const VERBS: [RegExp, string][] = [
  [/^(created|added)\b/i, 'created'],
  [/^(deleted)\b/i, 'deleted'],
  [/^archived\b/i, 'archived'],
  [/^restored\b/i, 'restored'],
  [/^linked\b/i, 'linked'],
  [/^unlinked\b/i, 'unlinked'],
  [/^attached a file\b/i, 'file_added'],
  [/^removed a file\b/i, 'file_removed'],
  [/^started\b/i, 'started'],
  [/^completed\b/i, 'completed'],
  [/rotat|changed (the )?password/i, 'rotated'],
];
/** The event name for an activity entry, for example asset.updated. Anything unrecognized is an update. */
export function eventName(entityType: string, action: string): string | null {
  const topic = topicOf(entityType);
  if (!topic) return null;
  return `${topic}.${VERBS.find(([pattern]) => pattern.test(action))?.[1] ?? 'updated'}`;
}

// Which organizations have a webhook worth queuing for, so the many writes of a sync don't each ask.
const active = new Map<string, { until: number; hooks: { id: string; topics: string[] }[] }>();
const forget = (orgId: string) => active.delete(orgId);

/**
 * Queues an event for every webhook that wants it, in the same transaction as the change it describes: if the
 * change is rolled back so is the event, and an event is never lost because the receiver happened to be down.
 */
export async function queueWebhooks(
  db: Database | Tx,
  actor: Pick<Actor, 'id' | 'orgId' | 'name'>,
  entry: { clientId: string | null; action: string; entityType: string; entityId: string | null; title: string },
) {
  const event = eventName(entry.entityType, entry.action);
  if (!event) return;
  let cached = active.get(actor.orgId);
  if (!cached || cached.until < Date.now()) {
    const hooks = await db
      .select({ id: schema.webhooks.id, topics: schema.webhooks.topics })
      .from(schema.webhooks)
      .where(
        and(
          eq(schema.webhooks.orgId, actor.orgId),
          eq(schema.webhooks.enabled, true),
          isNull(schema.webhooks.pausedAt),
        ),
      );
    cached = { until: Date.now() + 15_000, hooks };
    active.set(actor.orgId, cached);
  }
  const topic = event.split('.')[0]!;
  const wanted = cached.hooks.filter((h) => h.topics.includes(topic));
  if (!wanted.length) return;
  await db.insert(schema.webhookDeliveries).values(
    wanted.map((h) => ({
      orgId: actor.orgId,
      webhookId: h.id,
      event,
      data: {
        actorId: actor.id,
        actorName: actor.name,
        clientId: entry.clientId,
        entityType: entry.entityType,
        entityId: entry.entityId,
        title: entry.title.slice(0, 200),
      },
    })),
  );
}

export const signWebhook = (secret: string, timestamp: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/** Webhook administration and delivery. */
export class WebhookService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pruned = 0;

  constructor(
    private readonly db: Database,
    private readonly keys: VaultKeys,
    private readonly publicOrigin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async view(row: WebhookRow): Promise<WebhookView> {
    const [last] = await this.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.webhookId, row.id))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(1);
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      topics: row.topics as WebhookTopic[],
      enabled: row.enabled,
      paused: !!row.pausedAt,
      last: last
        ? {
            status: last.status as 'pending' | 'delivered' | 'failed',
            at: (last.deliveredAt ?? last.createdAt).toISOString(),
            detail:
              last.status === 'delivered'
                ? `${last.event} delivered`
                : (last.error ?? (last.attempts ? 'Waiting to retry' : 'Waiting to send')),
          }
        : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async row(actor: Actor, id: string) {
    requireAdmin(actor);
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.webhooks)
          .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.orgId, actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'Webhook not found.');
    return row;
  }

  private event(actor: Actor, action: string, detail: string, ip: string) {
    return this.db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action,
      detail: detail.slice(0, 300),
      ip,
    });
  }

  async list(actor: Actor): Promise<WebhookView[]> {
    requireAdmin(actor);
    const rows = await this.db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.orgId, actor.orgId))
      .orderBy(asc(schema.webhooks.createdAt));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  /** Makes a webhook with a new signing secret, which is returned this once. */
  async create(actor: Actor, input: unknown, ip: string): Promise<WebhookWithSecret> {
    requireAdmin(actor);
    const body = webhookSchema.parse(input);
    const secret = randomBytes(32).toString('base64url');
    const row = await this.db.transaction(async (tx) => {
      const [made] = await tx
        .insert(schema.webhooks)
        .values({
          orgId: actor.orgId,
          name: body.name,
          url: body.url,
          topics: body.topics,
          enabled: body.enabled,
          secret: '',
          createdBy: actor.id,
        })
        .returning();
      const sealed = await this.keys.seal(actor.orgId, secret, secretAad(made!.id));
      await tx.update(schema.webhooks).set({ secret: sealed }).where(eq(schema.webhooks.id, made!.id));
      return { ...made!, secret: sealed };
    });
    forget(actor.orgId);
    await this.event(actor, 'Webhook created', `${body.name}: ${new URL(body.url).host}`, ip);
    return { ...(await this.view(row)), secret };
  }

  async update(actor: Actor, id: string, input: unknown, ip: string): Promise<WebhookView> {
    const current = await this.row(actor, id);
    const body = updateWebhookSchema.parse(input);
    const [row] = await this.db
      .update(schema.webhooks)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.url !== undefined && { url: body.url }),
        ...(body.topics !== undefined && { topics: body.topics }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        updatedAt: new Date(),
      })
      .where(eq(schema.webhooks.id, id))
      .returning();
    forget(actor.orgId);
    if (body.url !== undefined && body.url !== current.url)
      await this.event(actor, 'Webhook address changed', `${row!.name}: ${new URL(body.url).host}`, ip);
    return this.view(row!);
  }

  /** Replaces the signing secret. Messages already queued are signed with the new one. */
  async rotateSecret(actor: Actor, id: string, ip: string): Promise<WebhookWithSecret> {
    const row = await this.row(actor, id);
    const secret = randomBytes(32).toString('base64url');
    await this.db
      .update(schema.webhooks)
      .set({ secret: await this.keys.seal(actor.orgId, secret, secretAad(id)), updatedAt: new Date() })
      .where(eq(schema.webhooks.id, id));
    await this.event(actor, 'Webhook secret replaced', row.name, ip);
    return { ...(await this.view(row)), secret };
  }

  /** Starts sending again after Atlas paused a webhook that kept failing. */
  async resume(actor: Actor, id: string): Promise<WebhookView> {
    await this.row(actor, id);
    const [row] = await this.db
      .update(schema.webhooks)
      .set({ pausedAt: null, failures: 0, updatedAt: new Date() })
      .where(eq(schema.webhooks.id, id))
      .returning();
    forget(actor.orgId);
    return this.view(row!);
  }

  async remove(actor: Actor, id: string, ip: string) {
    const row = await this.row(actor, id);
    await this.db.delete(schema.webhooks).where(eq(schema.webhooks.id, id));
    forget(actor.orgId);
    await this.event(actor, 'Webhook deleted', row.name, ip);
  }

  async deliveries(actor: Actor, id: string): Promise<WebhookDeliveryView[]> {
    await this.row(actor, id);
    const rows = await this.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.webhookId, id))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(50);
    return rows.map((d) => ({
      id: d.id,
      event: d.event,
      title: d.data.title,
      status: d.status as WebhookDeliveryView['status'],
      attempts: d.attempts,
      responseStatus: d.responseStatus,
      error: d.error,
      createdAt: d.createdAt.toISOString(),
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
    }));
  }

  /** Sends a ping now and reports what the receiver said, without queuing anything. */
  async test(actor: Actor, id: string): Promise<{ ok: boolean; status: number | null; detail: string }> {
    const row = await this.row(actor, id);
    const message: WebhookMessage = {
      id: `ping-${randomBytes(8).toString('hex')}`,
      event: 'ping',
      occurredAt: new Date().toISOString(),
      actor: { id: actor.id, name: actor.name },
      client: null,
      item: { type: 'webhook', id: row.id, title: row.name, url: null },
    };
    const result = await this.send(row, message);
    return { ok: result.ok, status: result.status, detail: result.ok ? 'The receiver accepted it.' : result.error };
  }

  private async send(
    hook: WebhookRow,
    message: WebhookMessage,
  ): Promise<{ ok: true; status: number } | { ok: false; status: number | null; error: string }> {
    const body = JSON.stringify(message);
    const timestamp = String(Math.floor(Date.now() / 1000));
    let secret: string;
    try {
      secret = await this.keys.open(hook.orgId, hook.secret, secretAad(hook.id));
    } catch {
      return { ok: false, status: null, error: 'The signing secret could not be read. Replace it.' };
    }
    try {
      const response = await this.fetcher(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'MSP-Atlas-Webhook',
          'X-Atlas-Event': message.event,
          'X-Atlas-Delivery': message.id,
          'X-Atlas-Timestamp': timestamp,
          'X-Atlas-Signature': signWebhook(secret, timestamp, body),
        },
        body,
        // A redirect could carry the message somewhere the administrator didn't choose.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };
      return {
        ok: false,
        status: response.status,
        error:
          response.status >= 300 && response.status < 400
            ? `The address redirects (${response.status}); enter the final address.`
            : `The receiver answered ${response.status}.`,
      };
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        ok: false,
        status: null,
        error: timedOut ? 'The receiver did not answer in time.' : 'The receiver could not be reached.',
      };
    }
  }

  private url(d: DeliveryRow['data']): string | null {
    if (!d.entityId) return d.clientId ? `${this.publicOrigin}/clients/${d.clientId}` : null;
    switch (d.entityType) {
      case 'asset':
        return `${this.publicOrigin}/assets/${d.entityId}`;
      case 'document':
        return `${this.publicOrigin}/documents/${d.entityId}`;
      case 'password':
        return `${this.publicOrigin}/passwords/${d.entityId}`;
      case 'checklist_run':
        return `${this.publicOrigin}/checklist-runs/${d.entityId}`;
      case 'client':
      case 'client_notes':
        return `${this.publicOrigin}/clients/${d.entityId}`;
      default:
        return d.clientId ? `${this.publicOrigin}/clients/${d.clientId}` : null;
    }
  }

  /** Sends what's due. Returns how many deliveries were attempted. */
  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const d = schema.webhookDeliveries;
      // Only for webhooks that are on: what's queued for a paused or switched-off one waits without holding up
      // the others, and goes when it's on again.
      const due = (
        await this.db
          .select({ delivery: d })
          .from(d)
          .innerJoin(schema.webhooks, eq(schema.webhooks.id, d.webhookId))
          .where(
            and(
              eq(d.status, 'pending'),
              lte(d.nextAttemptAt, now),
              eq(schema.webhooks.enabled, true),
              isNull(schema.webhooks.pausedAt),
            ),
          )
          .orderBy(asc(d.createdAt))
          .limit(50)
      ).map((x) => x.delivery);
      if (!due.length) return 0;
      const hooks = new Map(
        (
          await this.db
            .select()
            .from(schema.webhooks)
            .where(inArray(schema.webhooks.id, [...new Set(due.map((x) => x.webhookId))]))
        ).map((h) => [h.id, h]),
      );
      const clientIds = [...new Set(due.map((x) => x.data.clientId).filter((id): id is string => !!id))];
      const clients = new Map(
        clientIds.length
          ? (
              await this.db
                .select({ id: schema.clients.id, name: schema.clients.name })
                .from(schema.clients)
                .where(inArray(schema.clients.id, clientIds))
            ).map((c) => [c.id, c.name])
          : [],
      );
      let attempted = 0;
      for (const delivery of due) {
        const hook = hooks.get(delivery.webhookId);
        // Paused earlier in this same pass.
        if (!hook || hook.pausedAt) continue;
        attempted++;
        const clientName = delivery.data.clientId ? clients.get(delivery.data.clientId) : undefined;
        const result = await this.send(hook, {
          id: delivery.id,
          event: delivery.event,
          occurredAt: delivery.createdAt.toISOString(),
          actor: { id: delivery.data.actorId, name: delivery.data.actorName },
          client: delivery.data.clientId && clientName ? { id: delivery.data.clientId, name: clientName } : null,
          item: {
            type: delivery.data.entityType,
            id: delivery.data.entityId,
            title: delivery.data.title,
            url: this.url(delivery.data),
          },
        });
        const attempts = delivery.attempts + 1;
        if (result.ok) {
          await this.db
            .update(d)
            .set({ status: 'delivered', attempts, responseStatus: result.status, error: null, deliveredAt: new Date() })
            .where(eq(d.id, delivery.id));
          if (hook.failures) {
            await this.db.update(schema.webhooks).set({ failures: 0 }).where(eq(schema.webhooks.id, hook.id));
            hook.failures = 0;
          }
          continue;
        }
        const wait = RETRY_MINUTES[attempts - 1];
        if (wait !== undefined) {
          await this.db
            .update(d)
            .set({
              attempts,
              responseStatus: result.status,
              error: result.error,
              nextAttemptAt: new Date(now.getTime() + wait * 60_000),
            })
            .where(eq(d.id, delivery.id));
          continue;
        }
        await this.db
          .update(d)
          .set({ status: 'failed', attempts, responseStatus: result.status, error: result.error })
          .where(eq(d.id, delivery.id));
        hook.failures++;
        const pause = hook.failures >= PAUSE_AFTER;
        await this.db
          .update(schema.webhooks)
          .set({ failures: hook.failures, ...(pause && { pausedAt: new Date() }) })
          .where(eq(schema.webhooks.id, hook.id));
        if (pause) {
          hook.pausedAt = new Date();
          forget(hook.orgId);
        }
      }
      if (Date.now() - this.pruned > 3_600_000) {
        this.pruned = Date.now();
        await this.db
          .delete(d)
          .where(
            and(
              inArray(d.status, ['delivered', 'failed']),
              sql`${d.createdAt} < now() - make_interval(days => ${KEEP_DAYS})`,
            ),
          );
      }
      return attempted;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs = 5_000, log: (error: unknown) => void = () => undefined) {
    this.timer = setInterval(() => void this.tick().catch(log), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
