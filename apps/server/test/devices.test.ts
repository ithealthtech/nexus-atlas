import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base64url, signRequest } from '../../extension/src/protocol.js';
import { totp } from '../src/identity/totp.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const SECRET = 'Tr0ub4dor&3-Harbor-Portal!';
const TOTP_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
// Requests from the extension's service worker carry its own origin.
const EXTENSION = { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'sec-fetch-site': 'none' };

/** The extension's side: a non-extractable P-256 key, signing each request as the extension does. */
async function newDevice(app: FastifyInstance) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = base64url(await crypto.subtle.exportKey('spki', pair.publicKey));
  const device = {
    pair,
    publicKey,
    token: '',
    async headers(method: string, url: string, text: string, options: { key?: CryptoKey; now?: number } = {}) {
      return {
        ...EXTENSION,
        ...(text ? { 'content-type': 'application/json' } : {}),
        ...(device.token ? { authorization: `AtlasDevice ${device.token}` } : {}),
        ...(await signRequest(options.key ?? pair.privateKey, {
          method,
          path: url,
          body: text,
          now: options.now ?? Date.now(),
        })),
      };
    },
    async send(method: 'GET' | 'POST' | 'DELETE', url: string, text: string, headers: Record<string, string>) {
      const r = await app.inject({ method, url, headers, ...(text ? { payload: text } : {}) });
      return { status: r.statusCode, data: r.body ? JSON.parse(r.body) : null };
    },
    async call(
      method: 'GET' | 'POST' | 'DELETE',
      url: string,
      body?: unknown,
      options: { key?: CryptoKey; now?: number; unsigned?: boolean } = {},
    ) {
      const text = body === undefined ? '' : JSON.stringify(body);
      const headers = options.unsigned
        ? { ...EXTENSION, ...(text ? { 'content-type': 'application/json' } : {}) }
        : await device.headers(method, url, text, options);
      return device.send(method, url, text, headers);
    },
  };
  return device;
}
type Device = Awaited<ReturnType<typeof newDevice>>;

async function requestSignIn(device: Device, name = 'Microsoft Edge on Windows') {
  const r = await device.call(
    'POST',
    '/api/device/pair',
    { kind: 'browser_extension', name, publicKey: device.publicKey },
    { unsigned: true },
  );
  expect(r.status, JSON.stringify(r.data)).toBe(201);
  return r.data as { id: string; code: string; expiresAt: string };
}

/** The whole sign-in: the device asks, the person approves in Atlas, the device collects its session. */
async function connect(app: FastifyInstance, person: Browser, name?: string) {
  const device = await newDevice(app);
  const pairing = await requestSignIn(device, name);
  const approved = await person.call('POST', `/api/account/apps/pairing/${pairing.code}/approve`, {});
  expect(approved.status, JSON.stringify(approved.data)).toBe(200);
  const collected = await device.call('POST', `/api/device/pair/${pairing.id}/session`, {});
  expect(collected.status, JSON.stringify(collected.data)).toBe(200);
  device.token = collected.data.token;
  return device;
}

