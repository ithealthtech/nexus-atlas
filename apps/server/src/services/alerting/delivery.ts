import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  ALERT_KIND_LABELS,
  ROLE_INFO,
  alertDeliveryModeSchema,
  alertDeliveryQuerySchema,
  alertRetrySchema,
  alertRuleFires,
  alertSampleValues,
  alertTestSendSchema,
  alertWorkspaceSchema,
  dateSeverity,
  renderAlertTemplate,
  type AccessLevel,
  type AlertChannel,
  type AlertDeliveryMode,
  type AlertDeliveryPage,
  type AlertDeliveryState,
  type AlertDeliveryStatus,
  type AlertDeliveryView,
  type AlertDryRun,
  type AlertEvent,
  type AlertKind,
  type AlertRule,
  type AlertTemplate,
  type AlertWorkspace,
  type PasswordHealthReport,
  type Role,
} from '@atlas/shared';
import { clientLevels } from '../../authz.js';
import { HttpError } from '../../errors.js';
import { actorFor } from '../../identity/service.js';
import type { ExpirationService } from '../expirations.js';
import type { MailService } from '../mail.js';
import { Repeating, type ErrorLog } from '../repeating.js';
import { Scope } from '../scope.js';
import { securityEvent } from '../security-log.js';
import { TeamsRequestError } from '../teams/client.js';
import type { TeamsGraph } from '../teams/graph.js';
import type { StoredTeams, TeamsSettingsStore } from '../teams/settings.js';
import { AlertWorkspaceService, requireAlertAdmin } from './workspace.js';

type Row = typeof schema.alertDeliveries.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;
const table = schema.alertDeliveries;
const DAY = 86_400_000;
const MAX_ATTEMPTS = 5;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isoWeek = (date: Date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const year = d.getUTCFullYear();
  return `${year}-W${String(Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / DAY + 1) / 7)).padStart(2, '0')}`;
};
const PATHS = { asset: 'assets', password: 'passwords', document: 'documents' } as const;
const SECURITY: AlertKind[] = ['breach', 'infection'];

interface StoredMode {
  mode: AlertDeliveryMode;
  since: string;
  by: string;
}
/** Where a delivery goes, worked out before anything is queued. */
interface Destination {
  channel: AlertChannel;
  destination: string;
  label: string;
  ready: boolean;
  detail: string;
}

/** Whether the alerting center sends this organization's alerts, in place of the classic ones. */
export async function alertCenterLive(db: Database, orgId: string) {
  const [row] = await db
    .select({ mode: sql<string | null>`${schema.orgs.settings}->'alertingDelivery'->>'mode'` })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId));
  return row?.mode === 'center';
}

/**
 * Sends the published alerting center rules: finds the expirations, document reviews, breached passwords and
 * infected endpoints each rule covers, queues one delivery per rule, event, reminder and destination (so each
 * goes once), and sends them through the organization's email and Microsoft Teams connections. Recipients'
 * access is checked again just before sending. Nothing runs until an administrator turns it on.
 */
export class AlertDeliveryService {
  private readonly schedule = new Repeating(() => this.tick());
  private readonly workspace: AlertWorkspaceService;
  constructor(
    private readonly db: Database,
    private readonly deps: {
      mail: MailService;
      teams: TeamsSettingsStore;
      graph: TeamsGraph;
      expirations: ExpirationService;
      health: { report(scope: Scope): Promise<PasswordHealthReport> };
      publicOrigin: string;
    },
  ) {
    this.workspace = new AlertWorkspaceService(db);
  }
  start(log: ErrorLog) {
    this.schedule.start(60_000, log);
  }
  stop() {
    this.schedule.stop();
  }

