import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupOwner, signIn, startApp, enroll, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('password folders', () => {
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

  const folder = async (clientId: string, name: string) =>
    owner.call('POST', `/api/clients/${clientId}/password-folders`, { name });
  const add = (clientId: string, body: Record<string, unknown>) =>
    owner.call('POST', `/api/clients/${clientId}/passwords`, { name: 'Admin', secret: 'Tr0ub4dor&3-Harbor!', ...body });

  it('files passwords in folders of the same client, and unfiles them when a folder is deleted', async () => {
    const network = (await folder(harbor, 'Network')).data;
    expect(network).toMatchObject({ name: 'Network', count: 0 });
    expect((await folder(harbor, 'network')).status).toBe(409);
    expect((await folder(harbor, '  ')).status).toBe(400);
    // The same name is fine for another client.
    const other = (await folder(northline, 'Network')).data;

    const pw = await add(harbor, { name: 'Firewall admin', folderId: network.id });
    expect(pw.status, JSON.stringify(pw.data)).toBe(201);
    expect(pw.data).toMatchObject({ folderId: network.id, folderName: 'Network' });
    // A folder from a different client is refused.
    expect((await add(harbor, { folderId: other.id })).status).toBe(400);

    const listed = (await owner.call('GET', `/api/passwords?client=${harbor}`)).data;
    expect(listed[0]).toMatchObject({ folderName: 'Network' });
    expect((await owner.call('GET', `/api/clients/${harbor}/password-folders`)).data[0].count).toBe(1);

    const renamed = await owner.call('PATCH', `/api/password-folders/${network.id}`, { name: 'Network gear' });
    expect(renamed.data).toMatchObject({ name: 'Network gear', count: 1 });

    // Moving out of a folder.
    const moved = await owner.call('PATCH', `/api/passwords/${pw.data.id}`, {
      folderId: null,
      version: pw.data.version,
    });
    expect(moved.data.folderId).toBeNull();
    const back = await owner.call('PATCH', `/api/passwords/${pw.data.id}`, {
      folderId: network.id,
      version: moved.data.version,
    });

    expect((await owner.call('DELETE', `/api/password-folders/${network.id}`)).status).toBe(200);
    const after = (await owner.call('GET', `/api/passwords/${pw.data.id}`)).data;
    expect(after).toMatchObject({ folderId: null, folderName: null, version: back.data.version });
  });

  it('needs password access to the client', async () => {
    const network = (await folder(harbor, 'Network')).data;
    const created = await owner.call('POST', '/api/users', {
      email: 'reader@atlas.test',
      name: 'Rita Reader',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const { b: reader } = await signIn(t.app, 'reader@atlas.test', TEMP);
    // (A new password may not contain the person's name or email.)
    const changed = await reader.call('POST', '/api/account/password', { current: TEMP, next: 'folder tech pass 7' });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    await enroll(reader);
    expect((await reader.call('GET', `/api/clients/${harbor}/password-folders`)).status).toBe(403);
    expect((await reader.call('POST', `/api/clients/${harbor}/password-folders`, { name: 'X' })).status).toBe(403);
    expect((await reader.call('DELETE', `/api/password-folders/${network.id}`)).status).toBe(403);
    expect((await reader.call('GET', `/api/clients/${northline}/password-folders`)).status).toBe(404);
  });
});
