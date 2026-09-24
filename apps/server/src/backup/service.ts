import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { desc, eq } from 'drizzle-orm';
import { schema, type DatabaseHandle } from '@atlas/db';
import type { BackupRunView } from '@atlas/shared';
import type { KeyProvider } from '../crypto/keys.js';
import { HttpError } from '../errors.js';
import type { FileStorage } from '../services/storage.js';
import { encryptStream, frames } from './format.js';

/** Rows that only matter to live sign-ins, or to this backup run itself, are left out. */
export const SKIPPED_TABLES = new Set([
  'sessions',
  'auth_challenges',
  'password_resets',
  'trusted_devices',
  'backup_runs',
]);
const BATCH = 500;
const FILE_NAME = /^atlas-\d{8}-\d{6}(-\d+)?\.atlasbak$/;
const LOCK = 727280;

export interface BackupOptions {
  dir: string;
  keep: number;
  hour: number;
  enabled: boolean;
  appVersion: string;
}

const stamp = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-` +
  `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;

const view = (r: typeof schema.backupRuns.$inferSelect): BackupRunView => ({
  id: r.id,
  trigger: r.trigger as BackupRunView['trigger'],
  status: r.status as BackupRunView['status'],
  fileName: r.fileName,
  size: r.size,
  rows: r.rows,
  files: r.files,
  error: r.error,
  startedByName: r.startedByName,
  createdAt: r.createdAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
});

/**
 * Encrypted backups of the whole installation: every table (read in one consistent snapshot) and every
 * attachment, written as one .atlasbak file. Scheduled daily; administrators can also start one.
 */
