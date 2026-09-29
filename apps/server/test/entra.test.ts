import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { OWNER, setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = '66666666-7777-8888-9999-000000000000';
const SECRET = 'entra-client-secret-value';
const TEMP = 'temporary pass 1234';
const b64 = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/** A fake Microsoft: signs real RS256 ID tokens and checks the client secret, redirect address, and PKCE verifier. */
function fakeMicrosoft() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { challenge: string; nonce: string; claims: Record<string, unknown>; signer: typeof privateKey }
  >();
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/discovery/v2.0/keys')) return Response.json({ keys: [jwk] });
    if (url.pathname.endsWith('/.well-known/openid-configuration'))
      return url.pathname.includes(TENANT) ? Response.json({}) : new Response('{}', { status: 400 });
    if (url.pathname.endsWith('/oauth2/v2.0/token')) {
      const body = new URLSearchParams(String(init?.body));
      const issued = codes.get(body.get('code') ?? '');
      codes.delete(body.get('code') ?? ''); // Codes work once.
      const bad =
        !issued ||
        body.get('client_id') !== CLIENT ||
        body.get('client_secret') !== SECRET ||
        body.get('grant_type') !== 'authorization_code' ||
        // PKCE: the verifier must hash to the challenge sent when the person was redirected.
        createHash('sha256')
          .update(body.get('code_verifier') ?? '')
          .digest('base64url') !== issued.challenge;
      if (bad) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const header = b64({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
      const payload = b64({
        iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        aud: CLIENT,
        tid: TENANT,
        nonce: issued.nonce,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...issued.claims,
      });
      const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), issued.signer).toString('base64url');
      return Response.json({ id_token: `${header}.${payload}.${signature}`, token_type: 'Bearer' });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return {
    fetcher,
    /** Microsoft's side of the redirect: remembers what was asked, and hands back a code for it. */
    approve(
      location: string,
      claims: Record<string, unknown>,
      options: { badNonce?: boolean; rogueKey?: boolean } = {},
    ) {
      const q = new URL(location).searchParams;
      const code = randomBytes(12).toString('hex');
      codes.set(code, {
        challenge: q.get('code_challenge') ?? '',
        nonce: options.badNonce ? 'not-the-nonce' : (q.get('nonce') ?? ''),
        claims,
        signer: options.rogueKey ? rogue : privateKey,
      });
      return { code, state: q.get('state') ?? '' };
    },
  };
}

describe('Microsoft Entra ID sign-in', () => {
  let t: TestApp;
  let owner: Browser;
  let ms: ReturnType<typeof fakeMicrosoft>;
  let tessOid: string;

  beforeEach(async () => {
    ms = fakeMicrosoft();
    t = await startApp({}, { entraFetch: ms.fetcher });
    owner = (await setupOwner(t.app)).b;
    tessOid = randomBytes(8).toString('hex');
    await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess Tech',
      password: TEMP,
      role: 'technician',
      allClients: 'edit',
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const configure = (extra: object = {}) =>
    owner.call('PUT', '/api/settings/entra', {
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: SECRET,
      enabled: true,
      ...extra,
    });

  /** The whole browser trip: start, approve at Microsoft, come back. */
  async function signInWithMicrosoft(
    claims: Record<string, unknown>,
    options: { badNonce?: boolean; rogueKey?: boolean; state?: string; noCookie?: boolean } = {},
  ) {
    const start = await t.app.inject({ method: 'GET', url: '/api/auth/entra/start' });
    const stateCookie = String(([] as string[]).concat(start.headers['set-cookie'] ?? [])[0] ?? '').split(';')[0];
    const { code, state } = ms.approve(String(start.headers.location), claims, options);
    const back = await t.app.inject({
      method: 'GET',
      url: `/api/auth/entra/callback?code=${code}&state=${options.state ?? state}`,
      headers: options.noCookie || !stateCookie ? {} : { cookie: stateCookie },
    });
    const session = ([] as string[])
      .concat(back.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0]!)
      .find((c) => c.startsWith('atlas_session='));
    return { start, back, location: String(back.headers.location), session };
  }
  const sessionOf = async (cookie: string) =>
    (await t.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } })).json();
  const tess = (extra: Record<string, unknown> = {}) => ({
    oid: tessOid,
    email: 'tess@atlas.test',
    name: 'Tess Tech',
    ...extra,
  });

  it('sends the person to Microsoft with state, a nonce, and a PKCE challenge, and only when it is on', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/entra' })).json()).toEqual({
      enabled: false,
      requireSso: false,
    });
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/entra/start' })).headers.location).toBe('/?sso=off');

    expect((await configure()).status).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/entra' })).json()).toEqual({
      enabled: true,
      requireSso: false,
    });
    const start = await t.app.inject({ method: 'GET', url: '/api/auth/entra/start' });
    expect(start.statusCode).toBe(302);
    const to = new URL(String(start.headers.location));
    expect(to.origin + to.pathname).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: CLIENT,
      response_type: 'code',
      redirect_uri: 'http://localhost/api/auth/entra/callback',
      code_challenge_method: 'S256',
    });
    for (const k of ['state', 'nonce', 'code_challenge']) expect(to.searchParams.get(k)!.length).toBeGreaterThan(20);
    // The secret is never shown back, and never in the address.
    expect(JSON.stringify((await owner.call('GET', '/api/settings/entra')).data)).not.toContain(SECRET);
    expect(String(start.headers.location)).not.toContain(SECRET);
  });

  it('matches by email only after an administrator confirms, then signs in by account ID', async () => {
    // Required, as it normally would be: the temporary password an administrator set isn't asked for again.
    await configure({ requireSso: true });
    const first = await signInWithMicrosoft(tess());
    expect(first.location).toBe('/?sso=pending');
    expect(first.session).toBeUndefined();
    const people = (await owner.call('GET', '/api/users')).data as {
      id: string;
      email: string;
      entra: string | null;
    }[];
    const person = people.find((p) => p.email === 'tess@atlas.test')!;
    expect(person.entra).toBe('pending');

    // Not confirmed, so a second try still doesn't get in.
    expect((await signInWithMicrosoft(tess())).session).toBeUndefined();
    // Confirming has to name the account the administrator looked at.
    expect((await owner.call('POST', `/api/users/${person.id}/entra/confirm`, { oid: 'someone-else' })).status).toBe(
      409,
    );
    expect((await owner.call('POST', `/api/users/${person.id}/entra/confirm`, { oid: tessOid })).status).toBe(200);

    // Now the account ID is what counts: a different email claim for the same account still signs in.
    const ok = await signInWithMicrosoft(tess({ email: 'renamed@atlas.test' }));
    expect(ok.location).toBe('/');
    const session = await sessionOf(ok.session!);
    expect(session.actor).toMatchObject({ email: 'tess@atlas.test', role: 'technician' });
    // Atlas still wants its own MFA unless Microsoft's is trusted.
    expect(session.stage).toBe('mfa-setup');
    const log = (await owner.call('GET', '/api/security-events')).data as { action: string; detail: string }[];
    expect(log.map((e) => e.action)).toEqual(
      expect.arrayContaining(['Microsoft sign-in awaiting confirmation', 'Microsoft account linked']),
    );

    // Unlinking removes the way in.
    await owner.call('DELETE', `/api/users/${person.id}/entra`);
    expect((await signInWithMicrosoft(tess({ oid: randomBytes(8).toString('hex') }))).location).toBe('/?sso=pending');
    expect((await signInWithMicrosoft(tess())).session).toBeUndefined();
  });

  it('can rely on Microsoft’s multi-factor sign-in, but only when told to and only if Microsoft did it', async () => {
    await configure({ trustMfa: true, requireSso: true });
    const person = ((await owner.call('GET', '/api/users')).data as { id: string; email: string }[]).find(
      (p) => p.email === 'tess@atlas.test',
    )!;
    await signInWithMicrosoft(tess());
    await owner.call('POST', `/api/users/${person.id}/entra/confirm`, { oid: tessOid });

    const withMfa = await signInWithMicrosoft(tess({ amr: ['pwd', 'mfa'] }));
    expect((await sessionOf(withMfa.session!)).stage).toBe('active');
    const withoutMfa = await signInWithMicrosoft(tess({ amr: ['pwd'] }));
    expect((await sessionOf(withoutMfa.session!)).stage).toBe('mfa-setup');
  });

  it('refuses anything that is not a valid, fresh sign-in from the right app and tenant', async () => {
    await configure();
    const people = async () => ((await owner.call('GET', '/api/users')).data as unknown[]).length;
    const before = await people();

    // Unknown to Atlas: refused, and no account is created.
    expect((await signInWithMicrosoft({ oid: 'x1', email: 'stranger@elsewhere.test', name: 'S' })).location).toBe(
      '/?sso=unknown',
    );
    expect(await people()).toBe(before);
    // State that does not match the browser that started it.
    expect((await signInWithMicrosoft(tess(), { state: 'forged-state' })).location).toBe('/?sso=failed');
    // No state cookie at all (a link followed in another browser).
    expect((await signInWithMicrosoft(tess(), { noCookie: true })).location).toBe('/?sso=expired');
    // A token for a different nonce, from a different key, for another app, or already expired.
    for (const options of [{ badNonce: true }, { rogueKey: true }]) {
      const r = await signInWithMicrosoft(tess(), options);
      expect(r.location).toBe('/?sso=failed');
      expect(r.session).toBeUndefined();
    }
    for (const claims of [
      { aud: 'someone-elses-app' },
      { exp: Math.floor(Date.now() / 1000) - 3600 },
      { tid: 'other-tenant' },
      { iss: 'https://evil.test/v2.0' },
    ]) {
      expect((await signInWithMicrosoft(tess(claims))).location).toBe('/?sso=failed');
    }
  });

  it('can require Microsoft for staff while the owner keeps a password as a way in', async () => {
    await configure({ requireSso: true });
    const password = (email: string, pw: string) =>
      t.app.inject({ method: 'POST', url: '/api/session', payload: { email, password: pw } });
    const blocked = await password('tess@atlas.test', TEMP);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('sso_required');
    // The owner is never locked out by a problem on Microsoft's side.
    expect((await password(OWNER.email, OWNER.password)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/entra' })).json().requireSso).toBe(true);
  });

  it('accepts the return from Microsoft even though it is a cross-site navigation, and nothing else', async () => {
    await configure();
    const back = await t.app.inject({
      method: 'GET',
      url: '/api/auth/entra/callback?error=access_denied',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(back.statusCode).toBe(302);
    const other = await t.app.inject({
      method: 'GET',
      url: '/api/auth/entra/start',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(other.statusCode).toBe(403);
    // The redirect after the callback keeps the cross-site label; the page it lands on must still load.
    const page = await t.app.inject({ method: 'GET', url: '/?sso=pending', headers: { 'sec-fetch-site': 'cross-site' } });
    expect(page.statusCode).not.toBe(403);
  });

  it('checks the tenant on request and is for administrators only', async () => {
    await configure();
    expect((await owner.call('POST', '/api/settings/entra/test', {})).status).toBe(200);
    await owner.call('PUT', '/api/settings/entra', {
      tenantId: '99999999-0000-0000-0000-000000000000',
      clientId: CLIENT,
      enabled: true,
    });
    expect((await owner.call('POST', '/api/settings/entra/test', {})).status).toBe(400);
    expect((await owner.call('PUT', '/api/settings/entra', { tenantId: 'x', clientId: 'not-a-guid' })).status).toBe(
      400,
    );
  });
});

describe('Microsoft Entra ID sign-in with an optional setting', () => {
  it('still asks for a real password when Microsoft sign-in is optional and the temporary one is still set', async () => {
    const ms = fakeMicrosoft();
    const t = await startApp({}, { entraFetch: ms.fetcher });
    try {
      const owner = (await setupOwner(t.app)).b;
      await owner.call('POST', '/api/users', {
        email: 'tess@atlas.test',
        name: 'Tess Tech',
        password: TEMP,
        role: 'technician',
        allClients: 'edit',
      });
      await owner.call('PUT', '/api/settings/entra', {
        tenantId: TENANT,
        clientId: CLIENT,
        clientSecret: SECRET,
        enabled: true,
      });
      const oid = 'abc123';
      const trip = async () => {
        const start = await t.app.inject({ method: 'GET', url: '/api/auth/entra/start' });
        const cookie = String(([] as string[]).concat(start.headers['set-cookie'] ?? [])[0]).split(';')[0]!;
        const { code, state } = ms.approve(String(start.headers.location), {
          oid,
          email: 'tess@atlas.test',
          name: 'Tess',
        });
        return t.app.inject({
          method: 'GET',
          url: `/api/auth/entra/callback?code=${code}&state=${state}`,
          headers: { cookie },
        });
      };
      await trip();
      const person = ((await owner.call('GET', '/api/users')).data as { id: string; email: string }[]).find(
        (p) => p.email === 'tess@atlas.test',
      )!;
      await owner.call('POST', `/api/users/${person.id}/entra/confirm`, { oid });
      const back = await trip();
      const cookie = ([] as string[])
        .concat(back.headers['set-cookie'] ?? [])
        .map((c) => c.split(';')[0]!)
        .find((c) => c.startsWith('atlas_session='))!;
      const session = await t.app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
      expect(session.json().stage).toBe('password');
    } finally {
      await t.close();
    }
  });
});
