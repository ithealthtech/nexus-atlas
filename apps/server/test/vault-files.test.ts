import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newFileKey, openBytes, sealBytes } from '../src/crypto/files.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const LICENSE = Buffer.from('-----BEGIN LICENSE-----\nHDG-SITE-LICENSE-7731-ALPHA\n-----END LICENSE-----\n');

function multipart(
  file: { name: string; body: Buffer } | null,
  fields: Record<string, string> = {},
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----atlas' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  // Fields first: the server reads them before the file.
  for (const [name, value] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  if (file)
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      file.body,
      Buffer.from('\r\n'),
    );
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** Every file under a folder, recursively. */
function filesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? filesIn(join(dir, e.name)) : [join(dir, e.name)],
    );
  } catch {
    return [];
  }
}

describe('file encryption', () => {
  it('round-trips, and refuses a changed file, the wrong key, or another record', () => {
    const key = newFileKey();
    const sealed = sealBytes(key, LICENSE, 'pwa|a|b|file');
    expect(sealed.includes(LICENSE)).toBe(false);
    expect(openBytes(key, sealed, 'pwa|a|b|file').equals(LICENSE)).toBe(true);
    const flipped = Buffer.from(sealed);
    flipped[20] = flipped[20]! ^ 1;
    expect(() => openBytes(key, flipped, 'pwa|a|b|file')).toThrow();
    expect(() => openBytes(newFileKey(), sealed, 'pwa|a|b|file')).toThrow();
    expect(() => openBytes(key, sealed, 'pwa|a|c|file')).toThrow();
    expect(() => openBytes(key, sealed.subarray(0, 10), 'pwa|a|b|file')).toThrow('Unsupported');
  });
});

