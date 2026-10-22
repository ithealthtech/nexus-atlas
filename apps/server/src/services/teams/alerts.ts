import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, lte } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  ROLE_INFO,
  type PasswordHealthReport,
  type TeamsAlertKind,
  type TeamsDelivery,
  teamsInfectionSchema,
} from '@atlas/shared';
import { actorFor } from '../../identity/service.js';
import { HttpError } from '../../errors.js';
import { ExpirationService } from '../expirations.js';
import { Scope } from '../scope.js';
import { Repeating, type ErrorLog } from '../repeating.js';
import { securityEvent } from '../security-log.js';
import { TeamsSettingsStore, type StoredTeams } from './settings.js';
import { TeamsBot, TeamsSendError } from './bot.js';

type Delivery = typeof schema.teamsDeliveries.$inferSelect;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function teamsReminder(daysLeft: number, reminders: number[]) {
  return [...reminders].sort((a, b) => a - b).find((day) => daysLeft <= day);
}
export function teamsLocalHour(now: Date, timeZone: string) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(now));
}

export class TeamsAlerts {
  private readonly schedule = new Repeating(() => this.tick());
  constructor(
    private readonly db: Database,
    private readonly deps: {
      settings: TeamsSettingsStore;
      bot: TeamsBot;
      expirations: ExpirationService;
      health: { report(scope: Scope): Promise<PasswordHealthReport> };
      publicOrigin: string;
    },
  ) {}
  start(log: ErrorLog) {
    this.schedule.start(60_000, log);
  }
  stop() {
    this.schedule.stop();
  }

