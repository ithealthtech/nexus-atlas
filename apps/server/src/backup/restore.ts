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
  log?: (line: string) => void;
}): Promise<RestoreResult> {
  const { handle, keys, storage, log = () => undefined } = options;
  // A damaged or altered file is found before anything in the database changes.
  if (!options.verified) await verifyBackup(options.file, keys);
  const existing = await handle.pool.query<{ n: number }>(
    `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
  );
  if (existing.rows[0]!.n > 0) {
    if (!options.replace)
      throw new Error(
        'This database already has Atlas tables. Restore into a new, empty database, or add --replace to erase this one first.',
      );
    log('Erasing the current database…');
    await handle.pool.query('drop schema if exists drizzle cascade; drop schema public cascade; create schema public;');
  }

  const reader = open(options.file, keys);
  const manifest = await readManifest(reader);
  log(`Backup from ${manifest.createdAt} (Atlas ${manifest.appVersion}).`);

  // Build the schema exactly as it was when the backup was made; newer migrations run after the data is in.
  const journal = JSON.parse(await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  if (manifest.migrations > journal.entries.length)
    throw new Error('This backup was made by a newer version of Atlas. Upgrade Atlas first, then restore.');
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
    // Rows go in table by table, so references are checked at the end rather than row by row, and the audit
    // log's triggers are paused so its hash chain is kept exactly as it was.
    for (const fk of foreignKeys)
      await client.query(`alter table ${fk.tbl} alter constraint ${quote(fk.name)} deferrable initially deferred`);
    await client.query('set constraints all deferred');
    for (const table of tables) await client.query(`alter table ${quote(table)} disable trigger user`);

    const counts: Record<string, number> = {};
    let rows = 0;
    let files = 0;
    type Summary = { rows: Record<string, number>; files: number; missingFiles?: string[] };
    let summary = null as Summary | null;
    while (!summary) {
      const frame = await reader.frame();
      if (frame.kind === 'T') {
        if (!tables.has(frame.name) || !manifest.tables.includes(frame.name))
          throw new BackupFormatError(`The backup has rows for an unknown table "${frame.name}".`);
        const cols = columns.get(frame.name)!.map(quote).join(', ');
        await client.query(
          `insert into ${quote(frame.name)} (${cols}) select ${cols} from json_populate_recordset(null::${quote(frame.name)}, $1::json)`,
          [JSON.stringify(frame.rows)],
        );
        counts[frame.name] = (counts[frame.name] ?? 0) + frame.rows.length;
        rows += frame.rows.length;
      } else if (frame.kind === 'F') {
        await storage.restore(frame.key, Readable.from(reader.pieces(frame.size)));
        written.push(frame.key);
        files++;
      } else if (frame.kind === 'E') {
        summary = frame.json as Summary;
      } else throw new BackupFormatError('The backup contents are damaged.');
    }
    await reader.end();
    for (const [table, n] of Object.entries(summary!.rows))
      if ((counts[table] ?? 0) !== n) throw new BackupFormatError(`The backup is missing rows from ${table}.`);
    if (files !== summary!.files) throw new BackupFormatError('The backup is missing attachment files.');

    // Serial IDs continue after the restored rows.
    const serials = await client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and column_default like 'nextval(%'`,
    );
    for (const s of serials.rows)
      await client.query(
        `select setval(pg_get_serial_sequence($1, $2), coalesce((select max(${quote(s.column_name)}) from ${quote(s.table_name)}), 0) + 1, false)`,
        [quote(s.table_name), s.column_name],
      );

    // Check every reference now (this fails the restore if any row points at something missing), then put the
    // triggers and constraints back as they were.
    await client.query('set constraints all immediate');
    for (const table of tables) await client.query(`alter table ${quote(table)} enable trigger user`);
    for (const fk of foreignKeys)
      await client.query(`alter table ${fk.tbl} alter constraint ${quote(fk.name)} not deferrable`);
    await client.query('commit');
    log(`Restored ${rows} rows and ${files} files.`);

    await runMigrations(handle);
    return {
      appVersion: manifest.appVersion,
      createdAt: manifest.createdAt,
      tables: Object.keys(counts).length,
      rows,
      files,
      missingFiles: summary!.missingFiles ?? [],
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
