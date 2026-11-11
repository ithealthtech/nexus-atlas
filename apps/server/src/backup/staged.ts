import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { schema, type DatabaseHandle } from '@atlas/db';
import type { RestoreCheck, RestoreOutcome, RestoreSource, RestoreStatus } from '@atlas/shared';
import { staticKeyProvider, type KeyProvider } from '../crypto/keys.js';
import { rewrapMasterSecrets } from '../crypto/rewrap.js';
import { HttpError } from '../errors.js';
import { securityEvent } from '../services/security-log.js';
import type { FileStorage } from '../services/storage.js';
import { BackupFormatError, readHeader } from './format.js';
import { mergeBackup, mergeBlocked, restoreBackup, verifyBackup } from './restore.js';
import type { BackupService } from './service.js';

/** The largest backup that can be uploaded through the browser. Bigger ones go into the backup folder. */
export const RESTORE_UPLOAD_BYTES = 20 * 1024 ** 3;
const BACKUP_NAME = /^atlas-\d{8}-\d{6}(-\d+)?\.atlasbak$/;

/** What the running Atlas leaves for the next start, which installs it before anything else runs. */
interface StagedRequest {
  mode: RestoreOutcome['mode'];
  /** Only when the backup's key isn't one this installation loads. Deleted as soon as it's read. */
  masterKey: string | null;
  keyLoaded: boolean;
  backupKeyId: string;
  backupCreatedAt: string;
  safetyBackup: string;
  requestedByName: string;
  requestedAt: string;
}

const paths = (dataDir: string) => {
  const dir = join(dataDir, 'restore');
  return {
    dir,
    uploads: join(dir, 'uploads'),
    request: join(dir, 'request.json'),
    file: join(dir, 'backup.atlasbak'),
    last: join(dir, 'last.json'),
  };
};

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const writePrivate = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });

const decodeKey = (text: string) => Buffer.from(text, 'base64url');

/** The loaded keys, plus the backup's own key when one was entered (kept last, so new data uses the current key). */
function withBackupKey(keys: KeyProvider, masterKey: string | null): KeyProvider {
  if (!masterKey) return keys;
  return staticKeyProvider([...keys.keyIds.map((id) => keys.key(id)), decodeKey(masterKey)]);
}

/**
 * Administration → Status → Restore from a backup. The running Atlas only checks the backup and leaves it, with
 * the request, in the data folder; then it restarts, and the next start installs it before the web server, the
 * scheduled jobs, or any sign-in can touch the database (see applyStagedRestore).
 */
export class RestoreService {
  private readonly paths: ReturnType<typeof paths>;

  constructor(
    private readonly keys: KeyProvider,
    private readonly backups: BackupService,
    dataDir: string,
  ) {
    this.paths = paths(dataDir);
  }

  async status(): Promise<RestoreStatus> {
    const files = await Promise.all(
      (await this.backups.files()).map(async (name) => {
        const info = await stat(join(this.backups.dir, name));
        return { name, size: info.size, modifiedAt: info.mtime.toISOString() };
      }),
    );
    return { files, last: await readJson<RestoreOutcome>(this.paths.last) };
  }

  /** Saves an uploaded backup file. Only the newest upload is kept. */
  async upload(file: MultipartFile | undefined) {
    if (!file) throw new HttpError(400, 'Choose a backup file (.atlasbak) to upload.');
    await rm(this.paths.uploads, { recursive: true, force: true });
    await mkdir(this.paths.uploads, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const target = join(this.paths.uploads, `${id}.atlasbak`);
    try {
      await pipeline(file.file, createWriteStream(target, { mode: 0o600 }));
      if (file.file.truncated) throw new HttpError(413, 'Backups uploaded here can be up to 20 GB.');
      await readHeader(createReadStream(target));
    } catch (error) {
      await rm(target, { force: true });
      if (error instanceof BackupFormatError) throw new HttpError(400, error.message);
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
        throw new HttpError(413, 'Backups uploaded here can be up to 20 GB.');
      throw error;
    }
    return { upload: id, name: file.filename, size: (await stat(target)).size };
  }

  private async locate(source: RestoreSource) {
    const path =
      'file' in source
        ? BACKUP_NAME.test(source.file)
          ? join(this.backups.dir, source.file)
          : null
        : join(this.paths.uploads, `${source.upload}.atlasbak`);
    if (!path || !(await stat(path).catch(() => null)))
      throw new HttpError(404, 'That backup file is no longer there. Choose it again.');
    return path;
  }

  /** Reads and checks the whole backup with the right key, and says what restoring it would do. */
  async check(source: RestoreSource, masterKey?: string): Promise<RestoreCheck> {
    return (await this.inspect(source, masterKey)).check;
  }

  private async inspect(source: RestoreSource, masterKey?: string): Promise<{ path: string; check: RestoreCheck }> {
    const path = await this.locate(source);
    let header;
    try {
      header = await readHeader(createReadStream(path));
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'This is not an Atlas backup file.');
    }
    const keyLoaded = this.keys.keyIds.includes(header.keyId);
    if (!keyLoaded && !masterKey)
      throw new HttpError(
        400,
        `This backup was made with master key ${header.keyId}, which this installation doesn't have. Enter that key.`,
        undefined,
        { masterKey: `Enter master key ${header.keyId}, the key this backup was made with.` },
      );
    if (!keyLoaded && staticKeyProvider([decodeKey(masterKey!)]).keyId !== header.keyId)
      throw new HttpError(
        400,
        `That key doesn't match this backup, which needs master key ${header.keyId}.`,
        undefined,
        {
          masterKey: `That isn't master key ${header.keyId}. Check you copied the whole key from the right installation.`,
        },
      );
    let contents;
    try {
      contents = await verifyBackup(path, withBackupKey(this.keys, keyLoaded ? null : masterKey!));
    } catch (error) {
      if (error instanceof BackupFormatError) throw new HttpError(400, error.message);
      throw error;
    }
    const blocked = await mergeBlocked(contents);
    return {
      path,
      check: {
        createdAt: contents.createdAt,
        appVersion: contents.appVersion,
        tables: contents.tables,
        rows: contents.rows,
        files: contents.files,
        keyId: header.keyId,
        keyLoaded,
        canMerge: !blocked,
        mergeBlocked: blocked,
      },
    };
  }

