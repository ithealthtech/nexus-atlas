import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'Temporary-Passw0rd-2026!';

describe('setting up a new installation', () => {
  let t: TestApp;
  let owner: Browser;
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('ticks each step off from what is really there, and only for administrators', async () => {
    const status = async () => (await owner.call('GET', '/api/admin/setup')).data;
    expect(await status()).toEqual({
      branding: false,
      email: false,
      client: false,
      import: false,
      rmm: false,
      microsoft: false,
      team: false,
      backup: false,
    });

    await owner.call('PUT', '/api/branding', { brandName: 'IT Done Right' });
    await owner.call('PUT', '/api/settings/email', {
      enabled: true,
      preset: 'custom',
      host: 'smtp.example.test',
      port: 587,
      security: 'starttls',
      username: 'atlas@example.test',
      password: 'smtp-app-secret-9981',
      fromAddress: 'atlas@example.test',
      fromName: 'IT Done Right',
    });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const tech = await owner.call('POST', '/api/users', {
      email: 'tech@example.test',
      name: 'Tess Tech',
      role: 'technician',
      password: TEMP,
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    expect(tech.status, JSON.stringify(tech.data)).toBe(201);
    expect(await status()).toMatchObject({ branding: true, email: true, client: true, team: true, backup: false });

    // An email server switched off isn't set up.
    await owner.call('PUT', '/api/settings/email', { enabled: false, host: 'smtp.example.test' });
    expect((await status()).email).toBe(false);

    const anon = await t.app.inject({ method: 'GET', url: '/api/admin/setup' });
    expect(anon.statusCode).toBe(401);
  });
});
