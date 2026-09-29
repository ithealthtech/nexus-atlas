import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const REDIRECT = 'http://127.0.0.1:53123/callback';

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

describe('Atlas for Windows sign-in (native apps)', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let coastal: string;
  let router: string;
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    coastal = (await owner.call('POST', '/api/clients', { name: 'Coastal Realty' })).data.id;
    router = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, {
        name: 'Harbor router',
        username: 'admin',
        secret: 'R0uter!pass-2026',
      })
    ).data.id;
    await owner.call('POST', `/api/clients/${coastal}/passwords`, { name: 'Coastal router', secret: 'C0astal!pass' });
  });
  afterEach(async () => {
    await t.close();
  });

  const request = (challenge: string, extra: Record<string, unknown> = {}) => ({
    client_id: 'atlas-windows',
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'state-0123456789abcdef',
    scope: 'read reveal',
    device_name: 'TECH-LAPTOP-07',
    ...extra,
  });
  const v1 = (method: 'GET' | 'POST' | 'DELETE', url: string, token?: string, body?: unknown) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body ? { payload: body as object } : {}),
    });
  const exchange = (body: Record<string, unknown>) =>
    t.app.inject({ method: 'POST', url: '/api/v1/native/token', payload: body });

  /** Runs the whole flow as a browser and an app would, returning the app token. */
  async function signInApp(b: Browser, extra: Record<string, unknown> = {}) {
    const { verifier, challenge } = pkce();
    const approved = await b.call('POST', '/api/native/authorize', { ...request(challenge, extra), approve: true });
    expect(approved.status).toBe(200);
    const back = new URL(approved.data.redirect);
    const token = await exchange({
      grant_type: 'authorization_code',
      client_id: 'atlas-windows',
      code: back.searchParams.get('code'),
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(token.statusCode).toBe(200);
    return token.json().access_token as string;
  }

  it('signs in through the browser with PKCE and a loopback redirect', async () => {
    const { verifier, challenge } = pkce();
    const approved = await owner.call('POST', '/api/native/authorize', { ...request(challenge), approve: true });
    expect(approved.status).toBe(200);
    const back = new URL(approved.data.redirect);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('state-0123456789abcdef');
    const code = back.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only a hash of the code is stored.
    const stored = await t.handle.db.execute(sql`select code_hash from native_auth_codes`);
    expect(JSON.stringify(stored.rows)).not.toContain(code);

    const body = { grant_type: 'authorization_code', client_id: 'atlas-windows', code, redirect_uri: REDIRECT };
    const token = await exchange({ ...body, code_verifier: verifier });
    expect(token.statusCode).toBe(200);
    const granted = token.json();
    expect(granted.access_token).toMatch(/^atlasd_[A-Za-z0-9_-]{43}$/);
    expect(granted.token_type).toBe('Bearer');
    expect(granted.scope).toBe('read reveal');
    expect(granted.user.email).toBe('owner@atlas.test');
    // The code works once.
    expect((await exchange({ ...body, code_verifier: verifier })).statusCode).toBe(400);
    const sessions = await t.handle.db.execute(sql`select token_hash from sessions where kind = 'app'`);
    expect(JSON.stringify(sessions.rows)).not.toContain(granted.access_token);

    const me = await v1('GET', '/native/session', granted.access_token);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ deviceName: 'TECH-LAPTOP-07', scopes: ['read', 'reveal'] });

    const events = (await owner.call('GET', '/api/security-events')).data.map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(['Desktop app approved', 'Desktop app signed in']));
  });

  it('refuses a wrong verifier, a different redirect, or an expired code, and burns the code', async () => {
    const attempt = async (override: Record<string, unknown>) => {
      const { verifier, challenge } = pkce();
      const approved = await owner.call('POST', '/api/native/authorize', { ...request(challenge), approve: true });
      const code = new URL(approved.data.redirect).searchParams.get('code')!;
      const base = { grant_type: 'authorization_code', client_id: 'atlas-windows', code, redirect_uri: REDIRECT };
      const bad = await exchange({ ...base, code_verifier: verifier, ...override });
      // Whatever was wrong, the code can't be used again, not even correctly.
      const retry = await exchange({ ...base, code_verifier: verifier });
      return [bad.statusCode, retry.statusCode, bad.json().code];
    };
    expect(await attempt({ code_verifier: pkce().verifier })).toEqual([400, 400, 'invalid_grant']);
    expect(await attempt({ redirect_uri: 'http://127.0.0.1:53124/callback' })).toEqual([400, 400, 'invalid_grant']);

    const { verifier, challenge } = pkce();
    const approved = await owner.call('POST', '/api/native/authorize', { ...request(challenge), approve: true });
    const code = new URL(approved.data.redirect).searchParams.get('code')!;
    await t.handle.db.execute(sql`update native_auth_codes set expires_at = now() - interval '1 second'`);
    const late = await exchange({
      grant_type: 'authorization_code',
      client_id: 'atlas-windows',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(late.statusCode).toBe(400);
    expect(await t.handle.db.execute(sql`select count(*)::int as n from sessions where kind = 'app'`)).toMatchObject({
      rows: [{ n: 0 }],
    });
  });

  it('only returns to a loopback address on this computer, with S256 PKCE', async () => {
    const { challenge } = pkce();
    const refuse = async (extra: Record<string, unknown>) =>
      (await owner.call('POST', '/api/native/authorize', { ...request(challenge, extra), approve: true })).status;
    for (const redirect_uri of [
      'http://localhost:53123/callback',
      'https://127.0.0.1:53123/callback',
      'http://127.0.0.1/callback',
      'http://127.0.0.1:80/callback',
      'http://127.0.0.1:53123/callback?next=1',
      'http://user@127.0.0.1:53123/callback',
      'http://evil.example:53123/callback',
      'myapp://callback',
    ])
      expect(await refuse({ redirect_uri }), redirect_uri).toBe(400);
    expect(await refuse({ redirect_uri: 'http://[::1]:53123/callback' })).toBe(200);
    expect(await refuse({ code_challenge_method: 'plain' })).toBe(400);
    expect(await refuse({ code_challenge: 'short' })).toBe(400);
    expect(await refuse({ client_id: 'someone-else' })).toBe(400);
    expect(await refuse({ scope: 'reveal' })).toBe(400);
    expect(await refuse({ scope: 'read admin' })).toBe(400);
    expect(await refuse({ state: '' })).toBe(400);
    // Refusing never issues a code, and still returns the state so the app can tell it apart from an attack.
    const denied = await owner.call('POST', '/api/native/authorize', { ...request(challenge), approve: false });
    const back = new URL(denied.data.redirect);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
    expect(back.searchParams.get('state')).toBe('state-0123456789abcdef');
  });

  it('needs a recent sign-in, a staff account, and a browser session', async () => {
    const { challenge } = pkce();
    await t.handle.db.execute(sql`update sessions set reauth_at = now() - interval '1 hour'`);
    const stale = await owner.call('POST', '/api/native/authorize', { ...request(challenge), approve: true });
    expect([stale.status, stale.data.code]).toEqual([403, 'reauth']);
    await t.handle.db.execute(sql`update sessions set reauth_at = now()`);

    await owner.call('POST', '/api/users', {
      email: 'viewer@client.test',
      name: 'Casey Client',
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
      password: TEMP,
    });
    const { b } = await signIn(t.app, 'viewer@client.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'a better pass 5678' });
    const client = await b.call('POST', '/api/native/authorize', { ...request(challenge), approve: true });
    expect([client.status, client.data.code]).toEqual([403, 'native_staff']);

    // An API key can't approve an app for its creator.
    const key = (await owner.call('POST', '/api/api-keys', { name: 'Sync', scopes: ['read', 'write'] })).data.token;
    expect((await v1('POST', '/native/authorize', key, { ...request(challenge), approve: true })).statusCode).toBe(403);
  });

  it('keeps the app inside its scopes and the person’s own access', async () => {
    await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tess Tech',
      role: 'technician',
      allClients: 'none',
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
      password: TEMP,
    });
    const { b } = await signIn(t.app, 'tech@atlas.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'a better pass 5678' });
    await enroll(b);
    const token = await signInApp(b);

    // Quick search sees only the technician's clients, including password entries (never secrets).
    const found = await v1('GET', '/search?q=router&limit=5', token);
    expect(found.statusCode).toBe(200);
    expect(found.json().map((r: { title: string }) => r.title)).toEqual(['Harbor router']);
    expect(found.body).not.toContain('R0uter!pass-2026');
    expect((await v1('GET', `/clients/${coastal}`, token)).statusCode).toBe(404);

    // Copying is a reveal, recorded with the app and computer named.
    const copy = await v1('POST', `/passwords/${router}/reveal`, token, { copy: true });
    expect(copy.json().value).toBe('R0uter!pass-2026');
    const audit = (await owner.call('GET', `/api/passwords/${router}/audit`)).data;
    expect(audit[0]).toMatchObject({ action: 'Copied password' });
    expect(audit[0].actorName).toContain('Atlas for Windows on TECH-LAPTOP-07');

    // No "write" scope: no changes. Nothing outside documentation and the vault.
    expect((await v1('POST', `/clients/${harbor}/passwords`, token, { name: 'X', secret: 'y' })).statusCode).toBe(403);
    expect((await v1('GET', '/users', token)).statusCode).toBe(403);
    expect((await v1('GET', '/api-keys', token)).statusCode).toBe(403);
    expect((await v1('GET', '/account/security', token)).statusCode).toBe(403);

    // Read-only: no reveals.
    const readOnly = await signInApp(b, { scope: 'read' });
    const refused = await v1('POST', `/passwords/${router}/reveal`, readOnly, {});
    expect([refused.statusCode, refused.json().code]).toEqual([403, 'api_scope']);
    expect((await v1('GET', `/passwords?client=${harbor}`, readOnly)).statusCode).toBe(200);
  });

  it('is never a browser session, and only works through the versioned API', async () => {
    const token = await signInApp(owner);
    const asCookie = await t.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie: `atlas_session=${token}` },
    });
    expect(asCookie.statusCode).toBe(401);
    const unversioned = await t.app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unversioned.statusCode).toBe(401);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect((await v1('GET', '/clients', tampered)).statusCode).toBe(401);
    // The app session's own endpoint is for apps only.
    expect((await owner.call('GET', '/api/native/session')).status).toBe(404);
  });

  it('is listed on the Account page and ends with every kind of sign-out', async () => {
    const token = await signInApp(owner);
    const overview = (await owner.call('GET', '/api/account/security')).data;
    expect(overview.apps).toEqual([
      expect.objectContaining({
        client: 'Atlas for Windows',
        deviceName: 'TECH-LAPTOP-07',
        scopes: ['read', 'reveal'],
      }),
    ]);
    expect(overview.sessions).toHaveLength(1);

    // Removing it from the Account page.
    expect((await owner.call('DELETE', `/api/account/sessions/${overview.apps[0].id}`)).status).toBe(200);
    expect((await v1('GET', '/clients', token)).statusCode).toBe(401);

    // Signing out everywhere else.
    const second = await signInApp(owner);
    expect((await v1('GET', '/clients', second)).statusCode).toBe(200);
    await owner.call('POST', '/api/account/sessions/end-others', {});
    expect((await v1('GET', '/clients', second)).statusCode).toBe(401);

    // The app signing itself out.
    const third = await signInApp(owner);
    expect((await v1('DELETE', '/native/session', third)).statusCode).toBe(200);
    expect((await v1('GET', '/clients', third)).statusCode).toBe(401);

    const events = (await owner.call('GET', '/api/security-events')).data.map((e: { action: string }) => e.action);
    expect(events).toEqual(expect.arrayContaining(['Desktop app signed out remotely', 'Desktop app signed out']));
  });

  it('ends when an administrator signs the person out, resets them, or disables them', async () => {
    await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tess Tech',
      role: 'technician',
      allClients: 'edit_passwords',
      password: TEMP,
    });
    const tech = (await owner.call('GET', '/api/users')).data.find(
      (u: { email: string }) => u.email === 'tech@atlas.test',
    );
    const { b } = await signIn(t.app, 'tech@atlas.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'a better pass 5678' });
    await enroll(b);

    const first = await signInApp(b);
    expect((await owner.call('POST', `/api/users/${tech.id}/sign-out`, {})).status).toBe(200);
    expect((await v1('GET', '/clients', first)).statusCode).toBe(401);

    const again = (await signIn(t.app, 'tech@atlas.test', 'a better pass 5678')).b;
    // Straight to a session that has finished MFA, the way a remembered browser would.
    await t.handle.db.execute(sql`update sessions set mfa_verified = true where kind = 'browser'`);
    const second = await signInApp(again);
    expect((await owner.call('PATCH', `/api/users/${tech.id}`, { disabled: true })).status).toBe(200);
    expect((await v1('GET', '/clients', second)).statusCode).toBe(401);
  });

  it('outlives the browser session that approved it, within its own limits', async () => {
    const token = await signInApp(owner);
    // The browser session goes idle and a new sign-in clears idle browser sessions; the app keeps working.
    await t.handle.db.execute(sql`update sessions set last_seen_at = now() - interval '3 hours'`);
    await signIn(t.app, 'owner@atlas.test', 'correct horse battery 1');
    expect((await v1('GET', '/clients', token)).statusCode).toBe(200);
    // After 30 days unused, it ends.
    await t.handle.db.execute(sql`update sessions set last_seen_at = now() - interval '31 days' where kind = 'app'`);
    expect((await v1('GET', '/clients', token)).statusCode).toBe(401);
    const left = await t.handle.db.execute(sql`select count(*)::int as n from sessions where kind = 'app'`);
    expect(left.rows[0]).toMatchObject({ n: 0 });
  });
});
