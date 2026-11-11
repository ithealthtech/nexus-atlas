import { createReadStream } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { migrationsFolder, runMigrations, type DatabaseHandle } from '@atlas/db';
import type { KeyProvider } from '../crypto/keys.js';
import type { FileStorage } from '../services/storage.js';
import { BackupFormatError, ByteReader, decryptStream } from './format.js';

export interface RestoreResult {
  appVersion: string;
  createdAt: string;
  tables: number;
  rows: number;
  /** Rows left out because this database already had them (adding back only). */
  skipped: number;
  files: number;
  missingFiles: string[];
}

interface Manifest {
  format: string;
  version: number;
  appVersion: string;
  createdAt: string;
  migrations: number;
  tables: string[];
}

const UNIQUE_VIOLATION = '23505';
/** Atlas 1.7.27 to 2.5.0 saved tables of more than 500 rows with some rows twice and others missing. */
const INCOMPLETE_BACKUP =
  'This backup is incomplete: it has some rows twice and is missing others, because of a fault in how Atlas 1.7.27 to 2.5.0 made backups of large tables. Nothing from it was kept. Restore a backup made by a later version of Atlas.';

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Opens a backup and checks every chunk, without writing anything. Returns what it contains. */
export async function verifyBackup(file: string, keys: KeyProvider) {
  const reader = open(file, keys);
  const manifest = await readManifest(reader);
  let rows = 0;
  let files = 0;
  for (;;) {
    const frame = await reader.frame();
    if (frame.kind === 'T') rows += frame.rows.length;
    else if (frame.kind === 'F') {
      for await (const piece of reader.pieces(frame.size)) void piece;
      files++;
    } else if (frame.kind === 'E') break;
    else throw new BackupFormatError('The backup contents are damaged.');
  }
  await reader.end();
  return {
    appVersion: manifest.appVersion,
    createdAt: manifest.createdAt,
    migrations: manifest.migrations,
    tables: manifest.tables.length,
    rows,
    files,
  };
}

/**
 * Restores a backup into an empty database (or, with `replace`, erases the database first), then brings the
 * schema up to date. Everything happens in one transaction: if any part of the file is damaged, nothing is kept.
 */
export async function restoreBackup(options: {
  handle: DatabaseHandle;
  keys: KeyProvider;
  storage: FileStorage;
  file: string;
  replace?: boolean;
  /** Skip the read-through check when the caller has just verified the file. */
  verified?: boolean;
  /** Runs just before an existing database is erased (with `replace`), after every check has passed. */
  beforeErase?: () => Promise<void>;
  log?: (line: string) => void;
}): Promise<RestoreResult> {
  const { handle, keys, storage, log = () => undefined } = options;
  // A damaged or altered file is found before anything in the database changes.
  if (!options.verified) await verifyBackup(options.file, keys);
  const reader = open(options.file, keys);
  const manifest = await readManifest(reader);
  log(`Backup from ${manifest.createdAt} (Atlas ${manifest.appVersion}).`);
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  // Every check that can refuse the backup happens before anything is erased.
  if (manifest.migrations > journal.entries.length)
    throw new Error('This backup was made by a newer version of Atlas. Upgrade Atlas first, then restore.');
  const existing = await handle.pool.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
  );
  if (existing.rows[0]!.n > 0) {
    if (!options.replace)
      throw new Error(
        'This database already has Atlas tables. Restore into a new, empty database, or add --replace to erase this one first.',
      );
    log('Erasing the current database…');
    await options.beforeErase?.();
    await handle.pool.query('drop schema if exists drizzle cascade; drop schema public cascade; create schema public;');
  }

  // Build the schema exactly as it was when the backup was made; newer migrations run after the data is in.
  const folder = await mkdtemp(join(tmpdir(), 'atlas-restore-'));
  try {
    await cp(migrationsFolder, folder, { recursive: true });
    await writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, manifest.migrations) }),
    );
    await runMigrations(handle, folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }

  const loaded = await load({ handle, storage, reader, manifest, mode: 'replace' });
  log(`Restored ${loaded.rows} rows and ${loaded.files} files.`);
  await runMigrations(handle);
  return { appVersion: manifest.appVersion, createdAt: manifest.createdAt, ...loaded };
}

