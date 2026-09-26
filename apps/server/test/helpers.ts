import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { connect, runMigrations, type DatabaseHandle } from '@atlas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { staticKeyProvider, type KeyProvider } from '../src/crypto/keys.js';
import { totp } from '../src/identity/totp.js';
import type { SendArgs } from '../src/services/mail.js';
import type { DomainLookup } from '../src/services/domain-lookup.js';

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
export const SETUP_CODE = 'test-setup-code-123';
export const OWNER = {
  name: 'Avery Owner',
  email: 'owner@atlas.test',
  password: 'correct horse battery 1',
  organization: 'IT Done Right',
};

/** A fresh database with migrations applied, dropped when the test finishes. */
export async function freshDatabase(
  options: { migrate?: boolean } = {},
): Promise<{ url: string; handle: DatabaseHandle; drop(): Promise<void> }> {
  const name = `atlas_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const handle = connect(url.toString(), { max: 5 });
  if (options.migrate !== false) await runMigrations(handle);
  return {
    url: url.toString(),
    handle,
    async drop() {
      await handle.close();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  handle: DatabaseHandle;
  /** Emails the app has sent (SMTP is replaced by a capture). */
  outbox: (SendArgs & { host: string })[];
  close(): Promise<void>;
}

export async function startApp(
  env: Record<string, string> = {},
  extra: {
    huduFetch?: typeof fetch;
    cwRmmFetch?: typeof fetch;
    domainLookup?: DomainLookup;
    updateFetch?: typeof fetch;
    keys?: KeyProvider;
    /** An existing database (for example one a backup was restored into) instead of a fresh one. */
    database?: Awaited<ReturnType<typeof freshDatabase>>;
  } = {},
): Promise<TestApp> {
  const outbox: TestApp['outbox'] = [];
  const { keys = staticKeyProvider([randomBytes(32)]), database = await freshDatabase(), ...rest } = extra;
  const config = loadConfig({
    DATABASE_URL: database.url,
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG ?? 'silent',
    PUBLIC_URL: 'http://localhost',
    ...env,
  });
  const app = await buildApp({
    config,
    database: database.handle,
    keys,
    setupCode: SETUP_CODE,
    ...rest,
    mailTransport: async (smtp, message) => {
      if (smtp.host === 'reject.invalid') throw new Error('550 relay denied');
      outbox.push({ ...message, host: smtp.host });
    },
  });
  return {
    app,
    handle: database.handle,
    outbox,
    async close() {
      await app.close();
      await database.drop();
    },
  };
}

/** A browser-like client: keeps its session cookie and CSRF token. */
export function browser(app: FastifyInstance) {
  const jar = new Map<string, string>();
  const agent = {
    jar,
    get cookie() {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(value: string) {
      jar.clear();
      for (const part of value
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)) {
        const i = part.indexOf('=');
        jar.set(part.slice(0, i), part.slice(i + 1));
      }
    },
    csrf: '',
    async call(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
      url: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await app.inject({
        method,
        url,
        headers: {
          ...(agent.cookie ? { cookie: agent.cookie } : {}),
          ...(method !== 'GET' && agent.csrf ? { 'x-csrf-token': agent.csrf } : {}),
          ...headers,
        },
        ...(body !== undefined ? { payload: body as object } : {}),
      });
      const setCookie = response.headers['set-cookie'];
      for (const header of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
        const pair = header.split(';')[0]!;
        const i = pair.indexOf('=');
        if (pair.slice(i + 1)) jar.set(pair.slice(0, i), pair.slice(i + 1));
        else jar.delete(pair.slice(0, i));
      }
      const data = response.headers['content-type']?.toString().includes('json')
        ? JSON.parse(response.body)
        : response.body || null;
      if (data?.csrf) agent.csrf = data.csrf;
      return { status: response.statusCode, data, headers: response.headers };
    },
  };
  return agent;
}
export type Browser = ReturnType<typeof browser>;

export async function signIn(app: FastifyInstance, email: string, password: string) {
  const b = browser(app);
  const r = await b.call('POST', '/api/session', { email, password });
  return { b, r };
}

/** Completes MFA enrollment the way an authenticator app would, returning the secret. */
export async function enroll(b: Browser): Promise<string> {
  const setup = await b.call('POST', '/api/account/mfa/setup', {});
  if (setup.status !== 200) throw new Error(`MFA setup failed: ${JSON.stringify(setup.data)}`);
  const done = await b.call('POST', '/api/account/mfa/confirm', { code: totp(setup.data.secret) });
  if (done.data?.stage !== 'active') throw new Error(`MFA confirm failed: ${JSON.stringify(done.data)}`);
  return setup.data.secret;
}

export async function setupOwner(app: FastifyInstance) {
  const b = browser(app);
  const r = await b.call('POST', '/api/setup', { ...OWNER, setupCode: SETUP_CODE });
  if (r.status !== 201) throw new Error(`Setup failed: ${JSON.stringify(r.data)}`);
  const secret = await enroll(b);
  return { b, secret };
}