  // ---------- mode ----------
  private async storedMode(orgId: string): Promise<StoredMode | null> {
    const [row] = await this.db
      .select({ value: sql<StoredMode | null>`${schema.orgs.settings}->'alertingDelivery'` })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId));
    return row?.value ?? null;
  }
  private async published(orgId: string): Promise<{ version: number; workspace: AlertWorkspace } | null> {
    const [row] = await this.db
      .select({ version: schema.alertVersions.version, workspace: schema.alertVersions.workspace })
      .from(schema.alertVersions)
      .where(eq(schema.alertVersions.orgId, orgId))
      .orderBy(desc(schema.alertVersions.version))
      .limit(1);
    return row ? { version: row.version, workspace: alertWorkspaceSchema.parse(row.workspace) } : null;
  }

  async state(scope: Scope): Promise<AlertDeliveryState> {
    const orgId = requireAlertAdmin(scope);
    const stored = await this.storedMode(orgId);
    const published = await this.published(orgId);
    const teams = await this.deps.teams.load(orgId);
    const rows = await this.db
      .select({ status: table.status, n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.orgId, orgId), eq(table.test, false), gte(table.createdAt, new Date(Date.now() - 7 * DAY))))
      .groupBy(table.status);
    const count = (status: AlertDeliveryStatus) => rows.find((r) => r.status === status)?.n ?? 0;
    return {
      mode: stored?.mode ?? 'classic',
      since: stored?.since ?? null,
      by: stored?.by ?? null,
      publishedVersion: published?.version ?? null,
      publishedRules: published?.workspace.rules.length ?? 0,
      email: await this.deps.mail.enabled(orgId),
      teams: !!(teams?.enabled && teams.connection),
      counts: {
        sent: count('sent'),
        failed: count('failed'),
        uncertain: count('uncertain'),
        pending: count('pending') + count('sending'),
        skipped: count('skipped'),
      },
    };
  }

  /**
   * Turns the alerting center on, in place of the classic alerts, or back off. Going live needs a published version
   * and an explicit confirmation. Reminders already due at that moment were probably sent by the classic alerts, so
   * they're recorded as done rather than sent again, unless the administrator asks to send them.
   */
  async setMode(scope: Scope, input: unknown, ip: string): Promise<AlertDeliveryState> {
    const orgId = requireAlertAdmin(scope);
    const body = alertDeliveryModeSchema.parse(input);
    if (body.mode === 'center') {
      if (!body.confirm) throw new HttpError(400, 'Confirm that the classic alerts stop before going live.');
      if (!(await this.published(orgId)))
        throw new HttpError(409, 'Publish your alert rules first. The live alerts are the latest published version.');
    }
    const value: StoredMode = { mode: body.mode, since: new Date().toISOString(), by: scope.actor.name };
    const baseline = body.mode === 'center' && !body.sendDue && (await this.storedMode(orgId))?.mode !== 'center';
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.orgs)
        .set({
          settings: sql`jsonb_set(${schema.orgs.settings}, '{alertingDelivery}', ${JSON.stringify(value)}::jsonb)`,
        })
        .where(eq(schema.orgs.id, orgId));
      await securityEvent(tx, {
        orgId,
        userId: scope.actor.id,
        actor: scope.actor.name,
        action:
          body.mode === 'center' ? 'Alerting center went live' : 'Alerting center switched back to classic alerts',
        detail: '',
        ip,
      });
    });
    if (baseline) await this.collect(orgId, new Date(), true);
    return this.state(scope);
  }

  // ---------- events ----------
  private async owner(orgId: string): Promise<UserRow | null> {
    const [owner] = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.role, 'owner'), eq(schema.users.disabled, false)))
      .limit(1);
    return owner ?? null;
  }

  /** Everything the rules could alert on now, read with the owner's view so every client is covered. */
  async events(orgId: string, rules: AlertRule[], now = new Date()): Promise<AlertEvent[]> {
    const owner = await this.owner(orgId);
    if (!owner || !rules.length) return [];
    const scope = new Scope(this.db, actorFor(owner));
    const kinds = new Set(rules.map((r) => r.kind));
    const events: AlertEvent[] = [];
    if (kinds.has('expiration') || kinds.has('review')) {
      const window = Math.max(
        0,
        ...rules.flatMap((r) => (r.kind === 'expiration' || r.kind === 'review' ? r.daysBefore : [])),
      );
      for (const item of await this.deps.expirations.list(scope, Math.min(365, window))) {
        if (!item.clientId) continue;
        const kind: AlertKind = item.kind === 'document' ? 'review' : 'expiration';
        events.push({
          kind,
          key: `${kind}:${item.kind}:${item.id}:${item.label}:${item.date}`,
          clientId: item.clientId,
          clientName: item.clientName ?? '',
          itemKind: item.kind,
          itemId: item.id,
          // Vault alerts name the client, never a password or a restricted entry.
          itemName: item.kind === 'password' ? 'A password needs attention' : item.title,
          itemType: item.label,
          dueDate: item.date,
          daysRemaining: item.daysLeft,
          severity: dateSeverity(item.daysLeft),
          path: `/${PATHS[item.kind]}/${item.id}`,
        });
      }
    }
    if (kinds.has('breach')) {
      const breached = (await this.deps.health.report(scope)).items.filter((p) => p.issues.includes('breached'));
      const changed = breached.length
        ? await this.db
            .select({ id: schema.passwords.id, changedAt: schema.passwords.changedAt })
            .from(schema.passwords)
            .where(
              and(
                eq(schema.passwords.orgId, orgId),
                inArray(
                  schema.passwords.id,
                  breached.map((p) => p.id),
                ),
              ),
            )
        : [];
      for (const p of breached) {
        const at = changed.find((c) => c.id === p.id)?.changedAt;
        if (!at) continue;
        events.push({
          kind: 'breach',
          key: `breach:${p.id}:${at.toISOString()}`,
          clientId: p.clientId,
          clientName: p.clientName,
          itemKind: 'password',
          itemId: p.id,
          itemName: 'A password needs attention',
          itemType: 'Password found in a breach',
          dueDate: null,
          daysRemaining: null,
          severity: 'critical',
          path: `/passwords/${p.id}`,
        });
      }
    }
    if (kinds.has('infection')) {
      const t = schema.bitdefenderEndpoints;
      const infected = await this.db
        .select({
          id: t.endpointId,
          name: t.name,
          clientId: t.clientId,
          assetId: t.assetId,
          client: schema.clients.name,
        })
        .from(t)
        .innerJoin(schema.clients, eq(schema.clients.id, t.clientId))
        .where(and(eq(t.orgId, orgId), eq(t.infected, true)));
      // While an endpoint stays infected, it comes round again each week.
      const week = isoWeek(now);
      for (const e of infected)
        events.push({
          kind: 'infection',
          key: `infection:${e.id}:${week}`,
          clientId: e.clientId,
          clientName: e.client,
          itemKind: 'asset',
          itemId: e.assetId ?? e.id,
          itemName: e.name,
          itemType: 'Bitdefender endpoint',
          dueDate: null,
          daysRemaining: null,
          severity: 'critical',
          path: e.assetId ? `/assets/${e.assetId}` : `/clients/${e.clientId}`,
        });
    }
    return events;
  }

  // ---------- destinations and rendering ----------
  private async destinations(
    orgId: string,
    rule: AlertRule,
    event: AlertEvent,
    users: Map<string, { user: UserRow; levels: Map<string, AccessLevel> }>,
    teams: StoredTeams | null,
  ): Promise<Destination[]> {
    void orgId;
    const out: Destination[] = [];
    for (const id of rule.emailUserIds) {
      const entry = users.get(id);
      if (!entry) {
        out.push({
          channel: 'email',
          destination: id,
          label: 'A removed person',
          ready: false,
          detail: 'No longer in Atlas.',
        });
        continue;
      }
      out.push({
        channel: 'email',
        destination: id,
        label: `${entry.user.name} <${entry.user.email}>`,
        ...this.canReceive(entry, event),
      });
    }
    if (rule.teams) {
      const mapping = teams?.enabled ? teams.mappings.find((m) => m.clientId === event.clientId) : undefined;
      if (!mapping)
        out.push({
          channel: 'teams',
          destination: `unmapped:${event.clientId}`,
          label: 'Microsoft Teams',
          ready: false,
          detail: 'No Teams channel is mapped to this client.',
        });
      else {
        const security = SECURITY.includes(event.kind) && mapping.securityChannelId;
        out.push({
          channel: 'teams',
          destination: `${mapping.teamId}:${security ? mapping.securityChannelId : mapping.channelId}`,
          label: `Teams: ${mapping.channelName}${security ? ' (security channel)' : ''}`,
          ready: !!teams?.connection,
          detail: teams?.connection ? 'Ready.' : 'Microsoft Teams is not connected.',
        });
      }
    }
    return out;
  }
  /** Staff who can open the client, and (for routine reminders) haven't turned alert emails off. */
  private canReceive(entry: { user: UserRow; levels: Map<string, AccessLevel> }, event: AlertEvent) {
    const { user, levels } = entry;
    if (user.disabled || !ROLE_INFO[user.role as Role]?.staff)
      return { ready: false, detail: 'Not an active staff member.' };
    if ((levels.get(event.clientId) ?? 'none') === 'none') return { ready: false, detail: 'Can’t open this client.' };
    if (!SECURITY.includes(event.kind) && !user.notifyDigest)
      return { ready: false, detail: 'Turned off alert emails on their profile.' };
    return { ready: true, detail: 'Ready.' };
  }
  private async recipients(orgId: string, rules: AlertRule[]) {
    const ids = [...new Set(rules.flatMap((r) => r.emailUserIds))];
    const rows = ids.length
      ? await this.db
          .select()
          .from(schema.users)
          .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, ids)))
      : [];
    const map = new Map<string, { user: UserRow; levels: Map<string, AccessLevel> }>();
    for (const user of rows) map.set(user.id, { user, levels: await clientLevels(this.db, actorFor(user)) });
    return map;
  }
  private render(template: AlertTemplate, event: AlertEvent) {
    const link = `${this.deps.publicOrigin}${event.path}`;
    return {
      link,
      ...renderAlertTemplate(template, {
        clientName: event.clientName,
        eventName: ALERT_KIND_LABELS[event.kind],
        itemName: event.itemName,
        itemType: event.itemType,
        dueDate: event.dueDate ?? '',
        daysRemaining: event.daysRemaining === null ? '' : String(event.daysRemaining),
        severity: event.severity,
        atlasUrl: link,
      }),
    };
  }

  // ---------- queueing ----------
  /**
   * Queues what the latest published rules send now, and returns how many deliveries were added. With `baseline`,
   * they're recorded as already handled instead, so going live doesn't repeat what the classic alerts sent.
   */
  async collect(orgId: string, now = new Date(), baseline = false) {
    const published = await this.published(orgId);
    if (!published) return 0;
    const { rules, templates } = published.workspace;
    const events = await this.events(orgId, rules, now);
    if (!events.length) return 0;
    const users = await this.recipients(orgId, rules);
    const teams = await this.deps.teams.load(orgId);
    let added = 0;
    for (const rule of rules) {
      const template = templates.find((t) => t.id === rule.templateId);
      if (!template) continue;
      for (const event of events) {
        const fires = alertRuleFires(rule, event);
        if (!fires) continue;
        const message = this.render(template, event);
        for (const d of await this.destinations(orgId, rule, event, users, teams)) {
          // Destinations that can't receive it are left out of the queue; the preview explains why.
          if (!d.ready && d.channel === 'teams') continue;
          const inserted = await this.db
            .insert(table)
            .values({
              orgId,
              version: published.version,
              ruleId: rule.id,
              ruleName: rule.name,
              kind: rule.kind,
              clientId: event.clientId,
              itemName: event.itemName,
              eventKey: hash(`${event.key}:${fires.key}`),
              reason: fires.reason,
              channel: d.channel,
              destination: d.destination,
              destinationLabel: d.label,
              subject: d.channel === 'email' ? message.emailSubject : message.teamsBody.split('\n')[0]!.slice(0, 200),
              body: d.channel === 'email' ? message.emailBody : message.teamsBody,
              teamsFormat: template.teamsFormat ?? 'text',
              link: message.link,
              // Due from this tick, so the same pass sends it rather than the next one.
              nextAttemptAt: now,
              ...(baseline
                ? { status: 'skipped' as const, error: 'Already due when the alerting center went live.' }
                : d.ready
                  ? {}
                  : { status: 'skipped' as const, error: d.detail }),
            })
            .onConflictDoNothing()
            .returning({ id: table.id });
          added += inserted.length;
        }
      }
    }
    return added;
  }

  // ---------- sending ----------
  async tick(now = new Date()) {
    // A send interrupted by a restart may have gone; never send it again automatically.
    await this.db
      .update(table)
      .set({ status: 'uncertain', error: 'Sending was interrupted. Check it arrived before retrying.' })
      .where(and(eq(table.status, 'sending'), lt(table.claimedAt, new Date(now.getTime() - 600_000))));
    const orgs = await this.db
      .select({ id: schema.orgs.id, name: schema.orgs.name })
      .from(schema.orgs)
      .where(sql`${schema.orgs.settings}->'alertingDelivery'->>'mode' = 'center'`);
    for (const org of orgs) {
      await this.collect(org.id, now);
      await this.deliver(org, now);
    }
  }

  async deliver(org: { id: string; name: string }, now = new Date()) {
    const due = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(table)
        .where(and(eq(table.orgId, org.id), eq(table.status, 'pending'), lte(table.nextAttemptAt, now)))
        .orderBy(asc(table.createdAt))
        .limit(50)
        .for('update', { skipLocked: true });
      if (rows.length)
        await tx
          .update(table)
          .set({ status: 'sending', claimedAt: now })
          .where(
            inArray(
              table.id,
              rows.map((r) => r.id),
            ),
          );
      return rows;
    });
    const teams = due.some((r) => r.channel === 'teams') ? await this.deps.teams.load(org.id) : null;
    for (const row of due) await this.send(org, row, teams, now);
  }

  private async finish(row: Row, status: AlertDeliveryStatus, error: string, now: Date, retryIn = 0) {
    await this.db
      .update(table)
      .set({
        status,
        error,
        attempts: row.attempts + 1,
        updatedAt: now,
        claimedAt: null,
        ...(status === 'sent' ? { sentAt: now } : {}),
        ...(retryIn ? { nextAttemptAt: new Date(now.getTime() + retryIn) } : {}),
      })
      .where(eq(table.id, row.id));
  }

  private async send(org: { id: string; name: string }, row: Row, teams: StoredTeams | null, now: Date) {
    const backoff = 60_000 * 2 ** row.attempts;
    const failOrRetry = (message: string) =>
      row.attempts + 1 >= MAX_ATTEMPTS
        ? this.finish(row, 'failed', message, now)
        : this.finish(row, 'pending', message, now, backoff);
    try {
      if (row.channel === 'email') {
        const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, row.destination));
        const entry = user ? { user, levels: await clientLevels(this.db, actorFor(user)) } : null;
        const check = entry
          ? this.canReceive(entry, { kind: row.kind as AlertKind, clientId: row.clientId ?? '' } as AlertEvent)
          : { ready: false, detail: 'No longer in Atlas.' };
        // Test sends go to the person who asked, for any client.
        if (!row.test && !check.ready) return this.finish(row, 'skipped', check.detail, now);
        if (!(await this.deps.mail.enabled(org.id))) return failOrRetry('Email is not set up.');
        await this.deps.mail.send(org.id, org.name, {
          to: user!.email,
          subject: row.subject,
          paragraphs: row.body
            .split(/\n\s*\n/)
            .map((p) => p.trim())
            .filter(Boolean),
          action: { label: 'Open in Atlas', url: row.link },
        });
        return this.finish(row, 'sent', '', now);
      }
      if (!teams?.enabled || !teams.connection) return failOrRetry('Microsoft Teams is not connected.');
      const mapping = teams.mappings.find((m) => m.clientId === row.clientId);
      const [teamId, channelId] = row.destination.split(':') as [string, string];
      if (!mapping || mapping.teamId !== teamId || ![mapping.channelId, mapping.securityChannelId].includes(channelId))
        return this.finish(row, 'skipped', 'The client’s Teams channel changed since this was queued.', now);
      const owner = await this.owner(org.id);
      if (!owner) return failOrRetry('The organization has no active owner to send as.');
      await this.deps.graph.notify(
        new Scope(this.db, actorFor(owner)),
        row.clientId!,
        { teamId, channelId },
        row.body,
        undefined,
        row.teamsFormat === 'formatted' ? 'formatted' : 'text',
      );
      return this.finish(row, 'sent', '', now);
    } catch (error) {
      if (error instanceof TeamsRequestError) {
        if (error.outcome === 'connection')
          // Waiting for someone to sign Teams back in doesn't use up attempts.
          return this.db
            .update(table)
            .set({
              status: 'pending',
              claimedAt: null,
              error: error.message,
              nextAttemptAt: new Date(now.getTime() + 60_000),
            })
            .where(eq(table.id, row.id));
        if (error.outcome === 'uncertain') return this.finish(row, 'uncertain', error.message, now);
        if (error.outcome === 'failed') return this.finish(row, 'failed', error.message, now);
        return failOrRetry(error.message);
      }
      if (error instanceof HttpError && error.status < 500) return this.finish(row, 'failed', error.message, now);
      return failOrRetry(row.channel === 'email' ? 'The email server didn’t accept the message.' : 'Sending failed.');
    }
  }

  // ---------- history, retry, test, dry run ----------
  async history(scope: Scope, query: unknown): Promise<AlertDeliveryPage> {
    const orgId = requireAlertAdmin(scope);
    const q = alertDeliveryQuerySchema.parse(query ?? {});
    const rows = await this.db
      .select({ row: table, clientName: schema.clients.name })
      .from(table)
      .leftJoin(schema.clients, eq(schema.clients.id, table.clientId))
      .where(
        and(
          eq(table.orgId, orgId),
          q.status ? eq(table.status, q.status) : undefined,
          q.before ? lt(table.createdAt, new Date(q.before)) : undefined,
        ),
      )
      .orderBy(desc(table.createdAt))
      .limit(51);
    const page = rows.slice(0, 50);
    return {
      deliveries: page.map(({ row, clientName }) => this.view(row, clientName)),
      nextBefore: rows.length > 50 ? page.at(-1)!.row.createdAt.toISOString() : null,
    };
  }
  private view(row: Row, clientName: string | null): AlertDeliveryView {
    return {
      id: row.id,
      test: row.test,
      version: row.version,
      ruleName: row.ruleName,
      kind: row.kind as AlertKind,
      clientId: row.clientId,
      clientName,
      itemName: row.itemName,
      channel: row.channel as AlertChannel,
      destination: row.destinationLabel,
      subject: row.subject,
      reason: row.reason,
      link: row.link,
      status: row.status as AlertDeliveryStatus,
      attempts: row.attempts,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      sentAt: row.sentAt?.toISOString() ?? null,
    };
  }

  async retry(scope: Scope, id: string, input: unknown, ip: string) {
    const orgId = requireAlertAdmin(scope);
    const { confirmUncertain } = alertRetrySchema.parse(input ?? {});
    const [row] = await this.db
      .select()
      .from(table)
      .where(and(eq(table.orgId, orgId), eq(table.id, id)));
    if (!row) throw new HttpError(404, 'Delivery not found.');
    if (row.status !== 'failed' && row.status !== 'uncertain')
      throw new HttpError(409, 'Only a failed delivery, or one to check, can be sent again.');
    if (row.status === 'uncertain' && !confirmUncertain)
      throw new HttpError(409, 'Check whether it arrived first. Sending again may send it twice.', 'uncertain');
    await this.db
      .update(table)
      .set({ status: 'pending', attempts: 0, error: '', nextAttemptAt: new Date(), claimedAt: null })
      .where(and(eq(table.id, id), eq(table.status, row.status)));
    await securityEvent(this.db, {
      orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: 'Alert delivery retried',
      detail: `${row.ruleName}; ${row.channel}`,
      ip,
    });
    return { ok: true };
  }

  /** Sends a saved draft template, with example details, to yourself or a client's Teams channel, now. */
  async testSend(scope: Scope, input: unknown, ip: string): Promise<AlertDeliveryView> {
    const orgId = requireAlertAdmin(scope);
    const body = alertTestSendSchema.parse(input);
    const drafts = await this.workspace.read(scope);
    const template = drafts.templates.find((t) => t.id === body.templateId);
    if (!template) throw new HttpError(404, 'Save the template first, then send a test.');
    let clientName = 'Example client';
    if (body.clientId) {
      await scope.require(body.clientId, 'read', 'Client');
      clientName = await this.clientName(body.clientId);
    }
    if (body.channel === 'teams' && !body.clientId)
      throw new HttpError(400, 'Choose the client whose Teams channel to post in.');
    const values = alertSampleValues(
      { kind: template.kind, clientId: body.clientId, itemKind: 'asset', daysRemaining: 14, severity: 'warning' },
      clientName,
      `${this.deps.publicOrigin}/`,
    );
    const rendered = renderAlertTemplate(template, values);
    const teams = await this.deps.teams.load(orgId);
    const mapping = body.clientId ? teams?.mappings.find((m) => m.clientId === body.clientId) : undefined;
    if (body.channel === 'teams' && (!teams?.enabled || !teams.connection || !mapping))
      throw new HttpError(409, 'Connect Microsoft Teams and map this client to a channel first.');
    const [row] = await this.db
      .insert(table)
      .values({
        orgId,
        ruleId: 'test',
        ruleName: `Test: ${template.name}`,
        kind: template.kind,
        test: true,
        clientId: body.clientId,
        itemName: values.itemName,
        eventKey: randomUUID(),
        reason: `Test sent by ${scope.actor.name}`,
        channel: body.channel,
        destination: body.channel === 'email' ? scope.actor.id : `${mapping!.teamId}:${mapping!.channelId}`,
        destinationLabel:
          body.channel === 'email' ? `${scope.actor.name} <${scope.actor.email}>` : `Teams: ${mapping!.channelName}`,
        subject: `[Test] ${rendered.emailSubject}`.slice(0, 300),
        body: body.channel === 'email' ? rendered.emailBody : `[Test] ${rendered.teamsBody}`,
        teamsFormat: template.teamsFormat ?? 'text',
        link: `${this.deps.publicOrigin}/`,
        status: 'sending',
        claimedAt: new Date(),
      })
      .returning();
    const [org] = await this.db
      .select({ id: schema.orgs.id, name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId));
    await this.send(org!, { ...row!, status: 'sending' }, teams, new Date());
    await securityEvent(this.db, {
      orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action: 'Alert test sent',
      detail: `${template.name}; ${body.channel}`,
      ip,
    });
    const [after] = await this.db.select().from(table).where(eq(table.id, row!.id));
    return this.view(after!, body.clientId ? clientName : null);
  }
  private async clientName(id: string) {
    const [c] = await this.db
      .select({ name: schema.clients.name })
      .from(schema.clients)
      .where(eq(schema.clients.id, id));
    return c?.name ?? 'Example client';
  }

  /** What the latest published rules would send right now, and to whom, without sending or queueing anything. */
  async dryRun(scope: Scope): Promise<AlertDryRun> {
    const orgId = requireAlertAdmin(scope);
    const published = await this.published(orgId);
    if (!published) return { version: null, events: 0, matches: [] };
    const { rules } = published.workspace;
    const events = await this.events(orgId, rules);
    const users = await this.recipients(orgId, rules);
    const teams = await this.deps.teams.load(orgId);
    const sent = await this.db
      .select({
        ruleId: table.ruleId,
        eventKey: table.eventKey,
        channel: table.channel,
        destination: table.destination,
      })
      .from(table)
      .where(and(eq(table.orgId, orgId), eq(table.test, false)));
    const done = new Set(sent.map((s) => `${s.ruleId}|${s.eventKey}|${s.channel}|${s.destination}`));
    const matches: AlertDryRun['matches'] = [];
    for (const rule of rules)
      for (const event of events) {
        const fires = alertRuleFires(rule, event);
        if (!fires) continue;
        const key = hash(`${event.key}:${fires.key}`);
        matches.push({
          ruleName: rule.name,
          kind: rule.kind,
          clientName: event.clientName,
          itemName: event.itemName,
          reason: fires.reason,
          destinations: (await this.destinations(orgId, rule, event, users, teams)).map((d) => ({
            channel: d.channel,
            label: d.label,
            ready: d.ready,
            detail: d.detail,
            alreadySent: done.has(`${rule.id}|${key}|${d.channel}|${d.destination}`),
          })),
        });
        if (matches.length >= 500) return { version: published.version, events: events.length, matches };
      }
    return { version: published.version, events: events.length, matches };
  }
}