export class BackupService {
  readonly dir: string;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly keys: KeyProvider,
    private readonly storage: FileStorage,
    readonly options: BackupOptions,
  ) {
    this.dir = resolve(options.dir);
  }

  async list(): Promise<BackupRunView[]> {
    await this.reclaim();
    const rows = await this.handle.db
      .select()
      .from(schema.backupRuns)
      .orderBy(desc(schema.backupRuns.createdAt))
      .limit(30);
    return rows.map(view);
  }

  /** The path of a finished backup's file, for downloading. */
  async file(id: string): Promise<{ path: string; name: string; size: number }> {
    const [row] = await this.handle.db.select().from(schema.backupRuns).where(eq(schema.backupRuns.id, id));
    if (!row?.fileName || row.status !== 'done' || !FILE_NAME.test(row.fileName))
      throw new HttpError(404, 'Backup not found.');
    const path = join(this.dir, row.fileName);
    const info = await stat(path).catch(() => null);
    if (!info) throw new HttpError(404, 'This backup file is no longer in the backup folder.');
    return { path, name: row.fileName, size: info.size };
  }

  start(intervalMs = 10 * 60_000) {
    if (!this.options.enabled) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Runs the day's scheduled backup once the backup hour has passed, if it hasn't run yet today. */
  async tick(now = new Date()) {
    if (!this.options.enabled || now.getHours() < this.options.hour) return null;
    await this.reclaim();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [last] = await this.handle.db
      .select({ createdAt: schema.backupRuns.createdAt, status: schema.backupRuns.status })
      .from(schema.backupRuns)
      .where(eq(schema.backupRuns.trigger, 'schedule'))
      .orderBy(desc(schema.backupRuns.createdAt))
      .limit(1);
    // One attempt a day: a failed run is reported on the status page rather than retried every few minutes.
    if (last && last.createdAt >= startOfDay) return null;
    return this.run('schedule', 'Scheduled backup').catch(() => null);
  }

  /** Marks runs left "running" by a restart or crash as failed. Call only while holding the backup lock. */
  private async failAbandoned() {
    await this.handle.db
      .update(schema.backupRuns)
      .set({ status: 'failed', error: 'Atlas stopped while this backup was running.', finishedAt: new Date() })
      .where(eq(schema.backupRuns.status, 'running'));
  }

  /** Clears abandoned runs if no backup is running anywhere right now. */
  private async reclaim() {
    if (this.running) return;
    const client = await this.handle.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [LOCK]);
      if (!rows[0]!.ok) return;
      try {
        await this.failAbandoned();
      } finally {
        await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  /** Makes a backup now. Only one runs at a time across all Atlas servers sharing the database. */
  async run(
    trigger: 'schedule' | 'manual',
    startedByName: string,
    onStarted?: (run: BackupRunView) => void,
  ): Promise<BackupRunView> {
    if (this.running) throw new HttpError(409, 'A backup is already running.');
    this.running = true;
    try {
      const lock = await this.handle.pool.connect();
      try {
        const { rows } = await lock.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [LOCK]);
        if (!rows[0]!.ok) throw new HttpError(409, 'A backup is already running.');
        try {
          await this.failAbandoned();
          return await this.write(trigger, startedByName, onStarted);
        } finally {
          await lock.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
        }
      } finally {
        lock.release();
      }
    } finally {
      this.running = false;
    }
  }

  private async write(
    trigger: 'schedule' | 'manual',
    startedByName: string,
    onStarted?: (run: BackupRunView) => void,
  ): Promise<BackupRunView> {
    const [run] = await this.handle.db.insert(schema.backupRuns).values({ trigger, startedByName }).returning();
    onStarted?.(view(run!));
    await mkdir(this.dir, { recursive: true });
    let name = `atlas-${stamp(run!.createdAt)}.atlasbak`;
    for (let n = 2; await stat(join(this.dir, name)).catch(() => null); n++)
      name = `atlas-${stamp(run!.createdAt)}-${n}.atlasbak`;
    const final = join(this.dir, name);
    const temp = `${final}.part`;
    const totals = { rows: 0, files: 0 };
    try {
      await pipeline(
        Readable.from(this.contents(totals)),
        createGzip({ level: 6 }),
        encryptStream(this.keys, this.options.appVersion),
        createWriteStream(temp, { mode: 0o600 }),
      );
      await rename(temp, final);
      const { size } = await stat(final);
      const [done] = await this.handle.db
        .update(schema.backupRuns)
        .set({ status: 'done', fileName: name, size, ...totals, finishedAt: new Date() })
        .where(eq(schema.backupRuns.id, run!.id))
        .returning();
      await this.prune();
      return view(done!);
    } catch (error) {
      await rm(temp, { force: true });
      await this.handle.db
        .update(schema.backupRuns)
        .set({
          status: 'failed',
          error: (error instanceof Error ? error.message : 'The backup failed.').slice(0, 500),
          finishedAt: new Date(),
        })
        .where(eq(schema.backupRuns.id, run!.id));
      throw error instanceof HttpError ? error : new HttpError(500, 'The backup failed. See the status page.');
    }
  }

  /** The backup's contents: manifest, then each table in batches, then attachment files, then a summary. */
  private async *contents(totals: { rows: number; files: number }): AsyncGenerator<Buffer> {
    const client = await this.handle.pool.connect();
    try {
      // One snapshot for every table, so the backup is consistent even while people keep working.
      await client.query('begin isolation level repeatable read read only');
      const tables = (
        await client.query<{ name: string }>(
          `select table_name as name from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
        )
      ).rows
        .map((r) => r.name)
        .filter((n) => !SKIPPED_TABLES.has(n));
      const migrations = await client.query<{ hash: string; created_at: string }>(
        'select hash, created_at::text from drizzle.__drizzle_migrations order by created_at',
      );
      yield frames.json('M', {
        format: 'msp-atlas-backup',
        version: 1,
        appVersion: this.options.appVersion,
        createdAt: new Date().toISOString(),
        migrations: migrations.rows.length,
        lastMigration: migrations.rows.at(-1)?.created_at ?? null,
        tables,
      });
      const counts: Record<string, number> = {};
      for (const table of tables) {
        let last = '(0,0)';
        counts[table] = 0;
        for (;;) {
          const page = await client.query<{ ctid: string; j: string }>(
            `select ctid::text as ctid, row_to_json(t)::text as j from "${table}" t
             where ctid > $1::tid order by ctid limit ${BATCH}`,
            [last],
          );
          if (!page.rows.length) break;
          last = page.rows.at(-1)!.ctid;
          counts[table] += page.rows.length;
          totals.rows += page.rows.length;
          yield frames.table(
            table,
            page.rows.map((r) => r.j),
          );
          if (page.rows.length < BATCH) break;
        }
      }
      const files = await client.query<{ storage_key: string }>(
        'select distinct storage_key from attachments order by storage_key',
      );
      await client.query('commit');
      const missing: string[] = [];
      for (const { storage_key: key } of files.rows) {
        let stream: Readable;
        try {
          stream = await this.storage.get(key);
        } catch {
          missing.push(key); // Already gone from disk; listed in the backup's summary.
          continue;
        }
        const size = await this.storage.size(key);
        yield frames.fileStart(key, size);
        let sent = 0;
        for await (const chunk of stream) {
          sent += (chunk as Buffer).length;
          if (sent > size) throw new Error(`Attachment ${key} changed during the backup.`);
          yield chunk as Buffer;
        }
        if (sent !== size) throw new Error(`Attachment ${key} changed during the backup.`);
        totals.files++;
      }
      yield frames.json('E', { rows: counts, files: totals.files, missingFiles: missing });
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Keeps the newest `keep` backup files; older ones are deleted from the backup folder. */
  private async prune() {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => FILE_NAME.test(n)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - this.options.keep))) {
      const path = resolve(this.dir, name);
      if (path.startsWith(this.dir + sep)) await rm(path, { force: true });
    }
  }

  /** For the status page: the backup folder's own files, newest first. */
  async files() {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => FILE_NAME.test(n)).sort();
    return names.reverse();
  }
}
