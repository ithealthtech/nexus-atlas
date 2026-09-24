import { readFile, statfs } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { count, eq, sql } from 'drizzle-orm';
import { migrationsFolder, schema, type DatabaseHandle } from '@atlas/db';
import type { Actor, StatusCheck, SystemStatus } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { BackupService } from '../backup/service.js';
import type { Config } from '../config.js';
import type { KeyProvider } from '../crypto/keys.js';
import type { Notifier } from './notifier.js';
import type { SettingsService } from './settings.js';

const DAY = 86_400_000;

/** How long ago something happened, in words that don't depend on the server's or the reader's time zone. */
export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute ago';
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

async function disk(path: string) {
  try {
    const s = await statfs(path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return { free: null, total: null };
  }
}

/** What an administrator needs to know the installation is healthy, with plain-language warnings. */
export class StatusService {
  private readonly startedAt = new Date();

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly deps: {
      config: Config;
      keys: KeyProvider;
      backups: BackupService;
      settings: SettingsService;
      notifier: Notifier;
      version: string;
    },
  ) {}

  async status(actor: Actor, now = new Date()): Promise<SystemStatus> {
    requireAdmin(actor);
    const { config, keys, backups, settings, notifier } = this.deps;
    const db = this.handle.db;
    const dataDir = resolve(config.ATLAS_DATA_DIR);

    const [pg] = (
      await db.execute(
        sql`select current_setting('server_version') as version, pg_database_size(current_database())::bigint as size`,
      )
    ).rows as { version: string; size: string }[];
    const applied = Number(
      ((await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0] as { n: number }).n,
    );
    const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[];
    };
    const [files] = await db
      .select({ n: count(), bytes: sql<string>`coalesce(sum(${schema.attachments.size}), 0)::bigint` })
      .from(schema.attachments);
    const [events] = await db
      .select({ n: count() })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.orgId, actor.orgId));
    const checkpoint = await settings.auditCheckpoint(actor.orgId);
    const smtp = await settings.smtpView(actor.orgId);
    const runs = await backups.list();
    // A run only counts while its file is still in the backup folder (not deleted, moved, or on an unmounted share).
    let lastSuccess: (typeof runs)[number] | undefined;
    for (const run of runs.filter((r) => r.status === 'done')) {
      if (
        await backups.file(run.id).then(
          () => true,
          () => false,
        )
      ) {
        lastSuccess = run;
        break;
      }
    }
    const missingFile = runs.find((r) => r.status === 'done') !== lastSuccess;
    const dataDisk = await disk(dataDir);
    const backupDisk = await disk(backups.dir);

    let nextAt: string | null = null;
    if (backups.options.enabled) {
      // Today's slot, or tomorrow's once today's backup has run. A slot that has passed is due now.
      const ranToday = runs.some((r) => r.trigger === 'schedule' && new Date(r.createdAt) >= startOfDay(now));
      const slot = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + (ranToday ? 1 : 0),
        backups.options.hour,
      );
      nextAt = (slot < now ? now : slot).toISOString();
    }

    const checks: StatusCheck[] = [];
    const add = (id: string, level: StatusCheck['level'], title: string, detail: string) =>
      checks.push({ id, level, title, detail });
    if (!backups.options.enabled)
      add(
        'backups',
        'warn',
        'Automatic backups are off',
        'Set ATLAS_BACKUP_ENABLED=true, or make sure another backup covers the database and attachments.',
      );
    else if (!lastSuccess)
      add('backups', 'warn', 'No backup yet', 'Choose "Back up now", or wait for tonight\'s scheduled backup.');
    else if (now.getTime() - Date.parse(lastSuccess.createdAt) > 2 * DAY)
      add(
        'backups',
        'error',
        'The last backup is more than two days old',
        'Check the backup history below for errors, and that the backup folder is writable.',
      );
    else
      add(
        'backups',
        'ok',
        'Backups are current',
        `The last backup finished ${ago(now.getTime() - Date.parse(lastSuccess.finishedAt ?? lastSuccess.createdAt))}.`,
      );
    if (missingFile)
      add(
        'backup-missing',
        'error',
        'The newest backup file is missing',
        `It is no longer in ${backups.dir}. Check that the folder or share is available.`,
      );
    const lastRun = runs[0];
    if (lastRun?.status === 'failed')
      add('backup-failed', 'error', 'The last backup failed', lastRun.error ?? 'See the backup history.');
    if (resolve(backups.dir).startsWith(dataDir + sep))
      add(
        'backup-location',
        'warn',
        'Backups are on the same disk as Atlas',
        'Copy the backup folder somewhere else (another server, a NAS, or cloud storage), or set ATLAS_BACKUP_DIR to a network share.',
      );
    for (const [id, label, d] of [
      ['disk-data', 'data', dataDisk],
      ['disk-backups', 'backup', backupDisk],
    ] as const)
      if (d.free !== null && d.total && d.free / d.total < 0.1)
        add(id, 'warn', `The ${label} disk is almost full`, `${Math.round((d.free / d.total) * 100)}% free.`);
    if (!smtp.enabled)
      add(
        'email',
        'warn',
        'Email is not set up',
        'Password resets and expiry alerts need email. See Settings → Email.',
      );
    if (keys.keyIds.length > 1)
      add(
        'keys',
        'warn',
        'An old master key is still loaded',
        'After rewrap-keys, the database no longer needs it, but backups made before the rotation do. Keep a copy of the old key for as long as you keep those backups.',
      );
    if (!checkpoint || now.getTime() - Date.parse(checkpoint.at) > 2 * DAY)
      add(
        'audit',
        'warn',
        'The security log has not been checked recently',
        'Open the security log and choose "Verify now".',
      );
    if (applied < journal.entries.length)
      add('migrations', 'error', 'Database updates are pending', 'Restart Atlas to apply them.');

    return {
      version: this.deps.version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      startedAt: this.startedAt.toISOString(),
      publicUrl: config.PUBLIC_URL,
      checks: checks.sort((a, b) => rank(b.level) - rank(a.level)),
      database: {
        version: pg!.version,
        sizeBytes: Number(pg!.size),
        migrationsApplied: applied,
        migrationsAvailable: journal.entries.length,
      },
      storage: {
        dataDir,
        freeBytes: dataDisk.free,
        totalBytes: dataDisk.total,
        attachments: files!.n,
        attachmentBytes: Number(files!.bytes),
      },
      backups: {
        enabled: backups.options.enabled,
        dir: backups.dir,
        hour: backups.options.hour,
        keep: backups.options.keep,
        freeBytes: backupDisk.free,
        lastSuccessAt: lastSuccess?.createdAt ?? null,
        nextAt,
        runs,
      },
      email: { enabled: smtp.enabled, host: smtp.host },
      keys: { current: keys.keyId, loaded: keys.keyIds.length },
      audit: { events: events!.n, lastCheckpointAt: checkpoint?.at ?? null },
      background: { lastRunAt: notifier.lastRunAt?.toISOString() ?? null },
    };
  }
}

const rank = (level: StatusCheck['level']) => ({ ok: 0, warn: 1, error: 2 })[level];
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