  async enqueue(orgId: string, clientId: string, kind: TeamsAlertKind, key: string, text: string, rootKey?: string) {
    const saved = await this.deps.settings.load(orgId);
    const mapping =
      saved?.enabled && saved.alerts.includes(kind) && saved.mappings.find((m) => m.clientId === clientId);
    if (!mapping) return;
    const security = kind === 'breach' || kind === 'infection';
    await this.db
      .insert(schema.teamsDeliveries)
      .values({
        orgId,
        clientId,
        kind,
        eventKey: hash(key),
        rootKey: rootKey ? hash(rootKey) : null,
        teamId: mapping.teamId,
        channelId: security ? (mapping.securityChannelId ?? mapping.channelId) : mapping.channelId,
        text: text.slice(0, 10000),
      })
      .onConflictDoNothing();
  }
  async infection(scope: Scope, clientId: string, input: unknown, ip: string) {
    if (!ROLE_INFO[scope.actor.role].staff) throw new HttpError(404, 'Client not found.');
    await scope.require(clientId, 'edit', 'Client');
    const body = teamsInfectionSchema.parse(input);
    const [asset] = await this.db
      .select({ name: schema.assets.name, clientName: schema.clients.name })
      .from(schema.assets)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
      .where(
        and(
          eq(schema.assets.id, body.assetId),
          eq(schema.assets.clientId, clientId),
          eq(schema.assets.orgId, scope.actor.orgId),
          eq(schema.assets.archived, false),
        ),
      );
    if (!asset) throw new HttpError(404, 'Asset not found.');
    const saved = await this.deps.settings.load(scope.actor.orgId);
    if (!saved?.enabled || !saved.alerts.includes('infection') || !saved.mappings.some((m) => m.clientId === clientId))
      throw new HttpError(409, 'Enable infection notifications and map this client in Teams settings.');
    const root = JSON.stringify(['infection', clientId, body.assetId, body.source, body.eventId]);
    await this.enqueue(
      scope.actor.orgId,
      clientId,
      'infection',
      `${root}:${body.status}`,
      `${asset.clientName}: ${body.status === 'active' ? 'Confirmed infection' : 'Infection resolved'}: ${asset.name}\nSource: ${body.source}\n${this.deps.publicOrigin}/assets/${body.assetId}`,
      body.status === 'resolved' ? `${root}:active` : undefined,
    );
    await securityEvent(this.db, {
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: 'Teams infection notification received',
      detail: `Client ${clientId}; asset ${body.assetId}; ${body.status}`,
      ip,
    });
    return { ok: true };
  }
  async test(orgId: string, clientId: string) {
    const saved = await this.deps.settings.load(orgId);
    const mapping = saved?.enabled && saved.mappings.find((m) => m.clientId === clientId);
    if (!mapping) throw new HttpError(409, 'Enable Teams and save the client mapping first.');
    try {
      await this.deps.bot.send(orgId, mapping.channelId, 'Atlas test notification. No security incident was detected.');
    } catch (error) {
      throw new HttpError(502, error instanceof TeamsSendError ? error.message : 'The Teams test failed.');
    }
    return { ok: true };
  }
  async retry(orgId: string, id: string, confirmUncertain: boolean) {
    const table = schema.teamsDeliveries;
    const [found] = await this.db
      .select()
      .from(table)
      .where(and(eq(table.orgId, orgId), eq(table.id, id)));
    if (!found) throw new HttpError(404, 'Delivery not found.');
    if (found.status !== 'failed' && found.status !== 'uncertain')
      throw new HttpError(409, 'This delivery is not waiting for a retry.');
    if (found.status === 'uncertain' && !confirmUncertain)
      throw new HttpError(409, 'Check the Teams channel first. Retrying may create a duplicate.');
    await this.db
      .update(table)
      .set({ status: 'pending', attempts: 0, error: '', nextAttemptAt: new Date(), claimedAt: null })
      .where(and(eq(table.id, id), eq(table.orgId, orgId), eq(table.status, found.status)));
    return { ok: true };
  }
  private async collect(orgId: string, saved: StoredTeams, scope: Scope) {
    const window = Math.max(...saved.reminderDays);
    if (saved.alerts.includes('expiration') || saved.alerts.includes('review')) {
      for (const item of await this.deps.expirations.list(scope, window)) {
        if (!item.clientId) continue;
        const day = teamsReminder(item.daysLeft, saved.reminderDays);
        if (day === undefined) continue;
        const kind = item.kind === 'document' ? 'review' : 'expiration';
        // Vault alerts name the client, never a password or a restricted entry.
        const title = item.kind === 'password' ? 'A password needs attention' : item.title;
        const path = { asset: 'assets', password: 'passwords', document: 'documents' }[item.kind];
        await this.enqueue(
          orgId,
          item.clientId,
          kind,
          `${kind}:${item.id}:${item.label}:${item.date}:${day}`,
          `${item.clientName}: ${title}\n${item.label}: ${item.date}${item.daysLeft < 0 ? ' (overdue)' : ''}\n${this.deps.publicOrigin}/${path}/${item.id}`,
        );
      }
    }
    if (saved.alerts.includes('breach')) {
      const health = await this.deps.health.report(scope);
      const breached = health.items.filter((p) => p.issues.includes('breached'));
      const passwords = breached.length
        ? await this.db
            .select({ id: schema.passwords.id, changedAt: schema.passwords.changedAt })
            .from(schema.passwords)
            .where(
              and(
                inArray(
                  schema.passwords.id,
                  breached.map((p) => p.id),
                ),
                eq(schema.passwords.orgId, orgId),
              ),
            )
        : [];
      const changed = new Map(passwords.map((p) => [p.id, p.changedAt]));
      for (const item of breached) {
        const changedAt = changed.get(item.id);
        if (!changedAt) continue;
        await this.enqueue(
          orgId,
          item.clientId,
          'breach',
          `breach:${item.id}:${changedAt.toISOString()}`,
          `${item.clientName}: a stored password was found in a breach. Review it in Atlas.\n${this.deps.publicOrigin}/passwords/${item.id}`,
        );
      }
    }
  }
  async tick(now = new Date()) {
    // A worker dying after a send leaves an ambiguous outcome; never resend it automatically.
    await this.db
      .update(schema.teamsDeliveries)
      .set({ status: 'uncertain', error: 'Delivery was interrupted. Check Teams before retrying.' })
      .where(
        and(
          eq(schema.teamsDeliveries.status, 'sending'),
          lt(schema.teamsDeliveries.claimedAt, new Date(now.getTime() - 600_000)),
        ),
      );
    for (const org of await this.db.select({ id: schema.orgs.id }).from(schema.orgs)) {
      const saved = await this.deps.settings.load(org.id);
      if (!saved?.enabled) continue;
      const [owner] = await this.db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, saved.ownerId), eq(schema.users.orgId, org.id)));
      if (!owner || owner.disabled || !ROLE_INFO[owner.role as keyof typeof ROLE_INFO]?.admin) continue;
      await this.collect(org.id, saved, new Scope(this.db, actorFor(owner)));
      await this.deliver(org.id, saved, now);
    }
  }
  private async deliver(orgId: string, saved: StoredTeams, now: Date) {
    const table = schema.teamsDeliveries;
    const due = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.orgId, orgId),
            eq(table.status, 'pending'),
            lte(table.nextAttemptAt, now),
            teamsLocalHour(now, saved.timeZone) < saved.digestHour
              ? inArray(table.kind, ['breach', 'infection'])
              : undefined,
          ),
        )
        .orderBy(asc(table.createdAt))
        .limit(50)
        .for('update', { skipLocked: true });
      const selected = rows.filter(
        (r) => r.kind === 'breach' || r.kind === 'infection' || teamsLocalHour(now, saved.timeZone) >= saved.digestHour,
      );
      if (selected.length)
        await tx
          .update(table)
          .set({ status: 'sending', claimedAt: now })
          .where(
            inArray(
              table.id,
              selected.map((r) => r.id),
            ),
          );
      return selected;
    });
    const groups = new Map<string, Delivery[]>();
    for (const row of due) {
      const key = row.kind === 'breach' || row.kind === 'infection' ? row.id : `${row.teamId}:${row.channelId}`;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    for (const rows of groups.values())
      for (let i = 0; i < rows.length; i += 15) {
        const batch = rows.slice(i, i + 15);
        const first = batch[0]!;
        const valid = batch.every((row) => {
          const m = saved.mappings.find((m) => m.clientId === row.clientId);
          return (
            m &&
            saved.alerts.includes(row.kind as TeamsAlertKind) &&
            m.teamId === row.teamId &&
            (row.kind === 'breach' || row.kind === 'infection' ? (m.securityChannelId ?? m.channelId) : m.channelId) ===
              row.channelId
          );
        });
        try {
          if (!valid) throw new TeamsSendError('failed');
          const [root] = first.rootKey
            ? await this.db
                .select()
                .from(table)
                .where(
                  and(
                    eq(table.orgId, orgId),
                    eq(table.eventKey, first.rootKey),
                    eq(table.teamId, first.teamId),
                    eq(table.channelId, first.channelId),
                    eq(table.status, 'sent'),
                  ),
                )
            : [];
          const result = await this.deps.bot.send(
            orgId,
            first.channelId,
            batch.map((r) => r.text).join('\n\n'),
            root?.conversationId ?? undefined,
          );
          await this.db.transaction(async (tx) => {
            await tx
              .update(table)
              .set({ status: 'sent', attempts: first.attempts + 1, error: '', updatedAt: now, ...result })
              .where(
                inArray(
                  table.id,
                  batch.map((r) => r.id),
                ),
              );
            await securityEvent(tx, {
              orgId,
              userId: saved.ownerId,
              actor: 'Atlas Teams notifications',
              action: 'Sent Teams notifications',
              detail: `${batch.length} ${first.kind} notification(s); channel ${first.channelId}`,
            });
          });
        } catch (error) {
          const failure = error instanceof TeamsSendError ? error : new TeamsSendError('uncertain');
          const attempts = first.attempts + 1;
          await this.db
            .update(table)
            .set({
              status:
                failure.outcome === 'retry' && attempts < 5
                  ? 'pending'
                  : failure.outcome === 'uncertain'
                    ? 'uncertain'
                    : 'failed',
              attempts,
              error: failure.message,
              updatedAt: now,
              nextAttemptAt: new Date(now.getTime() + Math.max(failure.retrySeconds, 30 * 2 ** attempts) * 1000),
            })
            .where(
              inArray(
                table.id,
                batch.map((r) => r.id),
              ),
            );
        }
      }
  }
  async history(orgId: string): Promise<TeamsDelivery[]> {
    const rows = await this.db
      .select()
      .from(schema.teamsDeliveries)
      .where(eq(schema.teamsDeliveries.orgId, orgId))
      .orderBy(desc(schema.teamsDeliveries.createdAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as TeamsAlertKind,
      clientId: r.clientId,
      status: r.status,
      attempts: r.attempts,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
