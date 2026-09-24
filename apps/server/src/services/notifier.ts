import { and, eq, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, type ExpirationItem, type Role } from '@atlas/shared';
import { actorFor } from '../identity/service.js';
import type { AuditService } from './audit.js';
import type { ExpirationService } from './expirations.js';
import type { MailService } from './mail.js';
import { Scope } from './scope.js';
import type { SettingsService } from './settings.js';

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
 * log retention, and cleanup of expired sign-in records. A database lock keeps two servers from both sending.
 */
export class Notifier {
  private timer?: NodeJS.Timeout;
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
      publicOrigin: string;
      /** Local hour (0–23) after which the day's emails go out. */
      sendHour: number;
    },
  ) {}

  start(intervalMs = 10 * 60_000) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
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
          await this.deps.audit.checkpoint(org.id);
          if (now.getHours() >= this.deps.sendHour) await this.sendForOrg(org, now);
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
