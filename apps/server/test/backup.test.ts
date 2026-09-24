import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
import { decryptStream, encryptStream } from '../src/backup/format.js';
import { restoreBackup, verifyBackup } from '../src/backup/restore.js';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { totp, totpStep } from '../src/identity/totp.js';
import { LocalStorage } from '../src/services/storage.js';
import { OWNER, freshDatabase, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

async function roundTrip(data: Buffer, encryptKeys = staticKeyProvider([randomBytes(32)]), decryptKeys = encryptKeys) {
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([data]),
    encryptStream(encryptKeys, 'test'),
    new Writable({
      write(chunk: Buffer, _e, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  return { sealed: Buffer.concat(chunks), open: (bytes: Buffer) => decrypt(bytes, decryptKeys) };
}

async function decrypt(bytes: Buffer, keys: ReturnType<typeof staticKeyProvider>) {
  const out: Buffer[] = [];
  await pipeline(
    Readable.from([bytes]),
    decryptStream(keys),
    new Writable({
      write(chunk: Buffer, _e, done) {
        out.push(chunk);
        done();
      },
    }),
  );
  return Buffer.concat(out);
}

describe('backup encryption', () => {
  it('round-trips across many chunks and rejects any change, truncation, or wrong key', async () => {
    const data = randomBytes(200_000);
    const keys = staticKeyProvider([randomBytes(32)]);
    const { sealed, open } = await roundTrip(data, keys);
    expect((await open(sealed)).equals(data)).toBe(true);
    expect(sealed.includes(data.subarray(0, 64))).toBe(false);

    const flipped = Buffer.from(sealed);
    flipped[sealed.length - 100]! ^= 1;
    await expect(open(flipped)).rejects.toThrow('changed after it was made');

    // Cut exactly at a chunk boundary: every remaining chunk is valid, but the final one is missing.
    const firstFrame = sealed.indexOf(0x0a, 9) + 1;
    const cut = firstFrame + 4 + 65536 + 16;
    await expect(open(sealed.subarray(0, cut))).rejects.toThrow('incomplete');

    const header = Buffer.from(sealed);
    header[20] = header[20] === 0x61 ? 0x62 : 0x61; // Inside the JSON header, which every chunk authenticates.
    await expect(open(header)).rejects.toThrow();

    await expect(decrypt(sealed, staticKeyProvider([randomBytes(32)]))).rejects.toThrow(/master key .* isn't loaded/);
    // An older key kept after rotation still opens backups it made.
    const rotated = staticKeyProvider([randomBytes(32), keys.key(keys.keyId)]);
    expect((await decrypt(sealed, rotated)).equals(data)).toBe(true);

    // Empty input still produces a complete, final-marked file.
    const empty = await roundTrip(Buffer.alloc(0), keys);
    expect((await empty.open(empty.sealed)).length).toBe(0);
  });
});

describe('backup and restore', () => {
  let dir: string;
  let t: TestApp;
  let owner: Browser;
  let secret: string;
  const keys = staticKeyProvider([randomBytes(32)]);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-backup-'));
    t = await startApp({ ATLAS_DATA_DIR: join(dir, 'data'), ATLAS_BACKUP_DIR: join(dir, 'backups') }, { keys });
    ({ b: owner, secret } = await setupOwner(t.app));
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const waitForBackup = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const run = ((await owner.call('GET', '/api/backups')).data as { id: string; status: string }[]).find(
        (r) => r.id === id,
      );
      if (run && run.status !== 'running')
        return run as { status: string; fileName: string; rows: number; files: number };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('backup did not finish');
  };

  it('backs up everything, encrypted, and restores it into a new database that works', async () => {
    const harbor = (
      await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group', requireRevealReason: false })
    ).data.id;
    const password = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Firewall', secret: 'Fw-Secret-2026!' })
    ).data;
    const contact = (await owner.call('POST', `/api/clients/${harbor}/contacts`, { name: 'Dana Morales' })).data;
    const boundary = '----atlasbackup';
    const upload = await t.app.inject({
      method: 'POST',
      url: `/api/items/contact/${contact.id}/attachments`,
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ),
        Buffer.from('Attachment body that must survive'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        cookie: owner.cookie,
        'x-csrf-token': owner.csrf,
      },
    });
    expect(upload.statusCode).toBe(201);
    const attachment = JSON.parse(upload.body)[0] as { id: string };

    // Only admins; starting one answers right away, and it finishes in the background.
    const start = await owner.call('POST', '/api/backups', {});
    expect(start.status).toBe(202);
    const run = await waitForBackup(start.data.id);
    expect(run.status, JSON.stringify(run)).toBe('done');
    expect(run.files).toBe(1);
    const file = join(dir, 'backups', run.fileName);
    const bytes = readFileSync(file);
    expect(bytes.subarray(0, 9).toString()).toBe('ATLASBAK\n');
    for (const plain of ['Harbor Dental Group', 'Dana Morales', 'Attachment body', OWNER.email])
      expect(bytes.includes(Buffer.from(plain))).toBe(false);

    // Downloading needs a fresh password confirmation, and is logged.
    await t.handle.db.execute(sql`update sessions set reauth_at = null`);
    const stale = await t.app.inject({
      method: 'GET',
      url: `/api/backups/${start.data.id}/download`,
      headers: { cookie: owner.cookie },
    });
    expect(stale.json().code).toBe('reauth');
    await owner.call('POST', '/api/session/reauth', { password: OWNER.password });
    const download = await t.app.inject({
      method: 'GET',
      url: `/api/backups/${start.data.id}/download`,
      headers: { cookie: owner.cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);

    const checked = await verifyBackup(file, keys);
    expect(checked.files).toBe(1);

    // Restore into an empty database and a new attachments folder, then run Atlas on it.
    const target = await freshDatabase({ migrate: false });
    const storage = new LocalStorage(join(dir, 'restored', 'attachments'));
    const restored = await restoreBackup({ handle: target.handle, keys, storage, file });
    expect(restored.files).toBe(1);
    // A second restore into the same database is refused unless it's asked to replace it.
    await expect(restoreBackup({ handle: target.handle, keys, storage, file })).rejects.toThrow('already has Atlas');

    const again = await startApp({ ATLAS_DATA_DIR: join(dir, 'restored') }, { keys, database: target });
    try {
      const { b, r } = await signIn(again.app, OWNER.email, OWNER.password);
      expect(r.data.stage).toBe('mfa');
      // The code used at setup is remembered in the restored data, so use the next one.
      expect((await b.call('POST', '/api/session/mfa', { code: totp(secret, totpStep() + 1) })).data.stage).toBe(
        'active',
      );
      expect((await b.call('POST', `/api/passwords/${password.id}/reveal`, {})).data.value).toBe('Fw-Secret-2026!');
      const content = await again.app.inject({
        method: 'GET',
        url: `/api/attachments/${attachment.id}/content`,
        headers: { cookie: b.cookie },
      });
      expect(content.body).toBe('Attachment body that must survive');
      // The audit log's hash chain and signed checkpoint survive intact.
      const verify = await b.call('POST', '/api/audit/verify', {});
      expect(verify.data).toMatchObject({ ok: true, brokenAt: null });
      // New rows get new IDs after the restored ones.
      expect((await b.call('POST', '/api/clients', { name: 'After restore' })).status).toBe(201);
      const events = (await b.call('GET', '/api/security-events')).data as { action: string }[];
      expect(events.length).toBeGreaterThan(3);
      expect((await b.call('POST', '/api/audit/verify', {})).data.ok).toBe(true);
    } finally {
      await again.close();
    }
  });

  it('refuses a damaged backup without changing the target database', async () => {
    const run = await waitForBackup((await owner.call('POST', '/api/backups', {})).data.id);
    const file = join(dir, 'backups', run.fileName);
    const bytes = readFileSync(file);
    bytes[bytes.length - 40]! ^= 0xff;
    const damaged = join(dir, 'damaged.atlasbak');
    writeFileSync(damaged, bytes);
    await expect(verifyBackup(damaged, keys)).rejects.toThrow(/damaged|changed/);
    const target = await freshDatabase({ migrate: false });
    try {
      await expect(
        restoreBackup({ handle: target.handle, keys, storage: new LocalStorage(join(dir, 'x')), file: damaged }),
      ).rejects.toThrow(/damaged|changed/);
      const tables = await target.handle.pool.query(
        `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
      );
      expect(tables.rows[0].n).toBe(0);
    } finally {
      await target.drop();
    }
  });

  it('runs the scheduled backup once a day after the backup hour, keeps the newest files, and reports status', async () => {
    const { BackupService } = await import('../src/backup/service.js');
    const service = new BackupService(t.handle, keys, new LocalStorage(join(dir, 'data', 'attachments')), {
      dir: join(dir, 'scheduled'),
      keep: 2,
      hour: 2,
      enabled: true,
      appVersion: 'test',
    });
    const at = (h: number) => new Date(2026, 8, 24, h, 30);
    expect(await service.tick(at(1))).toBeNull();
    expect((await service.tick(at(3)))?.status).toBe('done');
    expect(await service.tick(at(4))).toBeNull();
    for (let i = 0; i < 3; i++) await service.run('manual', 'Test');
    expect(readdirSync(join(dir, 'scheduled')).filter((n) => n.endsWith('.atlasbak'))).toHaveLength(2);

    // The status page checks files in the app's own backup folder, so make one there too.
    await waitForBackup((await owner.call('POST', '/api/backups', {})).data.id);
    const status = (await owner.call('GET', '/api/status')).data;
    expect(status.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(status.database.migrationsApplied).toBe(status.database.migrationsAvailable);
    expect(status.backups.lastSuccessAt).not.toBeNull();
    expect(status.keys).toEqual({ current: keys.keyId, loaded: 1 });
    const ids = status.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain('email');
    // The backup folder here is outside the data folder, so there's no same-disk warning.
    expect(ids).not.toContain('backup-location');
    expect(ids).toContain('backups');
  });

  it('refuses a backup from a newer Atlas before erasing anything, and recovers from interrupted runs', async () => {
    // A small, valid backup whose manifest says it needs more database updates than this build has.
    const { frames } = await import('../src/backup/format.js');
    const { createGzip } = await import('node:zlib');
    const newer = join(dir, 'newer.atlasbak');
    const out: Buffer[] = [];
    await pipeline(
      Readable.from([
        frames.json('M', {
          format: 'msp-atlas-backup',
          version: 1,
          appVersion: '9.0.0',
          createdAt: new Date().toISOString(),
          migrations: 999,
          tables: [],
        }),
        frames.json('E', { rows: {}, files: 0 }),
      ]),
      createGzip(),
      encryptStream(keys, '9.0.0'),
      new Writable({
        write(c: Buffer, _e, done) {
          out.push(c);
          done();
        },
      }),
    );
    writeFileSync(newer, Buffer.concat(out));
    let erased = false;
    await expect(
      restoreBackup({
        handle: t.handle,
        keys,
        storage: new LocalStorage(join(dir, 'data', 'attachments')),
        file: newer,
        replace: true,
        verified: true,
        beforeErase: async () => {
          erased = true;
        },
      }),
    ).rejects.toThrow('newer version');
    expect(erased).toBe(false);
    expect((await owner.call('GET', '/api/session')).status).toBe(200);

    // A run left "running" by a restart is marked failed, and doesn't block the next backup.
    await t.handle.db.execute(sql`insert into backup_runs (trigger, started_by_name) values ('schedule', 'Crashed')`);
    const runs = (await owner.call('GET', '/api/backups')).data as { startedByName: string; status: string }[];
    expect(runs.find((r) => r.startedByName === 'Crashed')?.status).toBe('failed');
    expect((await owner.call('POST', '/api/backups', {})).status).toBe(202);
  });

  it('reports a backup whose file has gone missing', async () => {
    const run = await waitForBackup((await owner.call('POST', '/api/backups', {})).data.id);
    rmSync(join(dir, 'backups', run.fileName));
    const status = (await owner.call('GET', '/api/status')).data;
    expect(status.backups.lastSuccessAt).toBeNull();
    expect(status.checks.map((c: { id: string }) => c.id)).toContain('backup-missing');
  });

  it('keeps backups and the status page to administrators', async () => {
    await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tess Tech',
      role: 'technician',
      allClients: 'edit_passwords',
      password: 'temporary pass 1234',
    });
    const { b } = await signIn(t.app, 'tech@atlas.test', 'temporary pass 1234');
    await b.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    const { enroll } = await import('./helpers.js');
    await enroll(b);
    expect((await b.call('GET', '/api/status')).status).toBe(403);
    expect((await b.call('GET', '/api/backups')).status).toBe(403);
    expect((await b.call('POST', '/api/backups', {})).status).toBe(403);
  });
});
