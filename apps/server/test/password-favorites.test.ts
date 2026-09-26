import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('password favorites and recently used', () => {
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

  const add = (name: string) =>
    owner.call('POST', `/api/clients/${harbor}/passwords`, { name, secret: 'Tr0ub4dor&3-Harbor!' });

  it('keeps favorites per person, and tracks what each person last used', async () => {
    const fw = (await add('Firewall admin')).data;
    const wifi = (await add('Office Wi-Fi')).data;
    expect(fw).toMatchObject({ favorite: false, lastUsedAt: null });

    expect((await owner.call('PUT', `/api/passwords/${fw.id}/favorite`, {})).data.favorite).toBe(true);
    // Idempotent.
    expect((await owner.call('PUT', `/api/passwords/${fw.id}/favorite`, {})).status).toBe(200);

    // Using a password (reveal or copy) makes it recently used, for that person only.
    await owner.call('POST', `/api/passwords/${wifi.id}/reveal`, { copy: true });
    const list = (await owner.call('GET', `/api/passwords?client=${harbor}`)).data as {
      id: string;
      favorite: boolean;
      lastUsedAt: string | null;
    }[];
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get(fw.id)).toMatchObject({ favorite: true, lastUsedAt: null });
    expect(byId.get(wifi.id)!.favorite).toBe(false);
    expect(Date.now() - Date.parse(byId.get(wifi.id)!.lastUsedAt!)).toBeLessThan(60_000);

    // Another technician sees neither.
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
    const theirs = (await tech.call('GET', `/api/passwords/${fw.id}`)).data;
    expect(theirs).toMatchObject({ favorite: false, lastUsedAt: null });

    expect((await owner.call('DELETE', `/api/passwords/${fw.id}/favorite`)).data.favorite).toBe(false);
  });

  it('only lets people favorite passwords they can use', async () => {
    const fw = (await add('Firewall admin')).data;
    await owner.call('POST', '/api/users', {
      email: 'reader@atlas.test',
      name: 'Rita',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    const { b: reader } = await signIn(t.app, 'reader@atlas.test', TEMP);
    await reader.call('POST', '/api/account/password', { current: TEMP, next: 'folder tech pass 7' });
    await enroll(reader);
    expect((await reader.call('PUT', `/api/passwords/${fw.id}/favorite`, {})).status).toBe(404);
  });
});