  /**
   * Leaves a checked backup for the next start to install. A safety backup of the database as it is comes first,
   * and nothing is left to install if that fails.
   */
  async stage(options: { source: RestoreSource; masterKey?: string; overwrite: boolean; requestedByName: string }) {
    if (await readJson<StagedRequest>(this.paths.request))
      throw new HttpError(409, 'A restore is already waiting for Atlas to restart.');
    const { path, check: checked } = await this.inspect(options.source, options.masterKey);
    if (!options.overwrite && !checked.canMerge) throw new HttpError(400, checked.mergeBlocked!);
    await mkdir(this.paths.dir, { recursive: true, mode: 0o700 });
    // A copy of its own, so the safety backup's clean-up of old files can't remove the one being restored.
    if ('upload' in options.source) await rename(path, this.paths.file);
    else await copyFile(path, this.paths.file);
    // Either way the database changes, so a backup of it as it is now comes first.
    let safetyBackup: string;
    try {
      const run = await this.backups.run('manual', 'Before restoring a backup');
      safetyBackup = join(this.backups.dir, run.fileName!);
    } catch (error) {
      if ('upload' in options.source) await rename(this.paths.file, path);
      else await rm(this.paths.file, { force: true });
      throw new HttpError(
        500,
        `The safety backup of the current database failed, so nothing was restored. ${error instanceof Error ? error.message : ''}`.trim(),
      );
    }
    const request: StagedRequest = {
      mode: options.overwrite ? 'overwrite' : 'merge',
      masterKey: checked.keyLoaded ? null : options.masterKey!.trim(),
      keyLoaded: checked.keyLoaded,
      backupKeyId: checked.keyId,
      backupCreatedAt: checked.createdAt,
      safetyBackup,
      requestedByName: options.requestedByName,
      requestedAt: new Date().toISOString(),
    };
    await writePrivate(this.paths.request, request);
    return { mode: request.mode, backupCreatedAt: checked.createdAt, safetyBackup: basename(safetyBackup) };
  }
}

const EVENT: Record<RestoreOutcome['state'], string> = {
  running: 'Backup restore started',
  done: 'Backup restored',
  'rolled-back': 'Backup restore rolled back',
  failed: 'Backup restore failed',
};

/** Counts values still sealed with a master key (by fingerprint) anywhere in the database. */
async function stillSealedWith(handle: DatabaseHandle, keyId: string) {
  const columns = await handle.pool.query<{ table_name: string; column_name: string }>(
    `select c.table_name, c.column_name from information_schema.columns c
     join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.data_type in ('text', 'jsonb', 'json')`,
  );
  const needle = `%v2:${keyId}:%`;
  let found = 0;
  for (const { table_name: table, column_name: column } of columns.rows) {
    const { rows } = await handle.pool.query<{ n: number }>(
      `select count(*)::int as n from "${table.replace(/"/g, '""')}" where "${column.replace(/"/g, '""')}"::text like $1`,
      [needle],
    );
    found += rows[0]!.n;
  }
  return found;
}

/**
 * Installs a restore the running Atlas left in the data folder. Call at start-up, after the database is up to date
 * and before anything else uses it. Returns the keys to run with: the loaded ones, plus the backup's key only if
 * something restored still needs it.
 */
