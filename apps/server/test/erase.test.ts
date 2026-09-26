import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { totp, totpStep } from '../src/identity/totp.js';
import { OWNER, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('erase all data', () => {
  let t: TestApp;
  let owner: Browser;
  let secret: string;
  let dir: string;
  let org: string;
  // The code for the next time step: signing in used the current one, and each code works once.
  const code = () => totp(secret, totpStep() + 1);
  /** Moves the pending request's wait into the past, instead of waiting ten minutes. */
  const skipWait = () =>
    t.handle.db.execute(
      sql`update orgs set settings = jsonb_set(settings, '{erase,confirmableAt}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text))`,
    );

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-erase-'));
    t = await startApp({ ATLAS_DATA_DIR: join(dir, 'data'), ATLAS_BACKUP_DIR: join(dir, 'backups') });
    ({ b: owner, secret } = await setupOwner(t.app));
    org = ((await t.handle.db.execute(sql`select name from orgs`)).rows[0] as { name: string }).name;
    // Email on, so the notices to administrators can be checked.
    await owner.call('PUT', '/api/settings/email', {
      enabled: true,
      preset: 'm365',
      host: 'smtp.office365.com',
      port: 587,
      security: 'starttls',
      username: 'atlas@itdonerightnc.test',
      password: 'smtp-app-secret-9981',
      fromAddress: 'atlas@itdonerightnc.test',
      fromName: 'IT Done Right',
    });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Firewall', secret: 'Tr0ub4dor&3-Harbor!' });
    await owner.call('POST', '/api/documents', { title: 'MSP runbook', content: { type: 'doc', content: [] } });
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks for the password, a fresh code, and the exact name; waits; backs up; then erases documentation only', async () => {
    const request = (body: object) => owner.call('POST', '/api/org/erase/request', body);
    expect((await request({ password: OWNER.password, code: code(), confirmName: 'wrong name' })).status).toBe(400);
    expect((await request({ password: 'not my password', code: code(), confirmName: org })).status).toBe(400);
    expect((await request({ password: OWNER.password, code: '000000', confirmName: org })).status).toBe(400);
    expect((await owner.call('GET', '/api/org/erase')).data.pending).toBeNull();

    const ok = await request({ password: OWNER.password, code: code(), confirmName: org });
    expect(ok.status).toBe(200);
    expect(ok.data.pending).toMatchObject({ confirmable: false });
    // Every administrator is told.
    expect(t.outbox.some((m) => m.subject.includes('erase all data was requested'))).toBe(true);

    // Too early: nothing happens.
    expect((await owner.call('POST', '/api/org/erase/confirm', { confirmName: org })).status).toBe(409);
    expect((await owner.call('GET', '/api/clients')).data).toHaveLength(1);

    await skipWait();
    expect((await owner.call('POST', '/api/org/erase/confirm', { confirmName: 'Wrong' })).status).toBe(400);
    const erased = await owner.call('POST', '/api/org/erase/confirm', { confirmName: org });
    expect(erased.status).toBe(200);
    expect(erased.data).toMatchObject({ clients: 1, documents: 1 });

    // A full backup was written first.
    expect(readdirSync(join(dir, 'backups')).length).toBeGreaterThan(0);
    // Documentation is gone; people, the owner's sign-in, and the security log remain.
    expect((await owner.call('GET', '/api/clients')).data).toEqual([]);
    expect((await owner.call('GET', '/api/documents')).data).toEqual([]);
    expect((await owner.call('GET', '/api/users')).status).toBe(200);
    const log = (await t.handle.db.execute(sql`select action from security_events`)).rows.map(
      (r) => (r as { action: string }).action,
    );
    expect(log).toEqual(expect.arrayContaining(['Erase all data requested', 'All data erased']));
    expect((await owner.call('GET', '/api/org/erase')).data.pending).toBeNull();
  });

  it('can be cancelled by any administrator, and only the owner can ask for it', async () => {
    await owner.call('POST', '/api/users', {
      email: 'ada@atlas.test',
      name: 'Ada Admin',
      password: TEMP,
      role: 'admin',
      allClients: 'edit_passwords',
    });
    const { b: admin } = await signIn(t.app, 'ada@atlas.test', TEMP);
    await admin.call('POST', '/api/account/password', { current: TEMP, next: 'second admin pass 42' });
    await enroll(admin);

    expect(
      (
        await admin.call('POST', '/api/org/erase/request', {
          password: 'second admin pass 42',
          code: '123456',
          confirmName: org,
        })
      ).status,
    ).toBe(403);

    await owner.call('POST', '/api/org/erase/request', { password: OWNER.password, code: code(), confirmName: org });
    expect((await admin.call('GET', '/api/org/erase')).data.pending).not.toBeNull();
    expect((await admin.call('DELETE', '/api/org/erase')).data.pending).toBeNull();
    expect(t.outbox.some((m) => m.subject.includes('was cancelled'))).toBe(true);

    // Cancelled means cancelled: even after the wait, there's nothing to confirm.
    await skipWait();
    expect((await owner.call('POST', '/api/org/erase/confirm', { confirmName: org })).status).toBe(409);
    expect((await owner.call('GET', '/api/clients')).data).toHaveLength(1);
  });
});
