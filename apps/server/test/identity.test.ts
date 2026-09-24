import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/identity/passwords.js';
import { totp, totpStep } from '../src/identity/totp.js';
import { OWNER, SETUP_CODE, browser, enroll, setupOwner, signIn, startApp, type TestApp } from './helpers.js';

describe('password hashing and TOTP', () => {
  it('uses salted scrypt compatible with Atlas 0.2', async () => {
    const a = await hashPassword('synthetic password 1');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await hashPassword('synthetic password 1')).not.toBe(a);
    expect(await verifyPassword('synthetic password 1', a)).toBe(true);
    expect(await verifyPassword('synthetic password 2', a)).toBe(false);
  });
  it('matches the RFC 6238 test vector', () => {
    // Secret "12345678901234567890", T=59s → 94287082 (last six digits).
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
  });
});

describe('identity', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await startApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('first-run setup needs the console code, runs once, and forces MFA enrollment', async () => {
    const b = browser(t.app);
    expect((await b.call('GET', '/api/setup')).data).toEqual({ needed: true, passwordReset: false });
    expect((await b.call('POST', '/api/setup', { ...OWNER, setupCode: 'wrong' })).status).toBe(403);
    expect((await b.call('POST', '/api/setup', { ...OWNER, password: 'short', setupCode: SETUP_CODE })).status).toBe(
      400,
    );
    const created = await b.call('POST', '/api/setup', { ...OWNER, setupCode: SETUP_CODE });
    expect(created.status).toBe(201);
    expect(created.data.actor.role).toBe('owner');
    expect(created.data.organization.name).toBe('IT Done Right');
    expect(String(created.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
    expect(
      (await browser(t.app).call('POST', '/api/setup', { ...OWNER, email: 'x@atlas.test', setupCode: SETUP_CODE }))
        .status,
    ).toBe(409);
    expect((await b.call('GET', '/api/clients')).status).toBe(403);
    const first = (await b.call('POST', '/api/account/mfa/setup', {})).data.secret;
    expect((await b.call('POST', '/api/account/mfa/setup', {})).data.secret).toBe(first);
    expect((await b.call('POST', '/api/account/mfa/confirm', { code: '000000' })).status).toBe(400);
    await enroll(b);
    expect((await b.call('GET', '/api/clients')).status).toBe(200);
    const { rows } = await t.handle.pool.query('select password_hash, mfa_secret from users');
    expect(JSON.stringify(rows)).not.toContain('correct horse');
    expect(rows[0].mfa_secret).toMatch(/^v2:/);
  });

  it('sign-in needs the password and a fresh MFA code; codes cannot be replayed', async () => {
    const { secret } = await setupOwner(t.app);
    expect((await signIn(t.app, OWNER.email, 'wrong password here')).r.status).toBe(401);
    expect((await signIn(t.app, 'nobody@atlas.test', OWNER.password)).r.status).toBe(401);
    const { b, r } = await signIn(t.app, OWNER.email.toUpperCase(), OWNER.password);
    expect(r.data.stage).toBe('mfa');
    expect((await b.call('GET', '/api/clients')).status).toBe(403);
    expect((await b.call('POST', '/api/session/mfa', { code: totp(secret) })).status).toBe(400);
    const ok = await b.call('POST', '/api/session/mfa', { code: totp(secret, totpStep() + 1) });
    expect(ok.data.stage).toBe('active');
    expect((await b.call('DELETE', '/api/session')).status).toBe(200);
    expect((await b.call('GET', '/api/clients')).status).toBe(401);
    const { rows } = await t.handle.pool.query('select action from security_events');
    const actions = rows.map((e) => e.action);
    for (const action of [
      'Owner created',
      'MFA enabled',
      'Sign-in failed',
      'MFA verification failed',
      'Signed in',
      'Signed out',
    ])
      expect(actions).toContain(action);
  });

  it('locks accounts after repeated failures, even for the right password', async () => {
    await setupOwner(t.app);
    for (let i = 0; i < 4; i++) expect((await signIn(t.app, OWNER.email, `wrong password ${i}!`)).r.status).toBe(401);
    expect((await signIn(t.app, OWNER.email, 'wrong password 5!')).r.status).toBe(429);
    expect((await signIn(t.app, OWNER.email, OWNER.password)).r.status).toBe(429);
  });

  it('rejects missing CSRF tokens, foreign origins and hosts, forged headers, and fake cookies', async () => {
    const { b } = await setupOwner(t.app);
    expect((await b.call('POST', '/api/clients', { name: 'x' }, { 'x-csrf-token': 'wrong' })).status).toBe(403);
    expect(
      (
        await browser(t.app).call(
          'POST',
          '/api/session',
          { email: OWNER.email, password: OWNER.password },
          { origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect((await browser(t.app).call('GET', '/api/setup', undefined, { host: 'evil.example' })).status).toBe(403);
    expect(
      (
        await browser(t.app).call('GET', '/api/clients', undefined, {
          'x-forwarded-user': 'admin',
          'oai-authenticated-user-email': 'a@b.c',
        })
      ).status,
    ).toBe(401);
    expect(
      (await browser(t.app).call('GET', '/api/clients', undefined, { cookie: 'atlas_session=' + 'a'.repeat(43) }))
        .status,
    ).toBe(401);
    expect((await b.call('GET', '/api/vault/unknown')).status).toBe(404);
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await t.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });
});
