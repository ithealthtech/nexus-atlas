import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { migrationsFolder } from '@atlas/db';
import { encryptStream, frames } from '../src/backup/format.js';
import { applyStagedRestore } from '../src/backup/staged.js';
import { staticKeyProvider, type KeyProvider } from '../src/crypto/keys.js';
import { totp, totpStep } from '../src/identity/totp.js';
import { LocalStorage } from '../src/services/storage.js';
import { OWNER, browser, freshDatabase, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

type Db = Awaited<ReturnType<typeof freshDatabase>>;

/** One Atlas installation: its own database, data folder, master key, and owner. */
async function install(root: string, name: string, keys: KeyProvider) {
  const dir = join(root, name);
  const db = await freshDatabase();
  // The app is closed and started again on the same database (as a restart would), so it's dropped at the end.
  const kept: Db = { ...db, drop: async () => undefined };
  const env = { ATLAS_DATA_DIR: join(dir, 'data'), ATLAS_BACKUP_DIR: join(dir, 'backups') };
  const restarts: number[] = [];
  const start = () => startApp(env, { keys, database: kept, restart: () => restarts.push(Date.now()) });
  const t: TestApp = await start();
  const { b, secret } = await setupOwner(t.app);
  return { dir, db, env, keys, t, owner: b, secret, restarts, start };
}
type Install = Awaited<ReturnType<typeof install>>;

async function backUp(at: Install) {
  const id = (await at.owner.call('POST', '/api/backups', {})).data.id as string;
  for (let i = 0; i < 100; i++) {
    const run = (
      (await at.owner.call('GET', '/api/backups')).data as { id: string; status: string; fileName: string }[]
    ).find((r) => r.id === id);
    if (run && run.status !== 'running') {
      expect(run.status).toBe('done');
      return run.fileName;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('backup did not finish');
}

async function upload(at: Install, bytes: Buffer, as: Browser = at.owner) {
  const boundary = '----atlasrestore';
  const response = await at.t.app.inject({
    method: 'POST',
    url: '/api/backups/restore/upload',
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="old.atlasbak"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      cookie: as.cookie,
      'x-csrf-token': as.csrf,
    },
  });
  return { status: response.statusCode, data: JSON.parse(response.body) };
}

/** What the next start does: install the waiting restore, then run Atlas on the result. */
async function restartWith(at: Install, keyFile: string | null = null) {
  await at.t.app.close();
  const dataDir = at.env.ATLAS_DATA_DIR;
  const keys = await applyStagedRestore({
    handle: at.db.handle,
    keys: at.keys,
    dataDir,
    storage: new LocalStorage(join(dataDir, 'attachments')),
    attachmentsDir: join(dataDir, 'attachments'),
    keyFile,
    log: () => undefined,
  });
  at.t = await at.start();
  // The same signed-in browser, now talking to the restarted Atlas.
  const owner = browser(at.t.app);
  owner.cookie = at.owner.cookie;
  owner.csrf = at.owner.csrf;
  at.owner = owner;
  return keys;
}

const lastOutcome = (at: Install) =>
  JSON.parse(readFileSync(join(at.env.ATLAS_DATA_DIR, 'restore', 'last.json'), 'utf8')) as {
    state: string;
    rows: number;
    skipped: number;
    message: string;
    safetyBackup: string;
  };

async function signInOwner(at: Install, secret: string) {
  const { b, r } = await signIn(at.t.app, OWNER.email, OWNER.password);
  expect(r.data.stage).toBe('mfa');
  // The code used at setup is remembered, so use the next one.
  expect((await b.call('POST', '/api/session/mfa', { code: totp(secret, totpStep() + 1) })).data.stage).toBe('active');
  return b;
}

/** A small, valid backup file made by hand. */
async function craftBackup(file: string, keys: KeyProvider, migrations: number, tables: Record<string, unknown[]>) {
  const out: Buffer[] = [];
  const counts = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.length]));
  await pipeline(
    Readable.from([
      frames.json('M', {
        format: 'msp-atlas-backup',
        version: 1,
        appVersion: 'test',
        createdAt: '2026-01-02T03:04:05.000Z',
        migrations,
        tables: Object.keys(tables),
      }),
      ...Object.entries(tables).map(([name, rows]) =>
        frames.table(
          name,
          rows.map((r) => JSON.stringify(r)),
        ),
      ),
      frames.json('E', { rows: counts, files: 0 }),
    ]),
    createGzip(),
    encryptStream(keys, 'test'),
    new Writable({
      write(chunk: Buffer, _e, done) {
        out.push(chunk);
        done();
      },
    }),
  );
  writeFileSync(file, Buffer.concat(out));
}

