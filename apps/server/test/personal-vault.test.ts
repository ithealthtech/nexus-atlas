import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../src/identity/totp.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const POLICY = {
  generator: { minLength: 12, requireDigits: false, requireSymbols: false, allowPins: true },
  requireRevealReason: false,
  blockReadOnlyReveal: false,
  restrictedListedOnly: false,
};

describe('personal vaults', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
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
    return b;
  }
  const rows = async (table: string) => JSON.stringify((await t.handle.pool.query(`select * from ${table}`)).rows);

  it('keeps logins and notes that only their owner can list, open, change, or delete', async () => {
    const tech = await person('rowan@atlas.test', 'amber quiet lake 47', {
      role: 'readonly_technician',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect((await tech.call('GET', '/api/personal-vault/status')).data).toEqual({ enabled: true, count: 0 });

    const made = await tech.call('POST', '/api/personal-vault', {
      name: 'Zephyr payroll portal',
      username: 'rowan',
      url: 'https://payroll.example.com',
      secret: 'Sup3r-private-Zephyr!',
      notes: 'Security question: first pet',
      totp: SEED,
    });
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    expect(made.data).toMatchObject({
      kind: 'login',
      name: 'Zephyr payroll portal',
      username: 'rowan',
      hasNotes: true,
      hasTotp: true,
      favorite: false,
      version: 1,
    });
    expect(made.data.strength).toBeGreaterThan(1);
    // The view never carries a secret.
    expect(JSON.stringify(made.data)).not.toContain('Sup3r');
    const id = made.data.id as string;
    const note = await tech.call('POST', '/api/personal-vault', {
      kind: 'note',
      name: 'Locker combination',
      secret: '12-34-56',
      username: 'ignored',
      totp: SEED,
    });
    expect(note.data).toMatchObject({ kind: 'note', username: '', hasTotp: false, strength: null });
    expect((await tech.call('POST', '/api/personal-vault', { name: 'Empty', secret: '' })).status).toBe(400);
    expect((await tech.call('GET', '/api/personal-vault')).data.map((p: { name: string }) => p.name)).toEqual([
      'Locker combination',
      'Zephyr payroll portal',
    ]);

    const reveal = (b: Browser, field: string) => b.call('POST', `/api/personal-vault/${id}/reveal`, { field });
    expect((await reveal(tech, 'secret')).data).toEqual({ value: 'Sup3r-private-Zephyr!' });
    expect((await reveal(tech, 'notes')).data.value).toBe('Security question: first pet');
    expect((await reveal(tech, 'totp')).data.value).toBe(totp(SEED));
    expect((await tech.call('POST', `/api/personal-vault/${note.data.id}/reveal`, { field: 'notes' })).status).toBe(
      404,
    );

    // Stored encrypted.
    const stored = (await t.handle.pool.query(`select secret, notes, totp from personal_passwords where id = $1`, [id]))
      .rows[0];
    expect(JSON.stringify(stored)).not.toMatch(/Sup3r|first pet|JBSWY/);

    // Nobody else reaches it, whatever their role: the owner of the organization gets the same 404 as a stranger.
    for (const other of [owner, await person('ada@atlas.test', 'maple north orbit 9', { role: 'admin' })]) {
      expect((await other.call('GET', '/api/personal-vault')).data).toEqual([]);
      expect((await other.call('GET', `/api/personal-vault/${id}`)).status).toBe(404);
      expect((await reveal(other, 'secret')).status).toBe(404);
      expect((await other.call('PATCH', `/api/personal-vault/${id}`, { name: 'Mine now', version: 1 })).status).toBe(
        404,
      );
      expect((await other.call('DELETE', `/api/personal-vault/${id}`)).status).toBe(404);
    }
    // Not in the shared vault, search, the activity feed, or any log.
    expect((await owner.call('GET', '/api/passwords')).data).toEqual([]);
    expect(JSON.stringify((await owner.call('GET', '/api/search?q=payroll')).data)).not.toContain('Zephyr');
    for (const table of ['vault_audit', 'security_events', 'activity', 'request_log'])
      expect(await rows(table), table).not.toMatch(/Zephyr|Locker combination/);

    // Changes: what's left out stays, a stale version is refused, and an emptied field is cleared.
    const changed = await tech.call('PATCH', `/api/personal-vault/${id}`, {
      name: 'Zephyr payroll',
      secret: 'An0ther-Zephyr-secret?',
      notes: '',
      favorite: true,
      version: 1,
    });
    expect(changed.data).toMatchObject({
      name: 'Zephyr payroll',
      username: 'rowan',
      hasNotes: false,
      hasTotp: true,
      favorite: true,
      version: 2,
    });
    expect((await reveal(tech, 'secret')).data.value).toBe('An0ther-Zephyr-secret?');
    expect((await tech.call('PATCH', `/api/personal-vault/${id}`, { name: 'Late', version: 1 })).status).toBe(409);
    // Favorites first.
    expect((await tech.call('GET', '/api/personal-vault')).data[0].name).toBe('Zephyr payroll');

    expect((await tech.call('DELETE', `/api/personal-vault/${id}`)).status).toBe(200);
    expect((await tech.call('GET', `/api/personal-vault/${id}`)).status).toBe(404);
    expect((await tech.call('GET', '/api/personal-vault/status')).data).toEqual({ enabled: true, count: 1 });
  });

  it('is for staff signed in to Atlas: not client accounts, API keys, or an organization that turned it off', async () => {
    const made = await owner.call('POST', '/api/personal-vault', { name: 'Bank', secret: 'Bank-pass-2026!x' });
    expect(made.status).toBe(201);

    const viewer = await person(
      'casey@atlas.test',
      'silver window frame 3',
      { role: 'client_viewer', grants: [{ clientId: harbor, level: 'read' }] },
      false,
    );
    expect((await viewer.call('GET', '/api/personal-vault/status')).data).toEqual({ enabled: false, count: 0 });
    expect((await viewer.call('GET', '/api/personal-vault')).status).toBe(404);
    expect((await viewer.call('POST', '/api/personal-vault', { name: 'x', secret: 'y' })).status).toBe(404);

    const key = (await owner.call('POST', '/api/api-keys', { name: 'Sync', scopes: ['read', 'write', 'passwords'] }))
      .data;
    const headers = { authorization: `Bearer ${key.token}` };
    for (const url of ['/api/v1/personal-vault', `/api/v1/personal-vault/${made.data.id}`]) {
      const res = await t.app.inject({ method: 'GET', url, headers });
      expect([403, 404], url).toContain(res.statusCode);
      expect(res.body).not.toContain('Bank');
    }
    const revealed = await t.app.inject({
      method: 'POST',
      url: `/api/v1/personal-vault/${made.data.id}/reveal`,
      headers,
      payload: {},
    });
    expect([403, 404]).toContain(revealed.statusCode);
    expect(revealed.body).not.toContain('Bank-pass');

    // Turned off: hidden and closed, but nothing is deleted.
    expect((await owner.call('GET', '/api/vault/policy')).data.personalVaults).toBe(true);
    const off = await owner.call('PUT', '/api/settings/vault-policy', { ...POLICY, personalVaults: false });
    expect(off.status, JSON.stringify(off.data)).toBe(200);
    expect((await owner.call('GET', '/api/personal-vault/status')).data).toEqual({ enabled: false, count: 0 });
    for (const r of [
      await owner.call('GET', '/api/personal-vault'),
      await owner.call('POST', '/api/personal-vault', { name: 'New', secret: 'New-pass-2026!x' }),
      await owner.call('POST', `/api/personal-vault/${made.data.id}/reveal`, {}),
      await owner.call('DELETE', `/api/personal-vault/${made.data.id}`),
    ])
      expect(r).toMatchObject({ status: 403, data: { code: 'personal_vaults_off' } });
    await owner.call('PUT', '/api/settings/vault-policy', { ...POLICY, personalVaults: true });
    expect((await owner.call('POST', `/api/personal-vault/${made.data.id}/reveal`, {})).data.value).toBe(
      'Bank-pass-2026!x',
    );
  });
});
