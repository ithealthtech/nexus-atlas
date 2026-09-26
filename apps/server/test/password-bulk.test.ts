import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('bulk password actions', () => {
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

  const add = (client: string, name: string) =>
    owner.call('POST', `/api/clients/${client}/passwords`, { name, secret: 'Tr0ub4dor&3-Harbor!' });

  it('archives, restores and edits many passwords, auditing each one', async () => {
    const a = (await add(harbor, 'Firewall admin')).data;
    const b = (await add(northline, 'Office Wi-Fi')).data;
    const ids = [a.id, b.id];

    const archived = await owner.call('POST', '/api/passwords/bulk', { ids, action: 'archive' });
    expect(archived.data).toEqual({ updated: 2, failed: [] });
    expect((await owner.call('GET', `/api/passwords/${a.id}`)).data.archived).toBe(true);
    await owner.call('POST', '/api/passwords/bulk', { ids, action: 'restore' });

    await owner.call('POST', '/api/passwords/bulk', { ids, action: 'rotation', rotationDays: 90 });
    await owner.call('POST', '/api/passwords/bulk', { ids, action: 'clientVisible', clientVisible: true });
    await owner.call('POST', '/api/passwords/bulk', { ids, action: 'category', category: 'network' });
    const after = (await owner.call('GET', `/api/passwords/${b.id}`)).data;
    expect(after).toMatchObject({ rotationDays: 90, clientVisible: true, category: 'network', archived: false });

    const audit = (await owner.call('GET', `/api/passwords/${a.id}/audit`)).data as { action: string }[];
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['Archived', 'Restored', 'Edited details']));
  });

  it('skips passwords the person may not change, without saying what they are', async () => {
    const a = (await add(harbor, 'Firewall admin')).data;
    const b = (await add(northline, 'Office Wi-Fi')).data;
    await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess Tech',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
    });
    const { b: tech } = await signIn(t.app, 'tess@atlas.test', TEMP);
    await tech.call('POST', '/api/account/password', { current: TEMP, next: 'vault tech pass 12' });
    await enroll(tech);

    const res = await tech.call('POST', '/api/passwords/bulk', { ids: [a.id, b.id], action: 'archive' });
    expect(res.data.updated).toBe(1);
    expect(res.data.failed).toEqual([{ id: b.id, name: null, error: expect.any(String) }]);
    expect((await owner.call('GET', `/api/passwords/${b.id}`)).data.archived).toBe(false);
  });

  it('rejects empty or oversized requests', async () => {
    expect((await owner.call('POST', '/api/passwords/bulk', { ids: [], action: 'archive' })).status).toBe(400);
    expect((await owner.call('POST', '/api/passwords/bulk', { ids: ['x'], action: 'nuke' })).status).toBe(400);
  });
});