describe('secure notes, files on passwords, and Sends', () => {
  let t: TestApp;
  let dir: string;
  let owner: Browser;
  let harbor: string;
  let northline: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-vault-files-'));
    t = await startApp({ ATLAS_DATA_DIR: dir, ATLAS_MAX_UPLOAD_MB: '1' });
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function person(email: string, next: string, body: Record<string, unknown>, staff = true) {
    const created = await owner.call('POST', '/api/users', {
      email,
      name: email.split('@')[0],
      password: TEMP,
      ...body,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const { b } = await signIn(t.app, email, TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next });
    if (staff) await enroll(b);
    return { b, id: created.data.id as string };
  }
  const upload = (b: Browser, passwordId: string, name: string, body: Buffer) => {
    const form = multipart({ name, body });
    return t.app.inject({
      method: 'POST',
      url: `/api/passwords/${passwordId}/attachments`,
      payload: form.payload,
      headers: { ...form.headers, cookie: b.cookie, 'x-csrf-token': b.csrf },
    });
  };
  const download = (b: Browser, passwordId: string, attachmentId: string, body: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: `/api/passwords/${passwordId}/attachments/${attachmentId}/download`,
      payload: body,
      headers: { cookie: b.cookie, 'x-csrf-token': b.csrf },
    });
  const login = async (client = harbor, name = 'HDG-FW-01 admin') =>
    (
      await owner.call('POST', `/api/clients/${client}/passwords`, {
        name,
        username: 'admin',
        secret: 'Tr0ub4dor&3-Harbor-Firewall!',
      })
    ).data;

  it('stores a secure note as only encrypted text, never weak or reused', async () => {
    const text = 'Alarm panel: master code 4471.\nCall Brinks first, account 88-2210.';
    const created = await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      kind: 'note',
      name: 'Alarm panel',
      secret: text,
      // Not part of a note; dropped rather than stored.
      username: 'ignored',
      url: 'https://ignored.example',
      totp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
      notes: 'also ignored',
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const note = created.data;
    expect(note).toMatchObject({ kind: 'note', username: '', url: '', hasTotp: false, hasNotes: false, reused: 0 });
    expect(note.strength).toBe(4);
    const twin = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, { kind: 'note', name: 'Copy', secret: text })
    ).data;
    expect((await owner.call('GET', `/api/passwords/${note.id}`)).data.reused).toBe(0);
    expect(twin.reused).toBe(0);
    const dump = JSON.stringify((await t.handle.pool.query('select * from passwords')).rows);
    expect(dump).not.toContain('master code');
    expect(dump).not.toContain('ignored');

    expect((await owner.call('POST', `/api/passwords/${note.id}/reveal`, {})).data.value).toBe(text);
    await owner.call('POST', `/api/passwords/${note.id}/reveal`, { copy: true });
    const edited = await owner.call('PATCH', `/api/passwords/${note.id}`, {
      version: 1,
      secret: 'Master code changed to 9920.',
    });
    expect(edited.status).toBe(200);
    const audit = (await owner.call('GET', `/api/passwords/${note.id}/audit`)).data.map(
      (a: { action: string }) => a.action,
    );
    expect(audit).toEqual(['Changed note', 'Copied note', 'Viewed note', 'Created']);
    expect((await owner.call('GET', `/api/passwords/${note.id}/history`)).data).toHaveLength(1);

    // A note may be longer than a password; neither may be empty.
    const long = 'x'.repeat(10000);
    expect(
      (await owner.call('POST', `/api/clients/${harbor}/passwords`, { kind: 'note', name: 'Long', secret: long }))
        .status,
    ).toBe(201);
    const tooLong = await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Login', secret: long });
    expect(tooLong.status).toBe(400);
    expect(tooLong.data.fields.secret).toMatch(/up to 4096/);
    const empty = await owner.call('POST', `/api/clients/${harbor}/passwords`, { kind: 'note', name: 'E', secret: '' });
    expect(empty.data.fields.secret).toBe('Write the note.');
    const pw = await login();
    expect((await owner.call('PATCH', `/api/passwords/${pw.id}`, { version: 1, secret: long })).status).toBe(400);

    const found = (await owner.call('GET', '/api/search?q=Alarm')).data.find((r: { id: string }) => r.id === note.id);
    expect(found.subtitle).toBe('Secure note');
    const health = (await owner.call('GET', '/api/password-health')).data;
    expect(JSON.stringify(health)).not.toContain('Alarm panel');
  });

  it('encrypts files on password entries and audits every download', async () => {
    const item = await login();
    const uploaded = await upload(owner, item.id, 'site-license.lic', LICENSE);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const [file] = uploaded.json();
    expect(file).toMatchObject({ filename: 'site-license.lic', size: LICENSE.length, uploadedByName: 'Avery Owner' });

    // On disk: ciphertext only, bigger than the file by the IV and tag. In the database: a sealed key, no contents.
    const stored = filesIn(join(dir, 'attachments'));
    expect(stored).toHaveLength(1);
    const onDisk = readFileSync(stored[0]!);
    expect(onDisk.includes(Buffer.from('HDG-SITE-LICENSE'))).toBe(false);
    expect(onDisk.length).toBe(LICENSE.length + 32);
    const [row] = (await t.handle.pool.query('select * from attachments')).rows;
    expect(row.sealed_key).toMatch(/^v2:/);
    expect(JSON.stringify(row)).not.toContain('HDG-SITE-LICENSE');

    const got = await download(owner, item.id, file.id);
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(LICENSE)).toBe(true);
    expect(got.headers['content-type']).toBe('application/octet-stream');
    expect(got.headers['content-disposition']).toContain("filename*=UTF-8''site-license.lic");
    expect((await owner.call('GET', `/api/passwords/${item.id}/attachments`)).data).toHaveLength(1);

    // The documentation file routes never serve or remove a password's file.
    expect((await owner.call('GET', `/api/items/password/${item.id}/attachments`)).status).toBe(400);
    const docUpload = multipart({ name: 'x.txt', body: Buffer.from('x') });
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: `/api/items/password/${item.id}/attachments`,
          payload: docUpload.payload,
          headers: { ...docUpload.headers, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        })
      ).statusCode,
    ).toBe(400);
    expect((await owner.call('GET', `/api/attachments/${file.id}/content`)).status).toBe(404);
    expect((await owner.call('DELETE', `/api/attachments/${file.id}`)).status).toBe(404);
    // Nor through another entry.
    const other = await login(harbor, 'Other');
    expect((await download(owner, other.id, file.id)).statusCode).toBe(404);

    // A client that requires reasons requires one for files too.
    await owner.call('PATCH', `/api/clients/${harbor}`, { requireRevealReason: true });
    const noReason = await download(owner, item.id, file.id);
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().code).toBe('reason_required');
    expect((await download(owner, item.id, file.id, { reason: 'Ticket 4410 reinstall' })).statusCode).toBe(200);

    const audit = (await owner.call('GET', `/api/passwords/${item.id}/audit`)).data;
    expect(audit.slice(0, 3).map((a: { action: string }) => a.action)).toEqual([
      'Downloaded file “site-license.lic”',
      'Downloaded file “site-license.lic”',
      'Attached file “site-license.lic”',
    ]);
    expect(audit[0].reason).toBe('Ticket 4410 reinstall');

    expect((await upload(owner, item.id, 'empty.txt', Buffer.alloc(0))).statusCode).toBe(400);
    expect((await upload(owner, item.id, 'big.bin', Buffer.alloc(1024 * 1024 + 10))).statusCode).toBe(413);

    expect((await owner.call('DELETE', `/api/passwords/${item.id}/attachments/${file.id}`)).status).toBe(200);
    expect(filesIn(join(dir, 'attachments'))).toHaveLength(0);
    expect((await owner.call('GET', `/api/passwords/${item.id}/attachments`)).data).toEqual([]);
  });

  it('refuses a changed file, or one moved to another entry', async () => {
    const item = await login();
    const other = await login(harbor, 'Other');
    const [file] = (await upload(owner, item.id, 'id_ed25519', LICENSE)).json();
    const path = filesIn(join(dir, 'attachments'))[0]!;
    const original = readFileSync(path);
    const flipped = Buffer.from(original);
    flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 1;
    writeFileSync(path, flipped);
    const tampered = await download(owner, item.id, file.id);
    expect(tampered.statusCode).toBe(500);
    expect(tampered.body).not.toContain('HDG-SITE');
    writeFileSync(path, original);
    expect((await download(owner, item.id, file.id)).statusCode).toBe(200);

    await t.handle.pool.query('update attachments set entity_id = $1', [other.id]);
    expect((await download(owner, other.id, file.id)).statusCode).toBe(500);
    expect(statSync(path).size).toBe(original.length);
  });

  it('keeps files behind the entry’s own access rules', async () => {
    const item = await login();
    const [file] = (await upload(owner, item.id, 'cert.pfx', LICENSE)).json();
    const editor = await person('ed@atlas.test', 'editing tech pass 1', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    const elsewhere = await person('nla@atlas.test', 'northline tech pass 2', {
      role: 'technician',
      grants: [{ clientId: northline, level: 'edit_passwords' }],
    });
    const viewer = await person(
      'view@harbor.test',
      'harbor reader pass 7',
      { role: 'client_viewer', grants: [{ clientId: harbor, level: 'read' }] },
      false,
    );
    await owner.call('PATCH', `/api/passwords/${item.id}`, { version: 1, clientVisible: true });
    for (const b of [editor.b, elsewhere.b, viewer.b]) {
      expect((await b.call('GET', `/api/passwords/${item.id}/attachments`)).status).toBe(404);
      expect((await download(b, item.id, file.id)).statusCode).toBe(404);
      expect((await upload(b, item.id, 'x.txt', Buffer.from('x'))).statusCode).toBe(404);
      expect((await b.call('DELETE', `/api/passwords/${item.id}/attachments/${file.id}`)).status).toBe(404);
    }
    const tech = await person('pw@atlas.test', 'vault tech pass 12', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
    });
    expect((await download(tech.b, item.id, file.id)).statusCode).toBe(200);
    await owner.call('PATCH', `/api/passwords/${item.id}`, { version: 2, restricted: true });
    expect((await download(tech.b, item.id, file.id)).statusCode).toBe(404);
    expect((await tech.b.call('GET', `/api/passwords/${item.id}/attachments`)).status).toBe(404);
  });

  it('exports files decrypted only with the passwords', async () => {
    const item = await login();
    await upload(owner, item.id, 'site-license.lic', LICENSE);
    const zip = async (withPasswords: boolean) =>
      unzipSync(
        new Uint8Array(
          (
            await t.app.inject({
              method: 'GET',
              url: `/api/clients/${harbor}/export${withPasswords ? '?passwords=true' : ''}`,
              headers: { cookie: owner.cookie },
            })
          ).rawPayload,
        ),
      );
    const plain = await zip(false);
    expect(Object.keys(plain).some((f) => f.startsWith('attachments/'))).toBe(false);
    expect(JSON.parse(strFromU8(plain['client.json']!)).attachments).toEqual([]);
    const full = await zip(true);
    const entry = Object.keys(full).find((f) => f.endsWith('site-license.lic'))!;
    expect(Buffer.from(full[entry]!).equals(LICENSE)).toBe(true);
    const audit = (await owner.call('GET', '/api/vault/audit')).data.map((a: { action: string }) => a.action);
    expect(audit).toContain('Exported file “site-license.lic” (decrypted)');
  });

  it('opens a text Send once, then forgets it', async () => {
    const ciphertext = randomBytes(64).toString('base64url');
    const created = await owner.call('POST', '/api/sends', {
      name: 'Wi-Fi for the auditor',
      ciphertext,
      maxViews: 1,
      expiresHours: 2,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const { token } = created.data;
    expect(token).toMatch(/^[\w-]{32}$/);
    expect(JSON.stringify((await t.handle.pool.query('select * from sends')).rows)).not.toContain(token);

    const open = () => t.app.inject({ method: 'POST', url: `/api/sends/${token}/open` });
    const first = await open();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ kind: 'text', ciphertext, remainingViews: 0 });
    expect((await open()).statusCode).toBe(404);
    const [row] = (await t.handle.pool.query('select ciphertext from sends')).rows;
    expect(row.ciphertext).toBeNull();

    const [listed] = (await owner.call('GET', '/api/sends')).data;
    expect(listed).toMatchObject({ name: 'Wi-Fi for the auditor', kind: 'text', views: 1, active: false });
    const events = (await owner.call('GET', '/api/security-events')).data.map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(['Created a Send', 'Opened a Send']));

    // Revoked and expired Sends don't open, and lose their content.
    const second = (await owner.call('POST', '/api/sends', { name: 'Two', ciphertext, maxViews: 3 })).data;
    expect((await owner.call('DELETE', `/api/sends/${second.id}`)).status).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: `/api/sends/${second.token}/open` })).statusCode).toBe(404);
    const third = (await owner.call('POST', '/api/sends', { name: 'Three', ciphertext })).data;
    await t.handle.pool.query(`update sends set expires_at = now() - interval '1 minute' where id = $1`, [third.id]);
    expect((await t.app.inject({ method: 'POST', url: `/api/sends/${third.token}/open` })).statusCode).toBe(404);
    await owner.call('GET', '/api/sends');
    const left = (await t.handle.pool.query('select count(*)::int as n from sends where ciphertext is not null'))
      .rows[0].n;
    expect(left).toBe(0);
    expect((await t.app.inject({ method: 'POST', url: '/api/sends/not-a-token/open' })).statusCode).toBe(404);
  });

  it('sends a browser-encrypted file, and deletes it after the last view', async () => {
    const encrypted = randomBytes(2048);
    const meta = randomBytes(48).toString('base64url');
    const form = multipart(
      { name: 'blob', body: encrypted },
      { name: 'VPN profile for Jordan', meta, maxViews: '2', expiresHours: '24' },
    );
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sends/file',
      payload: form.payload,
      headers: { ...form.headers, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token } = created.json();
    expect(filesIn(join(dir, 'attachments'))).toHaveLength(1);
    for (const remaining of [1, 0]) {
      const opened = await t.app.inject({ method: 'POST', url: `/api/sends/${token}/open` });
      expect(opened.statusCode).toBe(200);
      expect(opened.rawPayload.equals(encrypted)).toBe(true);
      expect(opened.headers['x-send-meta']).toBe(meta);
      expect(opened.headers['x-send-remaining-views']).toBe(String(remaining));
      expect(opened.headers['content-type']).toBe('application/octet-stream');
    }
    expect(filesIn(join(dir, 'attachments'))).toHaveLength(0);
    expect((await t.app.inject({ method: 'POST', url: `/api/sends/${token}/open` })).statusCode).toBe(404);
    expect((await owner.call('GET', '/api/sends')).data[0]).toMatchObject({ kind: 'file', size: 2048, views: 2 });

    const big = multipart({ name: 'blob', body: Buffer.alloc(1024 * 1024 + 100) }, { name: 'Big', meta });
    expect(
      (
        await t.app.inject({
          method: 'POST',
          url: '/api/sends/file',
          payload: big.payload,
          headers: { ...big.headers, cookie: owner.cookie, 'x-csrf-token': owner.csrf },
        })
      ).statusCode,
    ).toBe(413);
  });

  it('keeps Sends to staff, and each person’s Sends to them', async () => {
    const ciphertext = randomBytes(64).toString('base64url');
    const mine = (await owner.call('POST', '/api/sends', { name: 'Owner send', ciphertext })).data;
    const tech = await person('sam@atlas.test', 'sending tech pass 3', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    const viewer = await person(
      'view@harbor.test',
      'harbor reader pass 7',
      { role: 'client_viewer', grants: [{ clientId: harbor, level: 'read' }] },
      false,
    );
    expect((await viewer.b.call('POST', '/api/sends', { name: 'Nope', ciphertext })).status).toBe(403);
    expect((await viewer.b.call('GET', '/api/sends')).status).toBe(403);
    expect((await tech.b.call('GET', '/api/sends')).data).toEqual([]);
    expect((await tech.b.call('GET', '/api/sends?all=true')).status).toBe(403);
    expect((await tech.b.call('DELETE', `/api/sends/${mine.id}`)).status).toBe(404);
    const theirs = (await tech.b.call('POST', '/api/sends', { name: 'Tech send', ciphertext })).data;
    expect((await tech.b.call('GET', '/api/sends')).data.map((s: { name: string }) => s.name)).toEqual(['Tech send']);
    expect((await owner.call('GET', '/api/sends')).data.map((s: { name: string }) => s.name)).toEqual(['Owner send']);
    expect((await owner.call('GET', '/api/sends?all=true')).data).toHaveLength(2);
    // Administrators can revoke anyone's.
    expect((await owner.call('DELETE', `/api/sends/${theirs.id}`)).status).toBe(200);
  });
});
