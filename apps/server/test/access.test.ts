import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('roles and client access', () => {
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

  async function newUser(body: Record<string, unknown>) {
    const r = await owner.call('POST', '/api/users', { password: TEMP, ...body });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data;
  }
  async function activate(email: string, next: string, staff: boolean) {
    const { b, r } = await signIn(t.app, email, TEMP);
    expect(r.data.stage).toBe('password');
    const changed = await b.call('POST', '/api/account/password', { current: TEMP, next });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    if (staff) {
      expect(changed.data.stage).toBe('mfa-setup');
      await enroll(b);
    } else expect(changed.data.stage).toBe('active');
    return b;
  }

  it('validates grants: at least one client, same org, within the role cap, unique emails', async () => {
    for (const body of [
      { email: 'a@x.test', name: 'A', role: 'client_viewer', grants: [] },
      {
        email: 'a@x.test',
        name: 'A',
        role: 'client_viewer',
        grants: [{ clientId: '00000000-0000-4000-8000-000000000000', level: 'read' }],
      },
      { email: 'a@x.test', name: 'A', role: 'client_viewer', grants: [{ clientId: harbor, level: 'edit' }] },
      {
        email: 'a@x.test',
        name: 'A',
        role: 'client_viewer',
        allClients: 'read',
        grants: [{ clientId: harbor, level: 'read' }],
      },
      { email: 'a@x.test', name: 'A', role: 'readonly_technician', allClients: 'edit' },
    ])
      expect((await owner.call('POST', '/api/users', { password: TEMP, ...body })).status).toBe(400);
    await newUser({
      email: 'dup@x.test',
      name: 'Dup',
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect(
      (
        await owner.call('POST', '/api/users', {
          email: 'DUP@x.test',
          name: 'D',
          role: 'client_viewer',
          password: TEMP,
          grants: [{ clientId: harbor, level: 'read' }],
        })
      ).status,
    ).toBe(409);
  });

  it('client viewers are read-only and see only their clients (others look missing)', async () => {
    await newUser({
      email: 'morgan@harbor.test',
      name: 'Morgan Ellis',
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    const v = await activate('morgan@harbor.test', 'harbor reader pass 7', false);
    const list = (await v.call('GET', '/api/clients')).data;
    expect(list.map((c: { name: string }) => c.name)).toEqual(['Harbor Dental Group']);
    expect(list[0].access).toBe('read');
    expect((await v.call('GET', `/api/clients/${northline}`)).status).toBe(404);
    expect((await v.call('GET', '/api/clients/not-a-uuid')).status).toBe(404);
    expect((await v.call('PATCH', `/api/clients/${harbor}`, { notes: 'x' })).status).toBe(403);
    expect((await v.call('POST', '/api/clients', { name: 'Nope' })).status).toBe(403);
    expect((await v.call('GET', '/api/users')).status).toBe(403);
    expect((await v.call('GET', '/api/security-events')).status).toBe(403);
  });

  it('restricted technicians edit only granted clients; changes apply to live sessions', async () => {
    const tech = await newUser({
      email: 'casey@atlas.test',
      name: 'Casey Tech',
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    const b = await activate('casey@atlas.test', 'cobalt fresh pass 12', true);
    expect((await b.call('PATCH', `/api/clients/${harbor}`, { notes: 'Updated' })).status).toBe(200);
    expect((await b.call('GET', `/api/clients/${northline}`)).status).toBe(404);
    expect((await b.call('POST', '/api/clients', { name: 'Blocked' })).status).toBe(403);
    // Widen to read on everything: Northline becomes readable but not editable.
    expect((await owner.call('PATCH', `/api/users/${tech.id}`, { allClients: 'read' })).status).toBe(200);
    expect((await b.call('GET', `/api/clients/${northline}`)).data.access).toBe('read');
    expect((await b.call('PATCH', `/api/clients/${northline}`, { notes: 'x' })).status).toBe(403);
    // Demote to read-only technician: the edit grant is capped at read immediately.
    expect(
      (
        await owner.call('PATCH', `/api/users/${tech.id}`, {
          role: 'readonly_technician',
          grants: [{ clientId: harbor, level: 'read' }],
        })
      ).status,
    ).toBe(200);
    expect((await b.call('PATCH', `/api/clients/${harbor}`, { notes: 'x' })).status).toBe(403);
    // Disable: every session ends.
    expect((await owner.call('PATCH', `/api/users/${tech.id}`, { disabled: true })).status).toBe(200);
    expect((await b.call('GET', '/api/clients')).status).toBe(401);
    expect((await signIn(t.app, 'casey@atlas.test', 'cobalt fresh pass 12')).r.status).toBe(401);
  });

  it('group grants give access; admin resets sign users out and can clear MFA', async () => {
    const tech = await newUser({
      email: 'sam@atlas.test',
      name: 'Sam Tech',
      role: 'technician',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    const b = await activate('sam@atlas.test', 'sam fresh password 1', true);
    // Group grants are created directly until the M3 groups UI exists.
    const { rows } = await t.handle.pool.query(
      `insert into groups (org_id, name) select org_id, 'Northline team' from users where id = $1 returning id`,
      [tech.id],
    );
    await t.handle.pool.query('insert into group_members values ($1, $2)', [rows[0].id, tech.id]);
    await t.handle.pool.query(`insert into client_access (client_id, group_id, level) values ($1, $2, 'edit')`, [
      northline,
      rows[0].id,
    ]);
    expect((await b.call('PATCH', `/api/clients/${northline}`, { notes: 'group edit' })).status).toBe(200);
    const reset = await owner.call('POST', `/api/users/${tech.id}/reset`, {
      password: 'another temp pass 9',
      resetMfa: true,
    });
    expect(reset.data.mfa).toBe(false);
    expect(reset.data.mustChangePassword).toBe(true);
    expect((await b.call('GET', '/api/clients')).status).toBe(401);
    const actions = (await owner.call('GET', '/api/security-events')).data.map((e: { action: string }) => e.action);
    for (const a of ['User created', 'Password changed', 'Password reset']) expect(actions).toContain(a);
  });

  it('owners are protected: no self-demotion, admins cannot touch owners, one owner remains', async () => {
    const me = (await owner.call('GET', '/api/users')).data[0];
    expect((await owner.call('PATCH', `/api/users/${me.id}`, { role: 'admin' })).status).toBe(400);
    expect((await owner.call('PATCH', `/api/users/${me.id}`, { disabled: true })).status).toBe(400);
    expect((await owner.call('POST', `/api/users/${me.id}/reset`, { password: 'some new pass 123' })).status).toBe(400);
    await newUser({ email: 'ada@atlas.test', name: 'Ada Admin', role: 'admin' });
    const admin = await activate('ada@atlas.test', 'ada fresh password 1', true);
    expect((await admin.call('PATCH', `/api/users/${me.id}`, { name: 'Renamed' })).status).toBe(403);
    expect(
      (await admin.call('POST', '/api/users', { email: 'o2@atlas.test', name: 'O2', role: 'owner', password: TEMP }))
        .status,
    ).toBe(403);
    expect((await admin.call('GET', `/api/clients/${northline}`)).data.access).toBe('edit_passwords');
    expect((await owner.call('PATCH', '/api/users/00000000-0000-4000-8000-000000000000', { name: 'x' })).status).toBe(
      404,
    );
  });
});
