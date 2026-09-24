import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { VaultKeys } from '../src/crypto/vault-keys.js';
import { totp } from '../src/identity/totp.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const SECRET = 'Tr0ub4dor&3-Harbor-Firewall!';
const TOTP_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const BITLOCKER = '123456-234567-345678-456789-567890-678901-789012-890123';

describe('password vault', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let northline: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
  });
  afterEach(async () => {
    await t.close();
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
  const create = (b: Browser, client: string, body: Record<string, unknown> = {}) =>
    b.call('POST', `/api/clients/${client}/passwords`, {
      name: 'HDG-FW-01 admin',
      username: 'admin',
      url: 'https://10.20.0.1',
      secret: SECRET,
      ...body,
    });

  it('stores secrets only as ciphertext and reveals them with an audit trail', async () => {
    const created = await create(owner, harbor, { notes: 'Break-glass account', totp: TOTP_SEED, rotationDays: 90 });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const item = created.data;
    expect(item).toMatchObject({ hasNotes: true, hasTotp: true, reused: 0, rotationDays: 90 });
    expect(item.strength).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(item)).not.toContain(SECRET);
    expect((await owner.call('GET', `/api/passwords?client=${harbor}`)).data).toHaveLength(1);

    // Nothing sensitive in the database, including the per-organization key (stored only wrapped).
    const dump = JSON.stringify(
      await Promise.all(
        ['passwords', 'vault_keys', 'vault_audit', 'activity'].map(
          async (table) => (await t.handle.pool.query(`select * from ${table}`)).rows,
        ),
      ),
    );
    for (const plain of [SECRET, TOTP_SEED, 'Break-glass account']) expect(dump).not.toContain(plain);
    const [row] = (await t.handle.pool.query('select secret from passwords')).rows;
    expect(row.secret).toMatch(/^v2:/);

    expect((await owner.call('POST', `/api/passwords/${item.id}/reveal`, {})).data.value).toBe(SECRET);
    expect((await owner.call('POST', `/api/passwords/${item.id}/reveal`, { field: 'notes' })).data.value).toBe(
      'Break-glass account',
    );
    const code = (await owner.call('POST', `/api/passwords/${item.id}/reveal`, { field: 'totp' })).data;
    expect([totp(TOTP_SEED), totp(TOTP_SEED, Math.floor(Date.now() / 30000) - 1)]).toContain(code.value);
    expect(code.expiresIn).toBeLessThanOrEqual(30);
    await owner.call('POST', `/api/passwords/${item.id}/reveal`, { copy: true });
    const audit = (await owner.call('GET', `/api/passwords/${item.id}/audit`)).data.map(
      (a: { action: string }) => a.action,
    );
    expect(audit).toEqual(['Copied password', 'Viewed one-time code', 'Viewed notes', 'Revealed password', 'Created']);
  });

  it('keeps a history of changed passwords and flags reuse', async () => {
    const a = (await create(owner, harbor)).data;
    const b = (await create(owner, northline, { name: 'NLA admin' })).data;
    expect((await owner.call('GET', `/api/passwords/${a.id}`)).data.reused).toBe(1);
    expect(
      (await owner.call('PATCH', `/api/passwords/${a.id}`, { version: 1, secret: 'New-Str0ng-Passphrase-2026!' })).data
        .version,
    ).toBe(2);
    expect((await owner.call('GET', `/api/passwords/${b.id}`)).data.reused).toBe(0);
    expect((await owner.call('PATCH', `/api/passwords/${a.id}`, { version: 1, name: 'stale' })).status).toBe(409);
    // Editing details without changing the secret doesn't add history or reset the rotation clock.
    const renamed = (await owner.call('PATCH', `/api/passwords/${a.id}`, { version: 2, name: 'HDG firewall admin' }))
      .data;
    expect(renamed.username).toBe('admin');
    const history = (await owner.call('GET', `/api/passwords/${a.id}/history`)).data;
    expect(history).toHaveLength(1);
    expect((await owner.call('POST', `/api/passwords/${a.id}/history/${history[0].id}/reveal`, {})).data.value).toBe(
      SECRET,
    );
    expect((await owner.call('POST', `/api/passwords/${a.id}/reveal`, {})).data.value).toBe(
      'New-Str0ng-Passphrase-2026!',
    );
    await owner.call('POST', `/api/passwords/${b.id}/archive`, { archived: true });
    expect((await owner.call('GET', '/api/passwords')).data.map((p: { name: string }) => p.name)).toEqual([
      'HDG firewall admin',
    ]);
  });

  it('requires "edit + passwords" access, and hides restricted items from everyone not listed', async () => {
    const item = (await create(owner, harbor)).data;
    const editor = await person('ed@atlas.test', 'editing tech pass 1', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    expect((await editor.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);
    expect((await editor.b.call('POST', `/api/passwords/${item.id}/reveal`, {})).status).toBe(404);
    expect((await editor.b.call('GET', `/api/passwords?client=${harbor}`)).status).toBe(403);
    expect((await editor.b.call('GET', '/api/passwords')).data).toEqual([]);
    expect((await create(editor.b, harbor)).status).toBe(403);
    const viewer = await person(
      'view@harbor.test',
      'harbor reader pass 7',
      { role: 'client_viewer', grants: [{ clientId: harbor, level: 'read' }] },
      false,
    );
    expect((await viewer.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);
    expect(
      (await viewer.b.call('GET', '/api/search?q=HDG')).data.some((r: { type: string }) => r.type === 'password'),
    ).toBe(false);

    const tech = await person('pw@atlas.test', 'vault tech pass 12', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
    });
    expect((await tech.b.call('POST', `/api/passwords/${item.id}/reveal`, {})).data.value).toBe(SECRET);
    expect((await tech.b.call('GET', `/api/passwords/${(await create(owner, northline)).data.id}`)).status).toBe(404);
    expect(
      (await tech.b.call('GET', '/api/search?q=HDG-FW')).data.some((r: { type: string }) => r.type === 'password'),
    ).toBe(true);
    // Only admins restrict; once restricted, the technician loses it until listed.
    expect((await tech.b.call('PATCH', `/api/passwords/${item.id}`, { version: 1, restricted: true })).status).toBe(
      403,
    );
    await owner.call('PATCH', `/api/passwords/${item.id}`, { version: 1, restricted: true });
    expect((await tech.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);
    expect((await tech.b.call('GET', '/api/passwords')).data).toHaveLength(0);
    expect(
      (await tech.b.call('GET', '/api/search?q=HDG-FW')).data.some((r: { type: string }) => r.type === 'password'),
    ).toBe(false);
    expect((await owner.call('PUT', `/api/passwords/${item.id}/access`, { userIds: [tech.id] })).data.userIds).toEqual([
      tech.id,
    ]);
    expect((await tech.b.call('POST', `/api/passwords/${item.id}/reveal`, {})).status).toBe(200);
    expect((await owner.call('GET', '/api/vault/audit')).data.length).toBeGreaterThan(2);
    expect((await tech.b.call('GET', '/api/vault/audit')).status).toBe(403);
  });

  it('enforces a per-client reveal reason when the client requires one', async () => {
    const item = (await create(owner, harbor)).data;
    await owner.call('PATCH', `/api/clients/${harbor}`, { requireRevealReason: true });
    // A partial update leaves other client fields alone.
    expect((await owner.call('GET', `/api/clients/${harbor}`)).data).toMatchObject({
      name: 'Harbor Dental Group',
      type: 'Customer',
      requireRevealReason: true,
    });
    const denied = await owner.call('POST', `/api/passwords/${item.id}/reveal`, {});
    expect(denied.status).toBe(400);
    expect(denied.data.code).toBe('reason_required');
    expect(
      (await owner.call('POST', `/api/passwords/${item.id}/reveal`, { reason: 'Ticket #4411 firewall upgrade' })).data
        .value,
    ).toBe(SECRET);
    expect((await owner.call('GET', `/api/passwords/${item.id}/audit`)).data[0].reason).toBe(
      'Ticket #4411 firewall upgrade',
    );
  });

  it('validates BitLocker keys and TOTP seeds, and links vault items to assets', async () => {
    expect((await create(owner, harbor, { kind: 'bitlocker', name: 'HDG-DC-01 C:', secret: '1234' })).status).toBe(400);
    expect((await create(owner, harbor, { totp: 'not a seed!' })).status).toBe(400);
    const key = (
      await create(owner, harbor, {
        kind: 'bitlocker',
        name: 'HDG-DC-01 C:',
        username: 'Key ID 3F2A',
        secret: ` ${BITLOCKER} `,
      })
    ).data;
    expect(key.kind).toBe('bitlocker');
    expect((await owner.call('POST', `/api/passwords/${key.id}/reveal`, {})).data.value).toBe(BITLOCKER);
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const asset = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: layouts.find((l) => l.key === 'configuration')!.id,
        name: 'HDG-DC-01',
      })
    ).data;
    const linked = await owner.call('POST', `/api/items/asset/${asset.id}/relations`, { type: 'password', id: key.id });
    expect(linked.status, JSON.stringify(linked.data)).toBe(200);
    // Someone who can read the asset but not the vault doesn't see the linked key.
    const editor = await person('ed@atlas.test', 'editing tech pass 1', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    expect((await editor.b.call('GET', `/api/items/asset/${asset.id}/relations`)).data).toEqual([]);
    expect((await owner.call('GET', `/api/items/asset/${asset.id}/relations`)).data[0].type).toBe('password');
    const form = `--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhi\r\n--x--\r\n`;
    const upload = await t.app.inject({
      method: 'POST',
      url: `/api/items/password/${key.id}/attachments`,
      payload: form,
      headers: { 'content-type': 'multipart/form-data; boundary=x', cookie: owner.cookie, 'x-csrf-token': owner.csrf },
    });
    expect(upload.statusCode).toBe(400);
  });

  it('share links hold only browser ciphertext, expire, and open once', async () => {
    const item = (await create(owner, harbor)).data;
    const ciphertext = randomBytes(64).toString('base64url');
    const share = (
      await owner.call('POST', `/api/passwords/${item.id}/shares`, { ciphertext, maxViews: 1, expiresHours: 2 })
    ).data;
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify((await t.handle.pool.query('select * from share_links')).rows)).not.toContain(share.token);
    const open = () => t.app.inject({ method: 'POST', url: `/api/shares/${share.token}/open` });
    const [first, second] = await Promise.all([open(), open()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
    expect(JSON.parse((first.statusCode === 200 ? first : second).body)).toEqual({ ciphertext, remainingViews: 0 });
    expect((await t.app.inject({ method: 'POST', url: '/api/shares/not-a-token/open' })).statusCode).toBe(404);

    const two = (await owner.call('POST', `/api/passwords/${item.id}/shares`, { ciphertext, maxViews: 2 })).data;
    await owner.call('DELETE', `/api/passwords/${item.id}/shares/${two.id}`);
    expect((await t.app.inject({ method: 'POST', url: `/api/shares/${two.token}/open` })).statusCode).toBe(404);
    const expired = (await owner.call('POST', `/api/passwords/${item.id}/shares`, { ciphertext, maxViews: 1 })).data;
    await t.handle.pool.query(`update share_links set expires_at = now() - interval '1 minute' where id = $1`, [
      expired.id,
    ]);
    expect((await t.app.inject({ method: 'POST', url: `/api/shares/${expired.token}/open` })).statusCode).toBe(404);
    const actions = (await owner.call('GET', `/api/passwords/${item.id}/audit`)).data.map(
      (a: { action: string }) => a.action,
    );
    expect(actions).toContain('Opened a share link (view 1 of 1)');
    expect(actions).toContain('Revoked a share link');
  });

  it('re-wraps data keys under a new master key without losing access', async () => {
    const item = (await create(owner, harbor)).data;
    // The app's master key isn't exposed to tests, so check the mechanism with its own keys.
    const oldMaster = staticKeyProvider([randomBytes(32)]);
    const orgId = (await t.handle.pool.query('select id from orgs')).rows[0].id as string;
    await t.handle.db.delete(schema.vaultKeys);
    const before = new VaultKeys(t.handle.db, oldMaster);
    const sealed = await before.seal(orgId, 'rotating secret', 'test|aad');
    const newKey = randomBytes(32);
    expect(
      await VaultKeys.rewrapAll(t.handle.db, staticKeyProvider([newKey, ...[oldMaster.key(oldMaster.keyId)]])),
    ).toBe(1);
    const after = new VaultKeys(t.handle.db, staticKeyProvider([newKey]));
    expect(await after.open(orgId, sealed, 'test|aad')).toBe('rotating secret');
    await expect(new VaultKeys(t.handle.db, oldMaster).open(orgId, sealed, 'test|aad')).rejects.toThrow();
    expect(item.id).toBeTruthy();
  });
});
