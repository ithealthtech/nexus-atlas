import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Problem } from './store.mjs';
import { bitlockerInventory } from './bitlocker.mjs';

const files = new Map([
  ['/', ['../public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['../public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['../public/styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['../public/favicon.svg', 'image/svg+xml']]
]);
async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new Problem(415, 'Send JSON content.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Problem(413, 'Request is too large.'); chunks.push(chunk); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
  catch { throw new Problem(400, 'Invalid JSON object.'); }
}
const COOKIE = 'atlas_session';
const cookie = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
// Unauthenticated endpoints (sign-in, setup) are rate limited per client address.
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    check(key) { const entry = hits.get(key); if (entry && entry.reset > Date.now() && entry.count >= max) throw new Problem(429, 'Too many attempts. Wait a few minutes and try again.'); },
    fail(key) { const time = Date.now(); if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < time) hits.delete(k); const entry = hits.get(key); if (!entry || entry.reset < time) hits.set(key, { count: 1, reset: time + windowMs }); else entry.count++; }
  };
}
// Paths a signed-in account may use before it finishes MFA, a required password change, or MFA enrollment.
const stagePaths = {
  mfa: ['POST /api/session/mfa'],
  password: ['POST /api/account/password'],
  'mfa-setup': ['POST /api/account/mfa/setup', 'POST /api/account/mfa/confirm']
};
export function createApp(store, identity, { setupCode = '' } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('This local development release cannot run in production.');
  const attempts = limiter(10, 15 * 60000);
  const sessionView = context => ({ actor: context.actor, csrf: context.session.csrf, stage: context.stage });
  const server = createServer(async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    };
    const send = (status, data, extra = {}) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); res.end(JSON.stringify(data)); };
    try {
      const port = server.address().port;
      const host = req.headers.host;
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) throw new Problem(403, 'Local access only.');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new Problem(403, 'Origin is not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new Problem(403, 'Cross-site requests are not allowed.');
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;
      if (req.method === 'GET' && files.has(path)) {
        const [filename, type] = files.get(path);
        const content = await readFile(fileURLToPath(new URL(filename, import.meta.url)));
        res.writeHead(200, { ...headers, 'Content-Type': type }); res.end(content); return;
      }
      if (path === '/health' && req.method === 'GET') return send(200, { ok: true, mode: 'local-development' });
      // No machine ingress exists until Atlas enrollment and the vault review are complete.
      if (path === '/api/agent-ingest' || path === '/api/bitlocker/ingest') throw new Problem(503, 'BitLocker collection is disabled. No report has been accepted.');
      const ip = req.socket.remoteAddress || '';
      if (path === '/api/setup' && req.method === 'GET') return send(200, { needed: identity.needsSetup() });
      if (path === '/api/setup' && req.method === 'POST') {
        attempts.check(ip);
        const body = await jsonBody(req);
        if (!identity.needsSetup()) throw new Problem(409, 'Atlas is already set up. Sign in instead.');
        const code = Buffer.from(String(body.setupCode ?? '')), expected = Buffer.from(setupCode);
        if (!setupCode || code.length !== expected.length || !timingSafeEqual(code, expected)) { attempts.fail(ip); throw new Problem(403, 'The setup code is incorrect. Copy it from the server console.'); }
        delete body.setupCode;
        const user = await identity.bootstrap(body, ip);
        const created = identity.createSession(user, { ip, userAgent: req.headers['user-agent'] || '' });
        return send(201, sessionView(identity.resolve(created.token)), { 'Set-Cookie': cookie(created.token, 43200) });
      }
      const token = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(req.headers.cookie || '')?.[1];
      if (path === '/api/session' && req.method === 'POST') {
        attempts.check(ip);
        const body = await jsonBody(req);
        let user;
        try { user = await identity.authenticate(body.email, body.password, ip); }
        catch (error) { if (error.status === 401 || error.status === 429) attempts.fail(ip); throw error; }
        const previous = identity.resolve(token); if (previous) identity.signOut(previous, ip);
        const created = identity.createSession(user, { ip, userAgent: req.headers['user-agent'] || '' });
        return send(200, sessionView(identity.resolve(created.token)), { 'Set-Cookie': cookie(created.token, 43200) });
      }
      const context = identity.resolve(token);
      if (!context) throw new Problem(401, 'Sign in to continue.', token ? { 'Set-Cookie': cookie('', 0) } : undefined);
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== context.session.csrf) throw new Problem(403, 'Session verification failed. Reload the page.');
      if (path === '/api/session' && req.method === 'GET') return send(200, sessionView(context));
      if (path === '/api/session' && req.method === 'DELETE') { identity.signOut(context, ip); return send(200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); }
      if (context.stage !== 'active' && !stagePaths[context.stage].includes(`${req.method} ${path}`)) throw new Problem(403, 'Finish signing in to continue.');
      if (path === '/api/session/mfa' && req.method === 'POST') { identity.verifyMfa(context, (await jsonBody(req)).code, ip); return send(200, sessionView(identity.resolve(token))); }
      if (path === '/api/account/password' && req.method === 'POST') { const body = await jsonBody(req); await identity.changePassword(context, body.current, body.next, ip); return send(200, sessionView(identity.resolve(token))); }
      if (path === '/api/account/mfa/setup' && req.method === 'POST') return send(200, identity.beginMfa(context));
      if (path === '/api/account/mfa/confirm' && req.method === 'POST') { identity.confirmMfa(context, (await jsonBody(req)).code, ip); return send(200, sessionView(identity.resolve(token))); }
      const { actor } = context;
      if (path === '/api/users' && req.method === 'GET') return send(200, identity.listUsers(actor));
      if (path === '/api/users' && req.method === 'POST') return send(201, await identity.createUser(actor, await jsonBody(req), ip));
      if (path === '/api/security-events' && req.method === 'GET') return send(200, identity.events(actor));
      let userMatch;
      if ((userMatch = /^\/api\/users\/([^/]+)$/.exec(path)) && req.method === 'PATCH') return send(200, identity.updateUser(actor, userMatch[1], await jsonBody(req), ip));
      if ((userMatch = /^\/api\/users\/([^/]+)\/reset$/.exec(path)) && req.method === 'POST') return send(200, await identity.resetUser(actor, userMatch[1], await jsonBody(req), ip));
      if (path.startsWith('/api/vault')) throw new Problem(501, 'Vault storage is disabled in this development release.');
      if (path === '/api/bitlocker' && req.method === 'GET') return send(200, bitlockerInventory(store, actor, url.searchParams.get('client') || ''));
      if (path.startsWith('/api/bitlocker/') || path.startsWith('/api/agents')) throw new Problem(501, 'BitLocker enrollment, recovery, sharing, and imports are disabled in this release.');
      if (path === '/api/clients' && req.method === 'GET') return send(200, store.listClients(actor));
      if (path === '/api/clients' && req.method === 'POST') return send(201, store.createClient(actor, await jsonBody(req)));
      if (path === '/api/records' && req.method === 'GET') return send(200, store.listRecords(actor, url.searchParams.get('client') || '', (url.searchParams.get('q') || '').slice(0,200)));
      if (path === '/api/activity' && req.method === 'GET') return send(200, store.activity(actor, url.searchParams.get('client') || ''));
      let match;
      if ((match = /^\/api\/clients\/([^/]+)\/(asset|document)$/.exec(path)) && req.method === 'POST') return send(201, store.createRecord(actor, match[1], match[2], await jsonBody(req)));
      if ((match = /^\/api\/clients\/([^/]+)\/export$/.exec(path)) && req.method === 'POST') return send(200, store.exportClient(actor, match[1]));
      if ((match = /^\/api\/records\/([^/]+)$/.exec(path))) {
        if (req.method === 'GET') return send(200, store.detail(actor, match[1]));
        if (req.method === 'PUT') return send(200, store.saveRecord(actor, match[1], await jsonBody(req)));
      }
      if ((match = /^\/api\/records\/([^/]+)\/restore$/.exec(path)) && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!Number.isInteger(body.version) || !Number.isInteger(body.expectedVersion)) throw new Problem(400, 'Valid versions are required.');
        return send(200, store.restore(actor, match[1], body.version, body.expectedVersion));
      }
      if ((match = /^\/api\/records\/([^/]+)\/links$/.exec(path)) && req.method === 'POST') {
        const body = await jsonBody(req);
        if (typeof body.targetId !== 'string') throw new Problem(400, 'Choose a related record.');
        return send(200, store.link(actor, match[1], body.targetId));
      }
      throw new Problem(404, 'Not found.');
    } catch (error) {
      if (!(error instanceof Problem)) console.error(error);
      if (!res.headersSent) send(error instanceof Problem ? error.status : 500, { error: error instanceof Problem ? error.message : 'Something went wrong. Please try again.' }, error.headers);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
