import { and, eq, lt, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, healthGrade, type ExpirationItem, type HealthWeek, type Role } from '@atlas/shared';
import { actorFor } from '../identity/service.js';
import { DEVICE_LIMITS } from '../identity/devices.js';
import type { AuditService } from './audit.js';
import type { ExpirationService } from './expirations.js';
import type { MailService } from './mail.js';
import { Scope } from './scope.js';
import type { SettingsService } from './settings.js';
import { Repeating, type ErrorLog } from './repeating.js';

const LINK: Record<ExpirationItem['kind'], string> = { asset: 'assets', password: 'passwords', document: 'documents' };

/** ISO week label such as 2026-W39, used to send one weekly digest per person. */
export function isoWeek(date: Date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Background work, run every few minutes: expiry alerts and the weekly digest by email, audit checkpoints,
 * log retention, emergency access notices, and cleanup of expired sign-in records. A database lock keeps two servers from both sending.
 */
export class Notifier {
  private readonly schedule = new Repeating(() => this.tick());
  private log: ErrorLog = () => undefined;
  private running = false;
  /** When background work last completed, for the status page. */
  lastRunAt: Date | null = null;

  constructor(
    private readonly db: Database,
    private readonly deps: {
      mail: MailService;
      settings: SettingsService;
      expirations: ExpirationService;
      audit: AuditService;
      /** Announces emergency access whose waiting period has ended. */
      emergency?: { announceStarts(orgId: string, now?: Date): Promise<number> };
      /** Daily breach checks for stored passwords. */
      health?: { nightly(orgId: string): Promise<void> };
      /** Scheduled reports that have come due. Records each outcome on its schedule rather than throwing. */
      reports?: { runDue(orgId: string, now?: Date): Promise<void> };
      /** Keeps each client's health score current through the day, for its trend, and compares it week on week. */
      clientHealth?: {
        refresh(orgId: string): Promise<void>;
        week(orgId: string, now?: number): Promise<HealthWeek[]>;
      };
      publicOrigin: string;
      /** Local hour (0–23) after which the day's emails go out. */
      sendHour: number;
    },
  ) {}

  start(log: ErrorLog, intervalMs = 10 * 60_000) {
    this.log = log;
    this.schedule.start(intervalMs, log);
  }

  stop() {
    this.schedule.stop();
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const locked = await this.db.execute(sql`select pg_try_advisory_lock(727277) as ok`);
      if (!(locked.rows[0] as { ok: boolean }).ok) return;
      try {
        await this.cleanup();
        const orgs = await this.db.select({ id: schema.orgs.id, name: schema.orgs.name }).from(schema.orgs);
        for (const org of orgs) {
          await this.deps.audit.applyRetention(org.id);
          await this.deps.emergency?.announceStarts(org.id, now).catch(this.log);
          await this.deps.health?.nightly(org.id).catch(this.log);
          await this.deps.reports?.runDue(org.id, now);
          await this.deps.clientHealth?.refresh(org.id).catch(this.log);
          await this.deps.audit.checkpoint(org.id);
          // Infections can't wait for the morning email.
          await this.alertInfections(org, now).catch(this.log);
          if (now.getHours() >= this.deps.sendHour) {
            await this.sendForOrg(org, now);
            await this.sendOwnerDigest(org, now).catch(this.log);
          }
        }
        this.lastRunAt = new Date();
      } finally {
        await this.db.execute(sql`select pg_advisory_unlock(727277)`);
      }
    } finally {
      this.running = false;
    }
  }

  private async cleanup() {
    const now = new Date();
    await this.db.delete(schema.passwordResets).where(lt(schema.passwordResets.expiresAt, now));
    await this.db.delete(schema.authChallenges).where(lt(schema.authChallenges.expiresAt, now));
    await this.db.delete(schema.trustedDevices).where(lt(schema.trustedDevices.expiresAt, now));
    await this.db.delete(schema.nativeAuthCodes).where(lt(schema.nativeAuthCodes.expiresAt, now));
    await this.db.delete(schema.devicePairings).where(lt(schema.devicePairings.expiresAt, now));
    await this.db
      .delete(schema.deviceSessions)
      .where(
        or(
          lt(schema.deviceSessions.expiresAt, now),
          lt(schema.deviceSessions.lastSeenAt, new Date(now.getTime() - DEVICE_LIMITS.idleMs)),
        ),
      );
    await this.db
      .delete(schema.notificationLog)
      .where(lt(schema.notificationLog.sentAt, new Date(now.getTime() - 120 * 86_400_000)));
  }

  /** Records a send; false when this key was already sent (so each email goes out once). */
  private async claim(key: string, userId: string) {
    const rows = await this.db
      .insert(schema.notificationLog)
      .values({ key, userId })
      .onConflictDoNothing()
      .returning({ key: schema.notificationLog.key });
    return rows.length > 0;
  }

  private async unclaim(key: string) {
    await this.db.delete(schema.notificationLog).where(eq(schema.notificationLog.key, key));
  }

  async sendForOrg(org: { id: string; name: string }, now = new Date()) {
    if (!(await this.deps.mail.enabled(org.id))) return;
    const prefs = await this.deps.settings.notifications(org.id);
    const window = Math.max(30, ...prefs.alertDays);
    const users = await this.db
      .select()
      .from(schema.users)
      .where(
        and(eq(schema.users.orgId, org.id), eq(schema.users.disabled, false), eq(schema.users.notifyDigest, true)),
      );
    const day = now.toISOString().slice(0, 10);
    const monday = now.getDay() === 1;
    for (const user of users) {
      if (!ROLE_INFO[user.role as Role].staff) continue;
      const items = await this.deps.expirations.list(new Scope(this.db, actorFor(user)), window);
      const alerts = items.filter((i) => i.daysLeft === 0 || prefs.alertDays.includes(i.daysLeft));
      const digestKey = `digest:${user.id}:${isoWeek(now)}`;
      if (prefs.weeklyDigest && monday && items.length && (await this.claim(digestKey, user.id))) {
        await this.send(org, user.email, 'Weekly expirations digest', items, window).catch(() =>
          this.unclaim(digestKey),
        );
        continue; // The digest already lists today's alerts.
      }
      const alertKey = `alert:${user.id}:${day}`;
      if (alerts.length && (await this.claim(alertKey, user.id)))
        await this.send(org, user.email, 'Expiring soon', alerts, window).catch(() => this.unclaim(alertKey));
    }
  }

  /**
   * Emails staff who can see a client when Bitdefender reports one of its endpoints infected: once per endpoint per
   * day while it stays infected, listing every infected endpoint they can see.
   */
  async alertInfections(org: { id: string; name: string }, now = new Date()) {
    const t = schema.bitdefenderEndpoints;
    const infected = await this.db
      .select({ id: t.endpointId, name: t.name, clientId: t.clientId, clientName: schema.clients.name })
      .from(t)
      .innerJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .where(and(eq(t.orgId, org.id), eq(t.infected, true)))
      .orderBy(schema.clients.name, t.name);
    if (!infected.length || !(await this.deps.mail.enabled(org.id))) return;
    const users = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, org.id), eq(schema.users.disabled, false)));
    const day = now.toISOString().slice(0, 10);
    for (const user of users) {
      if (!ROLE_INFO[user.role as Role].staff) continue;
      const readable = new Set(await new Scope(this.db, actorFor(user)).readableClientIds());
      const visible = infected.filter((e) => readable.has(e.clientId));
      const claimed: string[] = [];
      for (const e of visible) {
        const key = `infected:${user.id}:${e.id}:${day}`;
        if (await this.claim(key, user.id)) claimed.push(key);
      }
      if (!claimed.length) continue;
      await this.deps.mail
        .send(org.id, org.name, {
          to: user.email,
          subject: `Bitdefender: ${visible.length} infected endpoint${visible.length === 1 ? '' : 's'}`,
          paragraphs: ['GravityZone reports malware on these endpoints. Check them in GravityZone.'],
          rows: visible.slice(0, 100).map((e) => ({
            cells: [e.name, e.clientName, 'Infected'],
            url: `${this.deps.publicOrigin}/clients/${e.clientId}`,
          })),
          action: { label: 'Open Atlas', url: this.deps.publicOrigin },
        })
        .catch(async (err) => {
          for (const key of claimed) await this.unclaim(key);
          throw err;
        });
    }
  }

  /**
   * Monday morning, to owners and administrators: how client health moved last week. Average score and its change,
   * then each client that moved by 3 points or more, biggest drop first. Once a week, with the weekly digest setting.
   */
  async sendOwnerDigest(org: { id: string; name: string }, now = new Date()) {
    if (now.getDay() !== 1 || !this.deps.clientHealth) return;
    if (!(await this.deps.mail.enabled(org.id)) || !(await this.deps.settings.notifications(org.id)).weeklyDigest)
      return;
    const week = (await this.deps.clientHealth.week(org.id, now.getTime())).filter((c) => c.score !== null);
    if (!week.length) return;
    const users = await this.db
      .select()
      .from(schema.users)
      .where(
        and(eq(schema.users.orgId, org.id), eq(schema.users.disabled, false), eq(schema.users.notifyDigest, true)),
      );
    for (const user of users.filter((u) => ROLE_INFO[u.role as Role].admin)) {
      const readable = new Set(await new Scope(this.db, actorFor(user)).readableClientIds());
      const mine = week.filter((c) => readable.has(c.clientId));
      if (!mine.length) continue;
      const key = `owner-digest:${user.id}:${isoWeek(now)}`;
      if (!(await this.claim(key, user.id))) continue;
      const average = (list: number[]) => Math.round(list.reduce((n, s) => n + s, 0) / list.length);
      const current = average(mine.map((c) => c.score!));
      const before = mine.filter((c) => c.previous !== null);
      const was = before.length ? average(before.map((c) => c.previous!)) : null;
      const moved = mine
        .filter((c) => c.previous !== null && Math.abs(c.score! - c.previous) >= 3)
        .sort((a, b) => a.score! - a.previous! - (b.score! - b.previous!));
      const signed = (n: number) => (n > 0 ? `up ${n}` : `down ${-n}`);
      await this.deps.mail
        .send(org.id, org.name, {
          to: user.email,
          subject: `Client health this week: average ${current}${was !== null && was !== current ? ` (${signed(current - was)})` : ''}`,
          paragraphs: [
            `Across ${mine.length} client${mine.length === 1 ? '' : 's'}, the average health score is ${current}${was === null ? '.' : was === current ? ', the same as a week ago.' : `, ${signed(current - was)} from ${was} a week ago.`}`,
            moved.length
              ? 'These clients moved by 3 points or more, biggest drop first.'
              : 'No client moved by 3 points or more.',
          ],
          rows: moved.slice(0, 25).map((c) => ({
            cells: [c.clientName, String(c.score), signed(c.score! - c.previous!), healthGrade(c.score).label],
            url: `${this.deps.publicOrigin}/clients/${c.clientId}`,
          })),
          action: { label: 'Open Atlas', url: this.deps.publicOrigin },
        })
        .catch(async (err) => {
          await this.unclaim(key);
          throw err;
        });
    }
  }

  private async send(
    org: { id: string; name: string },
    to: string,
    title: string,
    items: ExpirationItem[],
    window: number,
  ) {
    const overdue = items.filter((i) => i.daysLeft < 0).length;
    await this.deps.mail.send(org.id, org.name, {
      to,
      subject: `${title}: ${items.length} item${items.length === 1 ? '' : 's'}${overdue ? ` (${overdue} overdue)` : ''}`,
      paragraphs: [
        title === 'Expiring soon'
          ? 'These items reach an alert date today.'
          : `Everything you can see that expires, or is due, in the next ${window} days.`,
      ],
      rows: items.slice(0, 100).map((i) => ({
        cells: [
          i.title,
          i.label,
          i.clientName ?? 'Knowledge base',
          i.daysLeft < 0 ? `${-i.daysLeft} days overdue` : i.daysLeft === 0 ? 'Today' : `in ${i.daysLeft} days`,
        ],
        url: `${this.deps.publicOrigin}/${LINK[i.kind]}/${i.id}`,
      })),
      action: { label: 'Open expirations', url: `${this.deps.publicOrigin}/expirations` },
    });
  }
}