/** Rows in these tables are never added back into a working database: the security log is an unbroken chain. */
const MERGE_SKIPPED = new Set(['security_events']);

/** Why a backup can't be merged into this database, or null when it can. */
export async function mergeBlocked(manifest: { migrations: number }) {
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  if (manifest.migrations === journal.entries.length) return null;
  return manifest.migrations > journal.entries.length
    ? 'This backup was made by a newer version of Atlas. Upgrade Atlas first.'
    : 'This backup was made by an older version of Atlas, whose database was laid out differently. Only overwriting can restore it.';
}

/**
 * Adds back the rows and attachments in a backup that this database doesn't have, keeping every row it does have
 * as it is now. Rows are matched by their keys; the security log is left alone. The backup must come from the
 * same Atlas database layout. One transaction: if any row can't go in (for example because it points at
 * something that was replaced since), nothing is kept.
 */
export async function mergeBackup(options: {
  handle: DatabaseHandle;
  keys: KeyProvider;
  storage: FileStorage;
  file: string;
  verified?: boolean;
  log?: (line: string) => void;
}): Promise<RestoreResult> {
  const { handle, keys, storage, log = () => undefined } = options;
  if (!options.verified) await verifyBackup(options.file, keys);
  const reader = open(options.file, keys);
  const manifest = await readManifest(reader);
  const blocked = await mergeBlocked(manifest);
  if (blocked) throw new Error(blocked);
  log(`Adding back what's missing from the backup of ${manifest.createdAt} (Atlas ${manifest.appVersion}).`);
  const loaded = await load({ handle, storage, reader, manifest, mode: 'merge' });
  log(`Added ${loaded.rows} rows and ${loaded.files} files; ${loaded.skipped} rows were already here.`);
  return { appVersion: manifest.appVersion, createdAt: manifest.createdAt, ...loaded };
}

