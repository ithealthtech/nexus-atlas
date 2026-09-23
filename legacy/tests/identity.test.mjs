import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { openIdentity, hashPassword, verifyPassword, totp, totpStep } from '../server/identity.mjs';
import { createApp } from '../server/app.mjs';

const SETUP = 'test-setup-code';
const ADMIN = { email: 'admin@atlas.test', name: 'Avery Admin', password: 'correct horse battery 1' };

async function start() {
  const store = openStore(); const identity = openIdentity(store);
  const server = createApp(store, identity, { setupCode: SETUP });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { store, identity, base, stop: () => new Promise(resolve => server.close(() => { store.close(); resolve(); })) };
}
// A browser-like client: keeps its session cookie and CSRF token.
function browser(base) {
  const agent = { cookie: '', csrf: '', async call(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(agent.cookie && { Cookie: agent.cookie }), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...(method !== 'GET' && agent.csrf && { 'X-CSRF-Token': agent.csrf }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) agent.cookie = setCookie.split(';')[0];
    const data = await response.json().catch(() => null);
    if (data?.csrf) agent.csrf = data.csrf;
    return { status: response.status, data, headers: response.headers };
  } };
  return agent;
}
async function signIn(base, email, password) { const b = browser(base); const r = await b.call('/api/session', { method: 'POST', body: { email, password } }); return { b, r }; }
// Completes the required MFA enrollment and returns the secret, as an authenticator app would store it.
async function enroll(b) {
  const setup = await b.call('/api/account/mfa/setup', { method: 'POST', body: {} });
  assert.equal(setup.status, 200); assert.match(setup.data.uri, /^otpauth:\/\/totp\//);
  const done = await b.call('/api/account/mfa/confirm', { method: 'POST', body: { code: totp(setup.data.secret) } });
  assert.equal(done.status, 200); assert.equal(done.data.stage, 'active');
  return setup.data.secret;
}
async function setupAdmin(base) {
  const b = browser(base);
  const r = await b.call('/api/setup', { method: 'POST', body: { ...ADMIN, setupCode: SETUP } });
  assert.equal(r.status, 201); assert.equal(r.data.stage, 'mfa-setup');
  const secret = await enroll(b);
  return { b, secret };
}

test('passwords use salted scrypt and TOTP matches the RFC 6238 test vector', async () => {
  const a = await hashPassword('synthetic password 1'); const b = await hashPassword('synthetic password 1');
  assert.match(a, /^scrypt\$32768\$8\$1\$/); assert.notEqual(a, b);
  assert.ok(await verifyPassword('synthetic password 1', a)); assert.ok(!(await verifyPassword('synthetic password 2', a)));
  // RFC 6238 appendix B: secret "12345678901234567890", T=59s → 94287082 (last six digits for 6-digit codes).
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');
});

test('first-run setup requires the console code, runs once, and forces MFA enrollment', async () => {
  const app = await start();
  try {
    const b = browser(app.base);
    assert.deepEqual((await b.call('/api/setup')).data, { needed: true });
    assert.equal((await b.call('/api/setup', { method: 'POST', body: { ...ADMIN, setupCode: 'wrong' } })).status, 403);
    assert.equal((await b.call('/api/setup', { method: 'POST', body: { ...ADMIN, password: 'short', setupCode: SETUP } })).status, 400);
    const created = await b.call('/api/setup', { method: 'POST', body: { ...ADMIN, setupCode: SETUP } });
    assert.equal(created.status, 201); assert.equal(created.data.actor.role, 'admin');
    assert.match(created.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200/);
    assert.equal((await browser(app.base).call('/api/setup', { method: 'POST', body: { ...ADMIN, email: 'second@atlas.test', setupCode: SETUP } })).status, 409);
    assert.deepEqual((await b.call('/api/setup')).data, { needed: false });
    // Staff accounts cannot use the workspace until MFA is enrolled.
    assert.equal((await b.call('/api/clients')).status, 403);
    assert.equal((await b.call('/api/account/mfa/confirm', { method: 'POST', body: { code: '000000' } })).status, 400);
    const first = (await b.call('/api/account/mfa/setup', { method: 'POST', body: {} })).data.secret;
    assert.equal((await b.call('/api/account/mfa/setup', { method: 'POST', body: {} })).data.secret, first);
    await enroll(b);
    assert.equal((await b.call('/api/clients')).status, 200);
    const stored = app.store.db.prepare('SELECT password_hash, mfa_secret FROM users').get();
    assert.doesNotMatch(JSON.stringify(stored), /correct horse/); assert.match(stored.mfa_secret, /^v1:/);
  } finally { await app.stop(); }
});

test('sign-in requires the password and a fresh MFA code; codes cannot be replayed', async () => {
  const app = await start();
  try {
    const { secret } = await setupAdmin(app.base);
    assert.equal((await signIn(app.base, ADMIN.email, 'wrong password here')).r.status, 401);
    assert.equal((await signIn(app.base, 'nobody@atlas.test', ADMIN.password)).r.status, 401);
    const { b, r } = await signIn(app.base, ADMIN.email.toUpperCase(), ADMIN.password);
    assert.equal(r.status, 200); assert.equal(r.data.stage, 'mfa');
    assert.equal((await b.call('/api/records')).status, 403);
    // The enrollment code's time step has been used; only a later step is accepted.
    assert.equal((await b.call('/api/session/mfa', { method: 'POST', body: { code: totp(secret) } })).status, 401);
    const verified = await b.call('/api/session/mfa', { method: 'POST', body: { code: totp(secret, totpStep() + 1) } });
    assert.equal(verified.status, 200); assert.equal(verified.data.stage, 'active');
    assert.equal((await b.call('/api/records')).status, 200);
    assert.equal((await b.call('/api/session', { method: 'DELETE' })).status, 200);
    assert.equal((await b.call('/api/records')).status, 401);
    const events = app.store.db.prepare('SELECT action FROM security_events').all().map(e => e.action);
    for (const action of ['Administrator created', 'MFA enabled', 'Sign-in failed', 'MFA verification failed', 'Signed in', 'Signed out']) assert.ok(events.includes(action), action);
  } finally { await app.stop(); }
});

test('accounts lock after repeated failures, even for the right password', async () => {
  const app = await start();
  try {
    await setupAdmin(app.base);
    for (let i = 0; i < 4; i++) assert.equal((await signIn(app.base, ADMIN.email, `wrong password ${i}!`)).r.status, 401);
    assert.equal((await signIn(app.base, ADMIN.email, 'wrong password 5!')).r.status, 429);
    assert.equal((await signIn(app.base, ADMIN.email, ADMIN.password)).r.status, 429);
  } finally { await app.stop(); }
});

test('administrators grant roles and client access; changes apply to live sessions', async () => {
  const app = await start();
  try {
    const { b: admin } = await setupAdmin(app.base);
    const temp = 'temporary pass 1234';
    const viewer = await admin.call('/api/users', { method: 'POST', body: { email: 'viewer@harbor.test', name: 'Harbor Viewer', role: 'client', clientIds: ['harbor'], password: temp } });
    assert.equal(viewer.status, 201); assert.equal(viewer.data.mustChangePassword, true);
    assert.equal((await admin.call('/api/users', { method: 'POST', body: { email: 'x@atlas.test', name: 'X', role: 'client', clientIds: [], password: temp } })).status, 400);
    assert.equal((await admin.call('/api/users', { method: 'POST', body: { email: 'x@atlas.test', name: 'X', role: 'client', clientIds: ['private-client'], password: temp } })).status, 400);
    assert.equal((await admin.call('/api/users', { method: 'POST', body: { email: 'VIEWER@harbor.test', name: 'Dup', role: 'client', clientIds: ['harbor'], password: temp } })).status, 409);
    const tech = await admin.call('/api/users', { method: 'POST', body: { email: 'tech@atlas.test', name: 'Casey Tech', role: 'technician', allClients: false, clientIds: ['harbor'], password: temp } });

    // Client viewer: must replace the temporary password; MFA is optional; read-only and scoped.
    const { b: v, r } = await signIn(app.base, 'viewer@harbor.test', temp);
    assert.equal(r.data.stage, 'password'); assert.equal((await v.call('/api/records')).status, 403);
    assert.equal((await v.call('/api/account/password', { method: 'POST', body: { current: temp, next: temp } })).status, 400);
    assert.equal((await v.call('/api/account/password', { method: 'POST', body: { current: 'not it at all', next: 'harbor reader pass 7' } })).status, 400);
    assert.equal((await v.call('/api/account/password', { method: 'POST', body: { current: temp, next: 'harbor reader pass 7' } })).data.stage, 'active');
    const records = (await v.call('/api/records')).data; assert.ok(records.length && records.every(r => r.client_id === 'harbor'));
    assert.equal((await v.call('/api/records/northline-nas')).status, 404);
    assert.equal((await v.call('/api/clients/harbor/document', { method: 'POST', body: { title: 'x', category: 'Runbook' } })).status, 403);
    assert.equal((await v.call('/api/users')).status, 403);
    assert.equal((await v.call('/api/security-events')).status, 403);

    // Restricted technician: can edit Harbor only, and must enroll MFA first.
    const { b: t } = await signIn(app.base, 'tech@atlas.test', temp);
    await t.call('/api/account/password', { method: 'POST', body: { current: temp, next: 'casey fresh pass 12' } });
    assert.equal((await t.call('/api/records')).status, 403);
    await enroll(t);
    assert.equal((await t.call('/api/clients/harbor/document', { method: 'POST', body: { title: 'Tech runbook', category: 'Runbook' } })).status, 201);
    assert.equal((await t.call('/api/clients/northline/document', { method: 'POST', body: { title: 'Blocked', category: 'Runbook' } })).status, 404);
    assert.equal((await t.call('/api/clients', { method: 'POST', body: { name: 'Blocked client' } })).status, 403);

    // Widening access applies on the next request without signing in again.
    assert.equal((await admin.call(`/api/users/${tech.data.id}`, { method: 'PATCH', body: { allClients: true } })).status, 200);
    assert.equal((await t.call('/api/records/northline-nas')).status, 200);
    // Demoting to client makes the same session read-only immediately.
    assert.equal((await admin.call(`/api/users/${tech.data.id}`, { method: 'PATCH', body: { role: 'client', clientIds: ['harbor'] } })).status, 200);
    assert.equal((await t.call('/api/clients/harbor/document', { method: 'POST', body: { title: 'Blocked', category: 'Runbook' } })).status, 403);
    // Disabling ends every session.
    assert.equal((await admin.call(`/api/users/${viewer.data.id}`, { method: 'PATCH', body: { disabled: true } })).status, 200);
    assert.equal((await v.call('/api/records')).status, 401);
    assert.equal((await signIn(app.base, 'viewer@harbor.test', 'harbor reader pass 7')).r.status, 401);

    // Reset issues a temporary password, clears MFA on request, and signs the user out.
    const reset = await admin.call(`/api/users/${tech.data.id}/reset`, { method: 'POST', body: { password: 'another temp pass 9', resetMfa: true } });
    assert.equal(reset.status, 200); assert.equal(reset.data.mfa, false); assert.equal(reset.data.mustChangePassword, true);
    assert.equal((await t.call('/api/records')).status, 401);
    const events = (await admin.call('/api/security-events')).data.map(e => e.action);
    for (const action of ['User created', 'User updated', 'Password reset', 'Password changed']) assert.ok(events.includes(action), action);
  } finally { await app.stop(); }
});

test('administrators cannot lock themselves or the workspace out', async () => {
  const app = await start();
  try {
    const { b: admin } = await setupAdmin(app.base);
    const me = (await admin.call('/api/users')).data[0];
    assert.equal((await admin.call(`/api/users/${me.id}`, { method: 'PATCH', body: { role: 'technician', allClients: true } })).status, 400);
    assert.equal((await admin.call(`/api/users/${me.id}`, { method: 'PATCH', body: { disabled: true } })).status, 400);
    assert.equal((await admin.call(`/api/users/${me.id}/reset`, { method: 'POST', body: { password: 'some new pass 123' } })).status, 400);
    assert.equal((await admin.call('/api/users/missing', { method: 'PATCH', body: { name: 'x' } })).status, 404);
  } finally { await app.stop(); }
});

test('HTTP protections: CSRF, origin, host, forged identity headers, and disabled secret storage', async () => {
  const app = await start();
  try {
    const { b } = await setupAdmin(app.base);
    assert.equal((await browser(app.base).call('/api/records', { headers: { 'oai-authenticated-user-email': 'forged@example.invalid', 'X-Forwarded-User': 'admin' } })).status, 401);
    assert.equal((await browser(app.base).call('/api/records', { headers: { Cookie: 'atlas_session=' + 'a'.repeat(43) } })).status, 401);
    assert.equal((await b.call('/api/clients', { method: 'POST', body: { name: 'x' }, headers: { 'X-CSRF-Token': 'wrong' } })).status, 403);
    assert.equal((await browser(app.base).call('/api/session', { method: 'POST', body: { email: ADMIN.email, password: ADMIN.password }, headers: { Origin: 'https://evil.example' } })).status, 403);
    const badHost = await new Promise((resolve, reject) => { const req = request(`${app.base}/health`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(badHost, 403);
    assert.equal((await b.call('/server/identity.mjs')).status, 404);
    for (const path of ['/api/vault', '/api/vault/items', '/api/bitlocker/enrollments', '/api/agents', '/api/bitlocker/reveal']) assert.equal((await b.call(path, { method: 'POST', body: {} })).status, 501);
    for (const path of ['/api/agent-ingest', '/api/bitlocker/ingest']) assert.equal((await b.call(path, { method: 'POST', body: {} })).status, 503);
    const html = await fetch(app.base + '/'); assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { await app.stop(); }
});

test('sessions, users and the MFA key persist across restarts; the key file is private', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-identity-'));
  const path = join(directory, 'atlas.sqlite'); const keyFile = join(directory, 'atlas.key');
  let store;
  try {
    store = openStore(path); let identity = openIdentity(store, { keyFile });
    const user = await identity.bootstrap(ADMIN);
    const context = identity.resolve(identity.createSession(user).token);
    const { secret } = identity.beginMfa(context); identity.confirmMfa(context, totp(secret));
    const token = identity.createSession(user, { mfaVerified: true }).token;
    store.close(); store = openStore(path); identity = openIdentity(store, { keyFile });
    const restored = identity.resolve(token);
    assert.equal(restored.stage, 'active'); assert.equal(restored.actor.mfa, true); assert.equal(identity.needsSetup(), false);
    if (process.platform !== 'win32') assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('production startup fails closed', () => {
  const previous = process.env.NODE_ENV; const s = openStore();
  try { process.env.NODE_ENV = 'production'; assert.throws(() => createApp(s, openIdentity(s)), /cannot run in production/); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; s.close(); }
});
