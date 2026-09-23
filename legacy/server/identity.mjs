import { scrypt as scryptCallback, randomBytes, randomUUID, createHash, createHmac, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { Problem } from './store.mjs';

const scrypt = promisify(scryptCallback);
const fail = (status, message) => { throw new Problem(status, message); };
const now = () => new Date().toISOString();
export const ROLES = Object.freeze(['admin', 'technician', 'client']);
export const MSP_ID = 'msp-demo';
export const LIMITS = Object.freeze({ attempts: 5, lockMs: 15 * 60000, idleMs: 2 * 3600000, absoluteMs: 12 * 3600000, sessionsPerUser: 10 });
const HASH = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Passwords: scrypt with a per-password salt; parameters are stored so they can be raised later.
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, HASH);
  return `scrypt$${HASH.N}$${HASH.r}$${HASH.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p, maxmem: HASH.maxmem });
  return timingSafeEqual(key, expected);
}
export function checkPassword(password, email = '') {
  if (typeof password !== 'string' || password.length < 12) fail(400, 'Use a password of at least 12 characters.');
  if (password.length > 256) fail(400, 'Passwords must be 256 characters or fewer.');
  if (new Set(password).size < 5) fail(400, 'Choose a less repetitive password.');
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && password.toLowerCase().includes(local)) fail(400, 'Passwords cannot contain your email name.');
  return password;
}

// RFC 6238 TOTP (SHA-1, 30 seconds, 6 digits) — the variant every authenticator app supports.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function toBase32(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) { value = ((value << 8) | byte) & 0xffff; bits += 8; while (bits >= 5) { output += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits ? output + B32[(value << (5 - bits)) & 31] : output;
}
function fromBase32(text) {
  let bits = 0, value = 0; const bytes = [];
  for (const char of text.replace(/=+$/, '')) { const index = B32.indexOf(char); if (index < 0) fail(500, 'Invalid MFA secret.'); value = ((value << 5) | index) & 0xffff; bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(bytes);
}
export const totpStep = (time = Date.now()) => Math.floor(time / 30000);
export function totp(secret, step = totpStep()) {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', fromBase32(secret)).update(message).digest();
  const offset = hmac[19] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// MFA secrets are sealed with a server key kept outside the database file.
function loadKey(file) {
  if (!file) return randomBytes(32);
  if (existsSync(file)) { const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url'); if (key.length !== 32) throw new Error(`Invalid key file: ${file}`); return key; }
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32); writeFileSync(file, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
  try { chmodSync(file, 0o600); } catch {}
  return key;
}
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };

export function openIdentity(store, { keyFile = '', requireStaffMfa = true } = {}) {
  const { db, transaction } = store;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, msp_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','technician','client')), all_clients INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
      mfa_secret TEXT, mfa_pending TEXT, mfa_last_step INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
      last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_clients (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL,
      mfa_verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, ip TEXT NOT NULL, user_agent TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY, msp_id TEXT NOT NULL, user_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL,
      detail TEXT NOT NULL, ip TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    INSERT OR IGNORE INTO schema_version VALUES (2);
  `);
  const key = loadKey(keyFile);
  const get = (sql, ...p) => db.prepare(sql).get(...p);
  const all = (sql, ...p) => db.prepare(sql).all(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  const seal = text => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([c.update(text, 'utf8'), c.final()]); return ['v1', iv, c.getAuthTag(), body].map(v => typeof v === 'string' ? v : v.toString('base64url')).join(':'); };
  const open = sealed => { const [v, iv, tag, body] = sealed.split(':'); if (v !== 'v1') fail(500, 'Unsupported secret format.'); const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url')); return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8'); };
  let dummyHash;

  function event(user, action, detail = '', ip = '') {
    run('INSERT INTO security_events VALUES (?,?,?,?,?,?,?,?)', randomUUID(), user?.msp_id || user?.mspId || MSP_ID, user?.id || null, user?.name || 'Unknown account', action, String(detail).slice(0, 300), ip, now());
  }
  const grants = userId => all('SELECT client_id FROM user_clients WHERE user_id=? ORDER BY client_id', userId).map(r => r.client_id);
  const isStaff = user => user.role !== 'client';
  function actorFor(user) {
    const unrestricted = user.role === 'admin' || (user.role === 'technician' && user.all_clients);
    return Object.freeze({ id: user.id, name: user.name, email: user.email, role: user.role, mspId: user.msp_id, clientIds: unrestricted ? null : Object.freeze(grants(user.id)), mfa: !!user.mfa_secret });
  }
  function stageFor(user, session) {
    if (user.mfa_secret && !session.mfa_verified) return 'mfa';
    if (user.must_change_password) return 'password';
    if (requireStaffMfa && isStaff(user) && !user.mfa_secret) return 'mfa-setup';
    return 'active';
  }
  function publicUser(user) {
    return { id: user.id, email: user.email, name: user.name, role: user.role, allClients: user.role === 'admin' || !!user.all_clients, clientIds: grants(user.id),
      mfa: !!user.mfa_secret, disabled: !!user.disabled, locked: user.locked_until > Date.now(), mustChangePassword: !!user.must_change_password,
      lastLoginAt: user.last_login_at, createdAt: user.created_at };
  }
  function admin(actor) { if (actor.role !== 'admin') fail(403, 'Administrator access is required.'); }
  function userFor(actor, id) { const user = get('SELECT * FROM users WHERE id=? AND msp_id=?', id, actor.mspId); if (!user) fail(404, 'User not found.'); return user; }
  function text(value, label, max) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, `${label} is required and must be under ${max + 1} characters.`); return value.trim(); }
  function email(value) { const v = text(value, 'Email', 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail(400, 'Enter a valid email address.'); return v; }
  function access(mspId, role, allClients, clientIds) {
    if (!ROLES.includes(role)) fail(400, 'Choose a valid role.');
    if (!Array.isArray(clientIds ?? []) || (clientIds ?? []).some(id => typeof id !== 'string')) fail(400, 'Client access must be a list of clients.');
    const ids = [...new Set(clientIds ?? [])];
    for (const id of ids) if (!get('SELECT 1 FROM clients WHERE id=? AND msp_id=?', id, mspId)) fail(400, 'Choose clients from this workspace.');
    const everything = role === 'admin' || (role === 'technician' && allClients === true);
    if (!everything && !ids.length) fail(400, 'Grant access to at least one client.');
    return { allClients: everything ? 1 : 0, ids: everything ? [] : ids };
  }
  function setGrants(userId, ids) { run('DELETE FROM user_clients WHERE user_id=?', userId); for (const id of ids) run('INSERT INTO user_clients VALUES (?,?)', userId, id); }
  function activeAdmins(mspId) { return get("SELECT COUNT(*) AS count FROM users WHERE msp_id=? AND role='admin' AND disabled=0", mspId).count; }
  // Accepts the current code and one step either side; a step can be used once.
  function matchStep(secret, code, lastStep) {
    const current = totpStep();
    for (const step of [current - 1, current, current + 1]) if (step > lastStep && sameText(totp(secret, step), code)) return step;
    return 0;
  }
  const revokeAll = (userId, keepHash = '') => run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', userId, keepHash);

  return {
    actorFor, stageFor, publicUser, event,
    needsSetup: () => !get('SELECT 1 FROM users LIMIT 1'),
    async bootstrap(body, ip = '') {
      if (!body || typeof body !== 'object') fail(400, 'An object is required.');
      const address = email(body.email); const name = text(body.name, 'Name', 120); checkPassword(body.password, address);
      const hash = await hashPassword(body.password);
      return transaction(() => {
        if (get('SELECT 1 FROM users LIMIT 1')) fail(409, 'Atlas is already set up. Sign in instead.');
        const id = randomUUID();
        run('INSERT INTO users (id,msp_id,email,name,role,all_clients,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', id, MSP_ID, address, name, 'admin', 1, hash, now(), now());
        const user = get('SELECT * FROM users WHERE id=?', id); event(user, 'Administrator created', 'First-run setup', ip); return user;
      });
    },
    async authenticate(emailAddress, password, ip = '') {
      if (typeof emailAddress !== 'string' || typeof password !== 'string' || emailAddress.length > 254 || password.length > 256) fail(400, 'Enter your email and password.');
      const user = get('SELECT * FROM users WHERE email=?', emailAddress.trim().toLowerCase());
      dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
      // Always run one scrypt verification so unknown accounts take the same time.
      const valid = await verifyPassword(password, user?.password_hash || dummyHash);
      if (!user) { event(null, 'Sign-in failed', `Unknown account ${emailAddress.slice(0, 80)}`, ip); fail(401, 'Email or password is incorrect.'); }
      if (user.locked_until > Date.now()) { event(user, 'Sign-in blocked', 'Account is temporarily locked', ip); fail(429, 'Too many attempts. Try again in 15 minutes.'); }
      if (!valid) {
        const attempts = user.failed_attempts + 1; const lock = attempts >= LIMITS.attempts;
        run('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?', lock ? 0 : attempts, lock ? Date.now() + LIMITS.lockMs : 0, user.id);
        event(user, lock ? 'Account locked' : 'Sign-in failed', lock ? `${LIMITS.attempts} failed attempts` : 'Incorrect password', ip);
        fail(lock ? 429 : 401, lock ? 'Too many attempts. Try again in 15 minutes.' : 'Email or password is incorrect.');
      }
      if (user.disabled) { event(user, 'Sign-in blocked', 'Account is disabled', ip); fail(401, 'Email or password is incorrect.'); }
      run('UPDATE users SET failed_attempts=0, locked_until=0 WHERE id=?', user.id);
      return get('SELECT * FROM users WHERE id=?', user.id);
    },
    createSession(user, { ip = '', userAgent = '', mfaVerified = false } = {}) {
      const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(32).toString('base64url'); const time = Date.now();
      transaction(() => {
        run('DELETE FROM sessions WHERE last_seen<? OR created_at<?', time - LIMITS.idleMs, time - LIMITS.absoluteMs);
        const excess = all('SELECT token_hash FROM sessions WHERE user_id=? ORDER BY last_seen DESC LIMIT -1 OFFSET ?', user.id, LIMITS.sessionsPerUser - 1);
        for (const row of excess) run('DELETE FROM sessions WHERE token_hash=?', row.token_hash);
        run('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)', tokenHash(token), user.id, csrf, mfaVerified ? 1 : 0, time, time, ip.slice(0, 64), userAgent.slice(0, 200));
        if (mfaVerified || !user.mfa_secret) { run('UPDATE users SET last_login_at=? WHERE id=?', now(), user.id); event(user, 'Signed in', user.mfa_secret ? 'Password and MFA' : 'Password', ip); }
      });
      return { token, csrf };
    },
    resolve(token) {
      if (!token) return null;
      const hash = tokenHash(token); const time = Date.now();
      const session = get('SELECT * FROM sessions WHERE token_hash=?', hash);
      if (!session) return null;
      const user = get('SELECT * FROM users WHERE id=?', session.user_id);
      if (!user || user.disabled || session.last_seen < time - LIMITS.idleMs || session.created_at < time - LIMITS.absoluteMs) { run('DELETE FROM sessions WHERE token_hash=?', hash); return null; }
      if (time - session.last_seen > 60000) run('UPDATE sessions SET last_seen=? WHERE token_hash=?', time, hash);
      return { hash, session, user, stage: stageFor(user, session), actor: actorFor(user) };
    },
    signOut(context, ip = '') { run('DELETE FROM sessions WHERE token_hash=?', context.hash); event(context.user, 'Signed out', '', ip); },
    verifyMfa(context, code, ip = '') {
      const { user, hash } = context;
      if (!user.mfa_secret) fail(400, 'MFA is not enabled for this account.');
      if (user.locked_until > Date.now()) fail(429, 'Too many attempts. Try again in 15 minutes.');
      const step = typeof code === 'string' && /^\d{6}$/.test(code.trim()) ? matchStep(open(user.mfa_secret), code.trim(), user.mfa_last_step) : 0;
      if (!step) {
        const attempts = user.failed_attempts + 1; const lock = attempts >= LIMITS.attempts;
        run('UPDATE users SET failed_attempts=?, locked_until=? WHERE id=?', lock ? 0 : attempts, lock ? Date.now() + LIMITS.lockMs : 0, user.id);
        if (lock) revokeAll(user.id);
        event(user, lock ? 'Account locked' : 'MFA verification failed', lock ? `${LIMITS.attempts} failed MFA codes` : '', ip);
        fail(lock ? 429 : 401, lock ? 'Too many attempts. Try again in 15 minutes.' : 'That code did not match. Check your authenticator app and try again.');
      }
      transaction(() => {
        run('UPDATE users SET mfa_last_step=?, failed_attempts=0, last_login_at=? WHERE id=?', step, now(), user.id);
        run('UPDATE sessions SET mfa_verified=1 WHERE token_hash=?', hash);
        event(user, 'Signed in', 'Password and MFA', ip);
      });
    },
    beginMfa(context) {
      if (context.user.mfa_secret) fail(409, 'MFA is already enabled. Ask an administrator to reset it.');
      // Reuse an unconfirmed key so reloading the setup page doesn't invalidate an app entry already added.
      const secret = context.user.mfa_pending ? open(context.user.mfa_pending) : toBase32(randomBytes(20));
      if (!context.user.mfa_pending) run('UPDATE users SET mfa_pending=?, updated_at=? WHERE id=?', seal(secret), now(), context.user.id);
      const label = encodeURIComponent(`MSP Atlas:${context.user.email}`);
      return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('MSP Atlas')}&algorithm=SHA1&digits=6&period=30` };
    },
    confirmMfa(context, code, ip = '') {
      const user = get('SELECT * FROM users WHERE id=?', context.user.id);
      if (!user.mfa_pending) fail(400, 'Start MFA setup first.');
      const secret = open(user.mfa_pending);
      const step = typeof code === 'string' && /^\d{6}$/.test(code.trim()) ? matchStep(secret, code.trim(), 0) : 0;
      if (!step) fail(400, 'That code did not match. Check the time on your device and try again.');
      transaction(() => {
        run('UPDATE users SET mfa_secret=?, mfa_pending=NULL, mfa_last_step=?, updated_at=? WHERE id=?', seal(secret), step, now(), user.id);
        run('UPDATE sessions SET mfa_verified=1 WHERE token_hash=?', context.hash);
        revokeAll(user.id, context.hash);
        event(user, 'MFA enabled', 'Authenticator app', ip);
      });
    },
    async changePassword(context, current, next, ip = '') {
      const { user } = context;
      if (typeof current !== 'string' || !(await verifyPassword(current, user.password_hash))) { event(user, 'Password change failed', 'Current password incorrect', ip); fail(400, 'Your current password is incorrect.'); }
      checkPassword(next, user.email);
      if (current === next) fail(400, 'Choose a password you have not just used.');
      const hash = await hashPassword(next);
      transaction(() => {
        run('UPDATE users SET password_hash=?, must_change_password=0, updated_at=? WHERE id=?', hash, now(), user.id);
        revokeAll(user.id, context.hash); event(user, 'Password changed', 'Other sessions signed out', ip);
      });
    },
    listUsers(actor) { admin(actor); return all('SELECT * FROM users WHERE msp_id=? ORDER BY name COLLATE NOCASE', actor.mspId).map(publicUser); },
    async createUser(actor, body, ip = '') {
      admin(actor);
      if (!body || typeof body !== 'object') fail(400, 'An object is required.');
      const address = email(body.email); const name = text(body.name, 'Name', 120);
      const grant = access(actor.mspId, body.role, body.allClients, body.clientIds);
      checkPassword(body.password, address); const hash = await hashPassword(body.password);
      return transaction(() => {
        if (get('SELECT 1 FROM users WHERE email=?', address)) fail(409, 'An account with this email already exists.');
        const id = randomUUID();
        run('INSERT INTO users (id,msp_id,email,name,role,all_clients,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?)', id, actor.mspId, address, name, body.role, grant.allClients, hash, now(), now());
        setGrants(id, grant.ids);
        const user = get('SELECT * FROM users WHERE id=?', id);
        event(actor, 'User created', `${address} · ${body.role}`, ip); return publicUser(user);
      });
    },
    updateUser(actor, id, body, ip = '') {
      admin(actor); const user = userFor(actor, id);
      if (!body || typeof body !== 'object') fail(400, 'An object is required.');
      const role = body.role ?? user.role; const disabled = body.disabled ?? !!user.disabled;
      if (typeof disabled !== 'boolean') fail(400, 'Choose whether the account is disabled.');
      const name = body.name === undefined ? user.name : text(body.name, 'Name', 120);
      const grant = access(actor.mspId, role, body.allClients ?? !!user.all_clients, body.clientIds ?? grants(id));
      if (id === actor.id && (role !== 'admin' || disabled)) fail(400, 'You cannot remove your own administrator access.');
      if (user.role === 'admin' && !user.disabled && (role !== 'admin' || disabled) && activeAdmins(actor.mspId) <= 1) fail(400, 'Keep at least one active administrator.');
      return transaction(() => {
        run('UPDATE users SET name=?, role=?, all_clients=?, disabled=?, updated_at=? WHERE id=?', name, role, grant.allClients, disabled ? 1 : 0, now(), id);
        setGrants(id, grant.ids);
        // Access changes apply on the next request; disabling also ends every session.
        if (disabled) revokeAll(id);
        event(actor, 'User updated', `${user.email} · ${role}${disabled ? ' · disabled' : ''}`, ip);
        return publicUser(get('SELECT * FROM users WHERE id=?', id));
      });
    },
    async resetUser(actor, id, body, ip = '') {
      admin(actor); const user = userFor(actor, id);
      if (!body || typeof body !== 'object') fail(400, 'An object is required.');
      if (id === actor.id) fail(400, 'Use your account page to change your own password.');
      checkPassword(body.password, user.email); const hash = await hashPassword(body.password);
      const resetMfa = body.resetMfa === true;
      return transaction(() => {
        run(`UPDATE users SET password_hash=?, must_change_password=1, failed_attempts=0, locked_until=0, updated_at=?${resetMfa ? ', mfa_secret=NULL, mfa_pending=NULL, mfa_last_step=0' : ''} WHERE id=?`, hash, now(), id);
        revokeAll(id);
        event(actor, 'Password reset', `${user.email}${resetMfa ? ' · MFA reset' : ''}`, ip);
        return publicUser(get('SELECT * FROM users WHERE id=?', id));
      });
    },
    events(actor) { admin(actor); return all('SELECT actor, action, detail, ip, created_at FROM security_events WHERE msp_id=? ORDER BY created_at DESC LIMIT 200', actor.mspId); }
  };
}
