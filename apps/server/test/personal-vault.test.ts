import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '../src/identity/totp.js';
import { OWNER, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

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

  it('moves an entry into a client’s vault, where it becomes an ordinary shared password', async () => {
    const northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    const tech = await person('quinn@atlas.test', 'maple north orbit 9', {
      role: 'technician',
      grants: [
        { clientId: harbor, level: 'edit_passwords' },
        { clientId: northline, level: 'edit' },
      ],
    });
    const add = async (b: Browser, body: Record<string, unknown>) => {
      const r = await b.call('POST', '/api/personal-vault', body);
      expect(r.status, JSON.stringify(r.data)).toBe(201);
      return r.data.id as string;
    };
    const login = await add(tech, {
      name: 'Harbor phone portal',
      username: 'quinn',
      url: 'https://phones.example.com',
      secret: 'Ph0ne-portal-secret!',
      notes: 'Ask for Dana',
      totp: SEED,
    });
    const note = await add(tech, { kind: 'note', name: 'Harbor alarm code', secret: 'Front door: 4821' });
    const move = (b: Browser, id: string, body: unknown) => b.call('POST', `/api/personal-vault/${id}/move`, body);
    const count = async (b: Browser) => (await b.call('GET', '/api/personal-vault/status')).data.count;

    // It needs password access to the client, a real client, and a folder of that client. A refusal moves nothing.
    const stranger = (await owner.call('POST', '/api/clients', { name: 'Cedar Veterinary' })).data.id;
    const elsewhere = (await owner.call('POST', `/api/clients/${northline}/password-folders`, { name: 'Vendors' })).data
      .id;
    expect((await move(tech, login, {})).status).toBe(400);
    expect((await move(tech, login, { clientId: stranger })).status).toBe(404);
    expect((await move(tech, login, { clientId: northline })).status).toBe(403);
    expect((await move(tech, login, { clientId: harbor, folderId: elsewhere })).status).toBe(400);
    // Nobody moves someone else's entry, whatever their role.
    expect((await move(owner, login, { clientId: harbor })).status).toBe(404);
    expect(await count(tech)).toBe(2);
    expect((await owner.call('GET', `/api/passwords?client=${harbor}`)).data).toEqual([]);

    const phones = (await owner.call('POST', `/api/clients/${harbor}/password-folders`, { name: 'Phones' })).data.id;
    const moved = await move(tech, login, { clientId: harbor, folderId: phones });
    expect(moved.status, JSON.stringify(moved.data)).toBe(200);
    expect(moved.data).toEqual({
      passwordId: expect.any(String),
      clientId: harbor,
      clientName: 'Harbor Dental Group',
    });
    // Gone from the personal vault, and it can't be moved a second time.
    expect((await tech.call('GET', `/api/personal-vault/${login}`)).status).toBe(404);
    expect((await move(tech, login, { clientId: harbor })).status).toBe(404);
    expect(await count(tech)).toBe(1);

    // In the client's vault it is everything it was, for everyone with password access there.
    const shared = moved.data.passwordId as string;
    expect((await owner.call('GET', `/api/passwords/${shared}`)).data).toMatchObject({
      kind: 'login',
      name: 'Harbor phone portal',
      username: 'quinn',
      url: 'https://phones.example.com',
      clientId: harbor,
      folderName: 'Phones',
      hasNotes: true,
      hasTotp: true,
      restricted: false,
      clientVisible: false,
    });
    const reveal = async (id: string, field: string) =>
      (await owner.call('POST', `/api/passwords/${id}/reveal`, { field })).data.value;
    expect(await reveal(shared, 'secret')).toBe('Ph0ne-portal-secret!');
    expect(await reveal(shared, 'notes')).toBe('Ask for Dana');
    expect(await reveal(shared, 'totp')).toBe(totp(SEED));
    // From here on it is audited like any other shared password, starting with who put it there.
    const audit = (await owner.call('GET', `/api/passwords/${shared}/audit`)).data as {
      action: string;
      actorName: string;
    }[];
    expect(audit.find((a) => a.action === 'Created')).toMatchObject({ actorName: 'quinn' });

    // A note moves as a note.
    const movedNote = (await move(tech, note, { clientId: harbor })).data.passwordId as string;
    expect((await owner.call('GET', `/api/passwords/${movedNote}`)).data).toMatchObject({
      kind: 'note',
      name: 'Harbor alarm code',
      folderName: null,
    });
    expect(await reveal(movedNote, 'secret')).toBe('Front door: 4821');
    expect(await count(tech)).toBe(0);
    expect((await owner.call('GET', `/api/passwords?client=${harbor}`)).data).toHaveLength(2);
  });

  it('exports a person’s own vault as a file other password managers read, after their password again', async () => {
    await owner.call('POST', '/api/personal-vault', {
      name: 'Bank',
      username: 'avery',
      url: 'https://bank.example.com',
      // Kept exactly: commas, quotes, and a leading "=" all have to survive an import elsewhere.
      secret: '=Tricky,"pass"',
      notes: 'PIN is separate',
      totp: SEED,
      favorite: true,
    });
    await owner.call('POST', '/api/personal-vault', {
      kind: 'note',
      name: 'alarm code',
      secret: 'Front: 4821\nBack: 9930',
    });
    const tech = await person('quinn@atlas.test', 'maple north orbit 9', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    await tech.call('POST', '/api/personal-vault', { name: 'Quinn only', secret: 'Quinn-private-2026!' });

    // Every secret at once needs the password again.
    await t.handle.pool.query('update sessions set reauth_at = null');
    const stale = await owner.call('GET', '/api/personal-vault/export');
    expect([stale.status, stale.data.code]).toEqual([403, 'reauth']);
    await owner.call('POST', '/api/session/reauth', { password: OWNER.password });

    const file = await owner.call('GET', '/api/personal-vault/export');
    expect(file.status, JSON.stringify(file.data)).toBe(200);
    expect(String(file.headers['content-type'])).toContain('text/csv');
    expect(String(file.headers['content-disposition'])).toMatch(
      /^attachment; filename="my-vault-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(file.data).toBe(
      [
        'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
        ',,note,alarm code,"Front: 4821\nBack: 9930",,0,,,,',
        `,1,login,Bank,PIN is separate,,0,https://bank.example.com,avery,"=Tricky,""pass""",${SEED}`,
        '',
      ].join('\r\n'),
    );
    // Only their own entries, and the security log says an export happened without saying what was in it.
    expect(file.data).not.toContain('Quinn');
    const events = (await t.handle.pool.query(`select actor, action, detail from security_events`)).rows as {
      actor: string;
      action: string;
      detail: string;
    }[];
    expect(events.filter((e) => e.action === 'Personal vault exported')).toEqual([
      { actor: 'Avery Owner', action: 'Personal vault exported', detail: '' },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/Bank|alarm code|Tricky/);

    // Not for API keys, and not while personal vaults are off.
    const key = (await owner.call('POST', '/api/api-keys', { name: 'Sync', scopes: ['read', 'write', 'passwords'] }))
      .data;
    const viaKey = await t.app.inject({
      method: 'GET',
      url: '/api/v1/personal-vault/export',
      headers: { authorization: `Bearer ${key.token}` },
    });
    expect([403, 404]).toContain(viaKey.statusCode);
    expect(viaKey.body).not.toContain('Bank');
    await owner.call('PUT', '/api/settings/vault-policy', { ...POLICY, personalVaults: false });
    expect((await owner.call('GET', '/api/personal-vault/export')).data.code).toBe('personal_vaults_off');
  });
});