const migrationCount = () =>
  (JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }).entries
    .length;

describe('restoring a backup from the Status page', () => {
  let root: string;
  const open: Install[] = [];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'atlas-restore-'));
  });
  afterEach(async () => {
    for (const at of open.splice(0)) {
      await at.t.app.close();
      await at.db.drop();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const make = async (name: string, keys = staticKeyProvider([randomBytes(32)])) => {
    const at = await install(root, name, keys);
    open.push(at);
    return at;
  };

  it('overwrites a new installation with a backup made under another master key, which is then no longer needed', async () => {
    const oldKey = randomBytes(32);
    const old = await make('old', staticKeyProvider([oldKey]));
    const harbor = (await old.owner.call('POST', '/api/clients', { name: 'Harbor Dental', requireRevealReason: false }))
      .data.id;
    const password = (
      await old.owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Firewall', secret: 'Fw-Secret-2026!' })
    ).data;
    // Saved settings secrets are sealed directly with the master key.
    expect(
      (
        await old.owner.call('PUT', '/api/settings/email', {
          enabled: true,
          method: 'smtp',
          host: 'smtp.example.test',
          port: 587,
          secure: false,
          username: 'mailer',
          password: 'smtp-secret-1',
          fromAddress: 'atlas@example.test',
          fromName: 'Atlas',
        })
      ).status,
    ).toBeLessThan(300);
    expect((await old.owner.call('POST', '/api/audit/verify', {})).data.ok).toBe(true);
    const backup = readFileSync(join(old.dir, 'backups', await backUp(old)));

    const fresh = await make('new');
    await fresh.owner.call('POST', '/api/clients', { name: 'Only on the new server' });
    const uploaded = await upload(fresh, backup);
    expect(uploaded.status).toBe(201);
    const source = { upload: uploaded.data.upload };

    // The backup's key isn't loaded here, so it has to be entered, and it has to be the right one.
    const noKey = await fresh.owner.call('POST', '/api/backups/restore/check', { source });
    expect(noKey.status).toBe(400);
    expect(noKey.data.fields.masterKey).toContain('Enter master key');
    const wrong = await fresh.owner.call('POST', '/api/backups/restore/check', {
      source,
      masterKey: randomBytes(32).toString('base64url'),
    });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toContain("doesn't match");
    const masterKey = oldKey.toString('base64url');
    const checked = await fresh.owner.call('POST', '/api/backups/restore/check', { source, masterKey });
    expect(checked.status).toBe(200);
    expect(checked.data).toMatchObject({ keyLoaded: false, canMerge: true });
    expect(checked.data.rows).toBeGreaterThan(0);

    // Overwriting needs the password and the organization's name typed exactly.
    const request = { source, masterKey, overwrite: true, password: OWNER.password, confirmName: OWNER.organization };
    expect((await fresh.owner.call('POST', '/api/backups/restore', { ...request, confirmName: 'nope' })).status).toBe(
      400,
    );
    expect((await fresh.owner.call('POST', '/api/backups/restore', { ...request, password: 'wrong' })).status).toBe(
      400,
    );
    expect(fresh.restarts).toHaveLength(0);
    const staged = await fresh.owner.call('POST', '/api/backups/restore', request);
    expect(staged.status, JSON.stringify(staged.data)).toBe(202);
    expect(staged.data).toMatchObject({ mode: 'overwrite', restarting: true });
    expect(fresh.restarts).toHaveLength(1);
    // A second request can't pile up behind it.
    expect((await fresh.owner.call('POST', '/api/backups/restore', request)).status).toBe(409);
    // The key waiting for the restart is readable only by Atlas, and the safety backup is in the backup folder.
    expect(existsSync(join(fresh.dir, 'backups', staged.data.safetyBackup))).toBe(true);

    const runWith = await restartWith(fresh);
    // Everything restored was moved to this installation's own key.
    expect(runWith).toBe(fresh.keys);
    expect(lastOutcome(fresh).state).toBe('done');
    const b = await signInOwner(fresh, old.secret);
    expect((await b.call('POST', `/api/passwords/${password.id}/reveal`, {})).data.value).toBe('Fw-Secret-2026!');
    const clients = (await b.call('GET', '/api/clients')).data as { name: string }[];
    expect(clients.map((c) => c.name)).toEqual(['Harbor Dental']);
    expect((await b.call('GET', '/api/settings/email')).data.hasPassword).toBe(true);
    const verify = await b.call('POST', '/api/audit/verify', {});
    expect(verify.data).toMatchObject({ ok: true, checkpoint: 'ok' });
    const events = (await b.call('GET', '/api/security-events')).data as { action: string }[];
    expect(events.map((e) => e.action)).toContain('Backup restored');
    const status = (await b.call('GET', '/api/backups/restore')).data;
    expect(status.last).toMatchObject({ state: 'done', mode: 'overwrite' });
    // No secret value still depends on the old key.
    const { rows } = await fresh.db.handle.pool.query<{ n: number }>(
      `select count(*)::int as n from vault_keys where wrapped_key like $1`,
      [`v2:${staticKeyProvider([oldKey]).keyId}:%`],
    );
    expect(rows[0]!.n).toBe(0);
  });

  it('adds back what was deleted and keeps what changed since, when overwrite is off', async () => {
    const at = await make('same');
    const keep = (await at.owner.call('POST', '/api/clients', { name: 'Kept Client' })).data.id;
    const gone = (await at.owner.call('POST', '/api/clients', { name: 'Deleted Client' })).data.id;
    const file = await backUp(at);
    await at.owner.call('PATCH', `/api/clients/${keep}`, { name: 'Renamed Since' });
    expect(
      (await at.owner.call('DELETE', `/api/clients/${gone}`, { confirmName: 'Deleted Client' })).status,
    ).toBeLessThan(300);
    const logged = (await at.db.handle.pool.query<{ n: number }>('select count(*)::int as n from security_events'))
      .rows[0]!.n;

    const source = { file };
    const checked = await at.owner.call('POST', '/api/backups/restore/check', { source });
    expect(checked.data).toMatchObject({ keyLoaded: true, canMerge: true, mergeBlocked: null });
    // Adding back needs the password, but no typed name.
    const staged = await at.owner.call('POST', '/api/backups/restore', {
      source,
      overwrite: false,
      password: OWNER.password,
    });
    expect(staged.status, JSON.stringify(staged.data)).toBe(202);
    expect(staged.data.mode).toBe('merge');

    await restartWith(at);
    const outcome = lastOutcome(at);
    expect(outcome.state, outcome.message).toBe('done');
    expect(outcome.rows).toBeGreaterThan(0);
    expect(outcome.skipped).toBeGreaterThan(0);
    // Sessions aren't in backups and weren't touched: the owner is still signed in.
    const clients = (await at.owner.call('GET', '/api/clients')).data as { id: string; name: string }[];
    expect(clients.map((c) => c.name).sort()).toEqual(['Deleted Client', 'Renamed Since']);
    // The security log isn't merged; it only gains entries.
    const after = (await at.db.handle.pool.query<{ n: number }>('select count(*)::int as n from security_events'))
      .rows[0]!.n;
    expect(after).toBeGreaterThan(logged);
    expect((await at.owner.call('POST', '/api/audit/verify', {})).data.ok).toBe(true);
    expect((await at.owner.call('POST', '/api/clients', { name: 'After merge' })).status).toBe(201);
  });

  it('puts the database back from the safety backup when an overwrite fails part way', async () => {
    const at = await make('rollback');
    await at.owner.call('POST', '/api/clients', { name: 'Still Here' });
    // Valid and from this Atlas version, but its one row points at an organization the backup doesn't have.
    const file = join(root, 'broken.atlasbak');
    await craftBackup(file, at.keys, migrationCount(), {
      clients: [
        { id: '00000000-0000-4000-8000-000000000001', org_id: '00000000-0000-4000-8000-000000000002', name: 'X' },
      ],
    });
    const uploaded = await upload(at, readFileSync(file));
    const staged = await at.owner.call('POST', '/api/backups/restore', {
      source: { upload: uploaded.data.upload },
      overwrite: true,
      password: OWNER.password,
      confirmName: OWNER.organization,
    });
    expect(staged.status, JSON.stringify(staged.data)).toBe(202);
    await restartWith(at);
    const outcome = lastOutcome(at);
    expect(outcome.state, outcome.message).toBe('rolled-back');
    const names = await at.db.handle.db.execute(sql`select name from clients`);
    expect(names.rows).toEqual([{ name: 'Still Here' }]);
    await signInOwner(at, at.secret);
  });

  it('only adds back from the same Atlas version, and is for the owner only', async () => {
    const at = await make('rules');
    const file = join(root, 'older.atlasbak');
    await craftBackup(file, at.keys, migrationCount() - 1, {});
    const source = { upload: (await upload(at, readFileSync(file))).data.upload };
    const checked = await at.owner.call('POST', '/api/backups/restore/check', { source });
    expect(checked.data).toMatchObject({ canMerge: false });
    expect(checked.data.mergeBlocked).toContain('older version');
    const merge = await at.owner.call('POST', '/api/backups/restore', {
      source,
      overwrite: false,
      password: OWNER.password,
    });
    expect(merge.status).toBe(400);
    expect(at.restarts).toHaveLength(0);
    expect(await at.db.handle.pool.query('select 1 from backup_runs')).toHaveProperty('rowCount', 0);

    // Not an Atlas backup at all.
    expect((await upload(at, Buffer.from('hello'))).status).toBe(400);

    await at.owner.call('POST', '/api/users', {
      email: 'admin@atlas.test',
      name: 'Ada Admin',
      role: 'admin',
      password: 'temporary pass 1234',
    });
    const { b } = await signIn(at.t.app, 'admin@atlas.test', 'temporary pass 1234');
    await b.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    const { enroll } = await import('./helpers.js');
    await enroll(b);
    // Administrators see the backups and the last restore, but only the owner can restore.
    expect((await b.call('GET', '/api/backups/restore')).status).toBe(200);
    expect((await b.call('POST', '/api/backups/restore/check', { source })).status).toBe(403);
    expect((await upload(at, readFileSync(file), b)).status).toBe(403);
    expect(
      (
        await b.call('POST', '/api/backups/restore', {
          source,
          overwrite: true,
          password: 'cobalt fresh pass 12',
          confirmName: OWNER.organization,
        })
      ).status,
    ).toBe(403);
  });

  it('reports a restore that was interrupted, and runs nothing when none is waiting', async () => {
    const at = await make('interrupted');
    const dir = join(at.env.ATLAS_DATA_DIR, 'restore');
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
    writeFileSync(
      join(dir, 'last.json'),
      JSON.stringify({ state: 'running', mode: 'overwrite', safetyBackup: 'atlas-20260101-000000.atlasbak' }),
    );
    expect(await restartWith(at)).toBe(at.keys);
    const outcome = lastOutcome(at);
    expect(outcome.state).toBe('failed');
    expect(outcome.message).toContain('atlas-20260101-000000.atlasbak');
    await signInOwner(at, at.secret);
  });
});