describe('browser extension sign-in and autofill', () => {
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
    return { b, id: created.data.id as string };
  }
  const login = async (client: string, name: string, url: string, body: Record<string, unknown> = {}) => {
    const r = await owner.call('POST', `/api/clients/${client}/passwords`, {
      name,
      username: `${name.toLowerCase().replace(/\W+/g, '.')}@harbor.example`,
      url,
      secret: SECRET,
      ...body,
    });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data.id as string;
  };
  const names = (list: { name: string }[]) => list.map((l) => l.name);

  it('signs a browser in only after the person approves it, bound to the key it asked with', async () => {
    const device = await newDevice(t.app);
    const pairing = await requestSignIn(device);
    expect(pairing.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);

    // Waiting: the device hears "pending" until someone approves.
    const waiting = await device.call('POST', `/api/device/pair/${pairing.id}/session`, {});
    expect(waiting).toMatchObject({ status: 202, data: { status: 'pending' } });

    // The approval page shows what asked, so the person can check the code.
    const shown = await owner.call('GET', `/api/account/apps/pairing/${pairing.code.toLowerCase()}`);
    expect(shown.data).toMatchObject({
      code: pairing.code,
      kind: 'browser_extension',
      name: 'Microsoft Edge on Windows',
    });
    expect((await owner.call('POST', `/api/account/apps/pairing/${pairing.code}/approve`, {})).status).toBe(200);
    expect((await owner.call('POST', `/api/account/apps/pairing/${pairing.code}/approve`, {})).status).toBe(404);

    // Only the key the request was made with can collect the session, and only once.
    const stranger = await newDevice(t.app);
    const stolen = await device.call(
      'POST',
      `/api/device/pair/${pairing.id}/session`,
      {},
      { key: stranger.pair.privateKey },
    );
    expect(stolen.status).toBe(401);
    const collected = await device.call('POST', `/api/device/pair/${pairing.id}/session`, {});
    expect(collected.status).toBe(200);
    expect(collected.data.session).toMatchObject({
      user: { email: 'owner@atlas.test' },
      device: { name: 'Microsoft Edge on Windows' },
    });
    expect((await device.call('POST', `/api/device/pair/${pairing.id}/session`, {})).status).toBe(404);
    device.token = collected.data.token;
    expect(device.token).toMatch(/^atlasd_/);

    // Only a hash of the token is stored.
    const stored = JSON.stringify((await t.handle.pool.query('select * from device_sessions')).rows);
    expect(stored).not.toContain(device.token);

    expect((await device.call('GET', '/api/device/session')).data).toMatchObject({
      organization: { name: 'IT Done Right' },
      device: { name: 'Microsoft Edge on Windows' },
    });
    const events = (await owner.call('GET', '/api/security-events')).data.map(
      (e: { action: string; detail: string }) => `${e.action}: ${e.detail}`,
    );
    expect(events).toContain('Signed in: Browser extension: Microsoft Edge on Windows');
    expect(events.some((e: string) => e.startsWith('Device sign-in approved: Browser extension'))).toBe(true);
  });

  it('refuses a device token without its key, a replayed request, and a stale one', async () => {
    const device = await connect(t.app, owner);
    const url = '/api/device/session';

    // The token alone, or signed by another key, gets nothing.
    expect((await device.call('GET', url, undefined, { unsigned: true })).status).toBe(401);
    const other = await newDevice(t.app);
    const forged = await device.call('GET', url, undefined, { key: other.pair.privateKey });
    expect(forged).toMatchObject({ status: 401, data: { code: 'device_signature' } });

    // A signature covers the path and body: moving it to another request fails.
    const headers = await device.headers('GET', url, '');
    expect((await device.send('GET', '/api/device/logins?url=https://x.example', '', headers)).status).toBe(401);
    // Each request works once.
    expect((await device.send('GET', url, '', headers)).status).toBe(200);
    expect((await device.send('GET', url, '', headers)).status).toBe(401);

    const stale = await device.call('GET', url, undefined, { now: Date.now() - 10 * 60_000 });
    expect(stale).toMatchObject({ status: 401, data: { code: 'device_clock' } });

    // A browser session can't use the device routes, and a device token can't use the app's.
    expect((await owner.call('GET', url)).status).toBe(401);
    const web = await t.app.inject({
      method: 'GET',
      url: '/api/passwords',
      headers: { authorization: `AtlasDevice ${device.token}` },
    });
    expect(web.statusCode).toBe(401);
    // Nor do the device routes open up under the API key prefix.
    expect((await device.call('GET', '/api/v1/device/session')).status).toBe(404);
  });

  it('suggests logins by host and registrable domain, only from what the person may use', async () => {
    const portal = await login(harbor, 'Harbor portal', 'https://portal.harbor-dental.com/login');
    const sso = await login(harbor, 'Harbor SSO', 'https://login.harbor-dental.com');
    await login(harbor, 'Harbor firewall', 'http://10.20.0.1');
    await login(harbor, 'Harbor docs site', 'https://harbordental.github.io');
    const other = await login(northline, 'Northline portal account', 'https://portal.harbor-dental.com');
    const restricted = await login(harbor, 'Harbor portal admin', 'https://portal.harbor-dental.com/admin');
    await owner.call('PATCH', `/api/passwords/${restricted}`, { version: 1, restricted: true });
    // Changing other details (here, in bulk) keeps the address.
    await owner.call('POST', '/api/passwords/bulk', { ids: [restricted], action: 'rotation', rotationDays: 90 });
    expect((await owner.call('GET', `/api/passwords/${restricted}`)).data).toMatchObject({
      restricted: true,
      rotationDays: 90,
      url: 'https://portal.harbor-dental.com/admin',
    });
    const archived = await login(harbor, 'Old portal', 'https://portal.harbor-dental.com');
    await owner.call('POST', `/api/passwords/${archived}/archive`, { archived: true });
    await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      kind: 'bitlocker',
      name: 'portal.harbor-dental.com disk',
      url: 'https://portal.harbor-dental.com',
      secret: '123456-234567-345678-456789-567890-678901-789012-890123',
    });

    const tech = await person('tech@atlas.test', 'orchid lantern 8841', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
    });
    const device = await connect(t.app, tech.b);
    const matches = async (page: string, d: Device = device) =>
      (await d.call('GET', `/api/device/logins?url=${encodeURIComponent(page)}`)).data as {
        id: string;
        name: string;
        match: string;
        clientName: string;
      }[];

    // Same host first, then the rest of the domain. Other clients, restricted, archived, and BitLocker keys stay out.
    const found = await matches('https://portal.harbor-dental.com/signin?next=/');
    expect(found.map((m) => [m.name, m.match])).toEqual([
      ['Harbor portal', 'exact'],
      ['Harbor SSO', 'domain'],
    ]);
    expect(found[0]).toMatchObject({ id: portal, clientName: 'Harbor Dental Group', hasTotp: false });
    expect(JSON.stringify(found)).not.toContain(SECRET);
    expect(names(await matches('https://login.harbor-dental.com/'))).toEqual(['Harbor SSO', 'Harbor portal']);
    expect((await matches('https://login.harbor-dental.com/'))[0]!.id).toBe(sso);

    // An administrator sees the restricted one and the other client's too.
    const ownerDevice = await connect(t.app, owner);
    expect(names(await matches('https://portal.harbor-dental.com/', ownerDevice))).toEqual([
      'Harbor portal',
      'Harbor portal admin',
      'Northline portal account',
      'Harbor SSO',
    ]);
    expect((await matches('https://portal.harbor-dental.com/', ownerDevice)).map((m) => m.id)).toContain(other);

    // An https login is never offered to a plain-http page; IP addresses match only themselves.
    expect(await matches('http://portal.harbor-dental.com/')).toEqual([]);
    expect(names(await matches('http://10.20.0.1:8443/'))).toEqual(['Harbor firewall']);
    expect(await matches('http://10.20.0.10/')).toEqual([]);
    // Sites under a shared host (github.io) are separate domains.
    expect(await matches('https://attacker.github.io/')).toEqual([]);
    expect(names(await matches('https://harbordental.github.io/wiki'))).toEqual(['Harbor docs site']);
    expect(await matches('chrome://settings')).toEqual([]);

    // Quick search covers names, usernames, addresses, and clients, within the same limits.
    const search = async (q: string) =>
      names((await device.call('GET', `/api/device/logins/search?q=${encodeURIComponent(q)}`)).data);
    expect(await search('portal')).toEqual(['Harbor portal']);
    expect(await search('Harbor Dental')).toEqual([
      'Harbor docs site',
      'Harbor firewall',
      'Harbor portal',
      'Harbor SSO',
    ]);
    expect(await search('Northline')).toEqual([]);
    expect(await search('%')).toEqual([]);
  });

  it('fills and copies with the same access, reason, and audit rules as revealing', async () => {
    const portal = await login(harbor, 'Harbor portal', 'https://portal.harbor-dental.com', { totp: TOTP_SEED });
    const other = await login(northline, 'Northline portal', 'https://portal.northline.example');
    const device = await connect(t.app, owner);

    // The login's address must match the page it's filled into.
    const mismatch = await device.call('POST', `/api/device/logins/${portal}/fill`, {
      url: 'https://portal.northline.example/',
    });
    expect(mismatch).toMatchObject({ status: 400, data: { code: 'site_mismatch' } });

    const filled = await device.call('POST', `/api/device/logins/${portal}/fill`, {
      url: 'https://portal.harbor-dental.com/login',
    });
    expect(filled.data).toEqual({ username: 'harbor.portal@harbor.example', password: SECRET });

    const copied = await device.call('POST', `/api/device/logins/${portal}/copy`, { field: 'secret' });
    expect(copied.data.value).toBe(SECRET);
    const code = await device.call('POST', `/api/device/logins/${portal}/copy`, { field: 'totp' });
    const step = Math.floor(Date.now() / 30000);
    expect([totp(TOTP_SEED, step), totp(TOTP_SEED, step - 1)]).toContain(code.data.value);

    // Clients that require a reason ask for one from the extension too.
    await owner.call('PATCH', `/api/clients/${harbor}`, { requireRevealReason: true });
    const listed = (await device.call('GET', `/api/device/logins?url=https://portal.harbor-dental.com`)).data;
    expect(listed[0]).toMatchObject({ requireReason: true, hasTotp: true });
    const noReason = await device.call('POST', `/api/device/logins/${portal}/fill`, {
      url: 'https://portal.harbor-dental.com/login',
    });
    expect(noReason).toMatchObject({ status: 400, data: { code: 'reason_required' } });
    expect(
      (
        await device.call('POST', `/api/device/logins/${portal}/copy`, {
          field: 'secret',
          reason: '',
        })
      ).data.code,
    ).toBe('reason_required');
    expect(
      (
        await device.call('POST', `/api/device/logins/${portal}/fill`, {
          url: 'https://portal.harbor-dental.com/login',
          reason: 'Ticket 4411: reset the front desk printer',
        })
      ).status,
    ).toBe(200);

    const audit = (await owner.call('GET', `/api/passwords/${portal}/audit`)).data as {
      action: string;
      actorName: string;
      reason: string;
    }[];
    expect(audit.map((a) => a.action)).toEqual([
      'Filled password on portal.harbor-dental.com',
      'Copied one-time code',
      'Copied password',
      'Filled password on portal.harbor-dental.com',
      'Created',
    ]);
    expect(audit[0]).toMatchObject({
      actorName: 'Avery Owner (Browser extension: Microsoft Edge on Windows)',
      reason: 'Ticket 4411: reset the front desk printer',
    });
    // Filling counts as using the password.
    expect((await owner.call('GET', `/api/passwords/${portal}`)).data.lastUsedAt).not.toBeNull();

    // Someone without access to the client gets "not found", as in the app.
    const tech = await person('tech@atlas.test', 'orchid lantern 8841', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    const techDevice = await connect(t.app, tech.b);
    for (const id of [portal, other]) {
      expect(
        (await techDevice.call('POST', `/api/device/logins/${id}/fill`, { url: 'https://portal.harbor-dental.com' }))
          .status,
      ).toBe(404);
      expect((await techDevice.call('POST', `/api/device/logins/${id}/copy`, { field: 'secret' })).status).toBe(404);
    }
    expect((await techDevice.call('GET', '/api/device/logins?url=https://portal.harbor-dental.com')).data).toEqual([]);
  });

  it('signs devices out from the account page, and whenever the person is signed out everywhere', async () => {
    const tech = await person('tech@atlas.test', 'orchid lantern 8841', {
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
    });
    const ended = async (d: Device) => (await d.call('GET', '/api/device/session')).data?.code === 'device_session';

    // From the account page.
    const first = await connect(t.app, tech.b);
    const apps = (await tech.b.call('GET', '/api/account/security')).data.apps;
    expect(apps).toMatchObject([{ kind: 'browser_extension', name: 'Microsoft Edge on Windows' }]);
    expect((await owner.call('DELETE', `/api/account/apps/${apps[0].id}`)).status).toBe(404);
    expect((await tech.b.call('DELETE', `/api/account/apps/${apps[0].id}`)).status).toBe(200);
    expect(await ended(first)).toBe(true);

    // From the device itself.
    const second = await connect(t.app, tech.b);
    expect((await second.call('DELETE', '/api/device/session')).status).toBe(200);
    expect(await ended(second)).toBe(true);

    // An administrator signing the person out everywhere.
    const third = await connect(t.app, tech.b);
    expect((await owner.call('POST', `/api/users/${tech.id}/sign-out`, {})).status).toBe(200);
    expect(await ended(third)).toBe(true);

    // A browser session that hasn't finished its second step can't approve anything.
    const halfway = (await signIn(t.app, 'tech@atlas.test', 'orchid lantern 8841')).b;
    const pairing = await requestSignIn(await newDevice(t.app));
    expect((await halfway.call('POST', `/api/account/apps/pairing/${pairing.code}/approve`, {})).status).toBe(403);

    // Disabling the account.
    const fifth = await connect(t.app, owner, 'Owner laptop');
    const tech2 = await person('tech2@atlas.test', 'copper meadow 5520', {
      role: 'technician',
      grants: [{ clientId: northline, level: 'edit_passwords' }],
    });
    const sixth = await connect(t.app, tech2.b);
    expect((await owner.call('PATCH', `/api/users/${tech2.id}`, { disabled: true })).status).toBe(200);
    expect(await ended(sixth)).toBe(true);
    expect(await ended(fifth)).toBe(false);

    // Changing the password.
    const seventh = await connect(t.app, owner, 'Owner desktop');
    expect(
      (
        await owner.call('POST', '/api/account/password', {
          current: 'correct horse battery 1',
          next: 'silver canyon trail 77',
        })
      ).status,
    ).toBe(200);
    expect(await ended(seventh)).toBe(true);
    expect(await ended(fifth)).toBe(true);
  });

  it('keeps client accounts out, and checks what a device sends', async () => {
    const viewer = await person(
      'viewer@harbor.example',
      'client viewer pass 1',
      { role: 'client_viewer', grants: [{ clientId: harbor, level: 'read' }] },
      false,
    );
    const device = await newDevice(t.app);
    const pairing = await requestSignIn(device);
    expect((await viewer.b.call('GET', `/api/account/apps/pairing/${pairing.code}`)).status).toBe(403);
    expect((await viewer.b.call('POST', `/api/account/apps/pairing/${pairing.code}/approve`, {})).status).toBe(403);

    // Refusing ends the request.
    expect((await owner.call('DELETE', `/api/account/apps/pairing/${pairing.code}`)).status).toBe(200);
    expect((await device.call('POST', `/api/device/pair/${pairing.id}/session`, {})).status).toBe(404);
    expect((await owner.call('GET', `/api/account/apps/pairing/${pairing.code}`)).status).toBe(404);
    expect((await owner.call('GET', '/api/account/apps/pairing/not-a-code')).status).toBe(404);

    // Only P-256 public keys are accepted.
    const rsa = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign'],
    );
    const rsaKey = base64url(await crypto.subtle.exportKey('spki', rsa.publicKey));
    for (const publicKey of [rsaKey, 'A'.repeat(122)]) {
      const r = await device.call(
        'POST',
        '/api/device/pair',
        { kind: 'browser_extension', name: 'Edge', publicKey },
        { unsigned: true },
      );
      expect(r.status).toBe(400);
    }
  });
});