/** Reads every table and file frame into the database in one transaction. */
async function load(options: {
  handle: DatabaseHandle;
  storage: FileStorage;
  reader: FrameReader;
  manifest: Manifest;
  mode: 'replace' | 'merge';
}) {
  const { handle, storage, reader, manifest, mode } = options;
  const merge = mode === 'merge';
  const client = await handle.pool.connect();
  const written: string[] = [];
  try {
    await client.query('begin');
    const tables = new Set(
      (
        await client.query<{ name: string }>(
          `select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
        )
      ).rows.map((r) => r.name),
    );
    const columns = new Map<string, string[]>();
    for (const row of (
      await client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = 'public' and is_generated = 'NEVER' order by table_name, ordinal_position`,
      )
    ).rows)
      columns.set(row.table_name, [...(columns.get(row.table_name) ?? []), row.column_name]);
    const foreignKeys = (
      await client.query<{ tbl: string; name: string }>(
        `select conrelid::regclass::text as tbl, conname as name from pg_constraint
         where contype = 'f' and connamespace = 'public'::regnamespace`,
      )
    ).rows;
    // Rows go in table by table, so references are checked at the end rather than row by row. In a full restore
    // the security log's triggers are paused so its hash chain is kept exactly as it was.
    for (const fk of foreignKeys)
      await client.query(`alter table ${fk.tbl} alter constraint ${quote(fk.name)} deferrable initially deferred`);
    await client.query('set constraints all deferred');
    if (!merge) for (const table of tables) await client.query(`alter table ${quote(table)} disable trigger user`);

    const counts: Record<string, number> = {};
    let rows = 0;
    let skipped = 0;
    let files = 0;
    type Summary = { rows: Record<string, number>; files: number; missingFiles?: string[] };
    let summary = null as Summary | null;
    while (!summary) {
      const frame = await reader.frame();
      if (frame.kind === 'T') {
        if (!tables.has(frame.name) || !manifest.tables.includes(frame.name))
          throw new BackupFormatError(`The backup has rows for an unknown table "${frame.name}".`);
        counts[frame.name] = (counts[frame.name] ?? 0) + frame.rows.length;
        if (merge && MERGE_SKIPPED.has(frame.name)) {
          skipped += frame.rows.length;
          continue;
        }
        const cols = columns.get(frame.name)!.map(quote).join(', ');
        const result = await client
          .query(
            `insert into ${quote(frame.name)} (${cols}) select ${cols} from json_populate_recordset(null::${quote(frame.name)}, $1::json)` +
              (merge ? ' on conflict do nothing' : ''),
            [JSON.stringify(frame.rows)],
          )
          .catch((error: unknown) => {
            if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
            throw new BackupFormatError(INCOMPLETE_BACKUP, { cause: error });
          });
        const added = merge ? (result.rowCount ?? 0) : frame.rows.length;
        rows += added;
        skipped += frame.rows.length - added;
      } else if (frame.kind === 'F') {
        const pieces = Readable.from(reader.pieces(frame.size));
        if (merge && (await storage.size(frame.key).catch(() => null)) !== null) {
          for await (const piece of pieces) void piece;
          continue;
        }
        await storage.restore(frame.key, pieces);
        written.push(frame.key);
        files++;
      } else if (frame.kind === 'E') {
        summary = frame.json as Summary;
      } else throw new BackupFormatError('The backup contents are damaged.');
    }
    await reader.end();
    for (const [table, n] of Object.entries(summary.rows))
      if ((counts[table] ?? 0) !== n) throw new BackupFormatError(`The backup is missing rows from ${table}.`);
    if (!merge && files !== summary.files) throw new BackupFormatError('The backup is missing attachment files.');

    // Serial IDs continue after the restored rows (and, when adding back, never move backwards).
    const serials = await client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and column_default like 'nextval(%'`,
    );
    for (const s of serials.rows)
      await client.query(
        merge
          ? `select setval(pg_get_serial_sequence($1, $2), greatest(coalesce((select max(${quote(s.column_name)}) from ${quote(s.table_name)}), 0),
               (select last_value from pg_sequences where format('%I.%I', schemaname, sequencename) = pg_get_serial_sequence($1, $2)), 1))`
          : `select setval(pg_get_serial_sequence($1, $2), coalesce((select max(${quote(s.column_name)}) from ${quote(s.table_name)}), 0) + 1, false)`,
        [quote(s.table_name), s.column_name],
      );

    // Check every reference now (this fails the restore if any row points at something missing), then put the
    // triggers and constraints back as they were.
    try {
      await client.query('set constraints all immediate');
    } catch (error) {
      if (!merge) throw error;
      throw new Error(
        'Some rows in the backup point at records this installation no longer has in the same form, so nothing was added. Overwrite instead, or restore a newer backup.',
        { cause: error },
      );
    }
    if (!merge) for (const table of tables) await client.query(`alter table ${quote(table)} enable trigger user`);
    for (const fk of foreignKeys)
      await client.query(`alter table ${fk.tbl} alter constraint ${quote(fk.name)} not deferrable`);
    await client.query('commit');
    return {
      tables: Object.keys(counts).length,
      rows,
      skipped,
      files,
      missingFiles: summary.missingFiles ?? [],
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    for (const key of written) await storage.remove(key).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function open(file: string, keys: KeyProvider) {
  const decrypt = decryptStream(keys);
  const gunzip = createGunzip();
  const source = createReadStream(file);
  // Errors anywhere in the chain surface through the reader.
  source.on('error', (e) => gunzip.destroy(e));
  decrypt.on('error', (e) => gunzip.destroy(e));
  source.pipe(decrypt).pipe(gunzip);
  return new FrameReader(gunzip);
}

class FrameReader extends ByteReader {
  /** Confirms nothing follows the end marker (the encryption layer has already checked the file's end). */
  async end() {
    if (!(await this.atEnd())) throw new BackupFormatError('The backup has data after its end.');
  }
}

async function readManifest(reader: ByteReader): Promise<Manifest> {
  const first = await reader.frame().catch((error: unknown) => {
    if (error instanceof BackupFormatError) throw error;
    const message = error instanceof Error ? error.message : '';
    throw new BackupFormatError(
      /BackupFormatError|backup/i.test(message) ? message : 'The backup is damaged or was changed after it was made.',
    );
  });
  const manifest = first.kind === 'M' ? (first.json as Manifest) : null;
  if (manifest?.format !== 'msp-atlas-backup' || manifest.version !== 1)
    throw new BackupFormatError('This file is not an Atlas backup.');
  return manifest;
}