export async function applyStagedRestore(options: {
  handle: DatabaseHandle;
  keys: KeyProvider;
  dataDir: string;
  storage: FileStorage;
  attachmentsDir: string;
  /** The key file, when keys come from one; null when they come from ATLAS_MASTER_KEY. */
  keyFile: string | null;
  log: (line: string) => void;
}): Promise<KeyProvider> {
  const { handle, keys, storage, log } = options;
  const p = paths(options.dataDir);
  const last = await readJson<RestoreOutcome>(p.last);
  if (last?.state === 'running')
    await writePrivate(p.last, {
      ...last,
      state: 'failed',
      finishedAt: new Date().toISOString(),
      message: `Atlas stopped while the restore was running.${last.safetyBackup ? ` If anything is missing, restore the safety backup ${last.safetyBackup}.` : ''}`,
    } satisfies RestoreOutcome);
  const request = await readJson<StagedRequest>(p.request);
  if (!request) return keys;
  // Gone before any work starts: a restore that fails can never run again on every start.
  await rm(p.request, { force: true });
  const outcome: RestoreOutcome = {
    state: 'running',
    mode: request.mode,
    requestedByName: request.requestedByName,
    requestedAt: request.requestedAt,
    finishedAt: null,
    backupCreatedAt: request.backupCreatedAt,
    safetyBackup: basename(request.safetyBackup),
    rows: 0,
    skipped: 0,
    files: 0,
    message: 'Restoring…',
  };
  await writePrivate(p.last, outcome);
  const finish = async (fields: Partial<RestoreOutcome>) => {
    Object.assign(outcome, fields, { finishedAt: new Date().toISOString() });
    await writePrivate(p.last, outcome);
    log(`Restore: ${outcome.message}`);
    // Into the database as it now is, so each organization's security log shows what happened to it. A database
    // left empty by a failed restore has nowhere to record it; the outcome file and the log still do.
    try {
      for (const org of await handle.db.select({ id: schema.orgs.id }).from(schema.orgs))
        await securityEvent(handle.db, {
          orgId: org.id,
          actor: request.requestedByName,
          action: EVENT[outcome.state],
          detail: `${request.mode === 'overwrite' ? 'Overwrite' : 'Add back'}: backup of ${request.backupCreatedAt}`,
        });
    } catch (error) {
      log(
        `Restore: couldn't write the security-log entry (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
  };

  const backupKeys = withBackupKey(keys, request.masterKey);
  let erased = false;
  try {
    log(`Installing the backup of ${request.backupCreatedAt} (${request.mode})…`);
    const result =
      request.mode === 'overwrite'
        ? await restoreBackup({
            handle,
            keys: backupKeys,
            storage,
            file: p.file,
            replace: true,
            beforeErase: async () => {
              erased = true;
              await rm(options.attachmentsDir, { recursive: true, force: true });
            },
            log,
          })
        : await mergeBackup({ handle, keys: backupKeys, storage, file: p.file, log });
    let runWith = keys;
    let note = '';
    if (!request.keyLoaded) {
      // The restored secrets move to this installation's own key, so the backup's key isn't needed from now on.
      await rewrapMasterSecrets(handle.db, backupKeys);
      const left = await stillSealedWith(handle, request.backupKeyId);
      if (left) {
        runWith = backupKeys;
        if (options.keyFile) {
          await appendFile(options.keyFile, `\n${request.masterKey}\n`, { mode: 0o600 });
          note = ` ${left} value(s) still use the backup's master key ${request.backupKeyId}, so it was added to the key file.`;
        } else
          note = ` ${left} value(s) still use the backup's master key ${request.backupKeyId}. Add it to ATLAS_MASTER_KEY after the current key (separated by a comma) before Atlas next restarts.`;
      }
    }
    await finish({
      state: 'done',
      rows: result.rows,
      skipped: result.skipped,
      files: result.files,
      message:
        (request.mode === 'overwrite'
          ? `Restored ${result.rows} rows and ${result.files} files. Everyone signs in again.`
          : `Added back ${result.rows} rows and ${result.files} files; ${result.skipped} rows were already here and were kept as they are.`) +
        (result.missingFiles.length
          ? ` ${result.missingFiles.length} attachment(s) were already missing when the backup was made.`
          : '') +
        note,
    });
    return runWith;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!erased) {
      await finish({ state: 'failed', message: `Nothing was changed. ${reason}` });
      return keys;
    }
    // The database was already erased: put back what was there, from the safety backup taken just before.
    try {
      await restoreBackup({
        handle,
        keys,
        storage,
        file: request.safetyBackup,
        replace: true,
        beforeErase: () => rm(options.attachmentsDir, { recursive: true, force: true }),
        log,
      });
      await finish({
        state: 'rolled-back',
        message: `The restore failed, so the database was put back as it was, from the safety backup. ${reason}`,
      });
    } catch (fallback) {
      await finish({
        state: 'failed',
        message: `The restore failed, and so did putting back the safety backup (${fallback instanceof Error ? fallback.message : String(fallback)}). Stop Atlas and restore ${request.safetyBackup} with the restore command. ${reason}`,
      });
    }
    return keys;
  } finally {
    await rm(p.file, { force: true });
  }
}
