import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Problem } from './store.mjs';
import { bitlockerInventory } from './bitlocker.mjs';

export const demoActors = Object.freeze({
  technician: Object.freeze({ id: 'tech-demo', name: 'Demo technician', role: 'editor', mspId: 'msp-demo', clientIds: null }),
  client: Object.freeze({ id: 'client-demo', name: 'Harbor client viewer', role: 'viewer', mspId: 'msp-demo', clientIds: ['harbor'] })
});
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
export function createApp(store) {
  if (process.env.NODE_ENV === 'production') throw new Error('This local development release cannot run in production.');
  const sessions = new Map();
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
      const token = /(?:^|;\s*)atlas_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
      let session = sessions.get(token);
      if (session && session.expires < Date.now()) { sessions.delete(token); session = null; }
      if (path === '/api/session' && req.method === 'POST') {
        const body = await jsonBody(req);
        if (!Object.hasOwn(demoActors, body.persona)) throw new Problem(400, 'Choose a demo account.');
        for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
        if (sessions.size >= 1000) throw new Problem(429, 'Too many demo sessions. Restart the local preview.');
        if (token) sessions.delete(token);
        const newToken = randomBytes(32).toString('hex');
        session = { actor: demoActors[body.persona], csrf: randomBytes(32).toString('hex'), expires: Date.now() + 8 * 3600000 };
        sessions.set(newToken, session);
        return send(200, { actor: session.actor, csrf: session.csrf }, { 'Set-Cookie': `atlas_session=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800` });
      }
      if (!session) throw new Problem(401, 'Open a demo workspace to continue.');
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== session.csrf) throw new Problem(403, 'Session verification failed. Reload the page.');
      const { actor } = session;
      if (path === '/api/session' && req.method === 'GET') return send(200, { actor, csrf: session.csrf });
      if (path === '/api/session' && req.method === 'DELETE') { sessions.delete(token); return send(200, { ok: true }, { 'Set-Cookie': 'atlas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
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
      if (!res.headersSent) send(error instanceof Problem ? error.status : 500, { error: error instanceof Problem ? error.message : 'Something went wrong. Please try again.' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
