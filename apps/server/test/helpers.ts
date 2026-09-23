import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { connect, runMigrations, type DatabaseHandle } from '@atlas/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { totp } from '../src/identity/totp.js';

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
export const SETUP_CODE = 'test-setup-code-123';
export const OWNER = {
  name: 'Avery Owner',
  email: 'owner@atlas.test',
  password: 'correct horse battery 1',
  organization: 'IT Done Right',
};

/** A fresh database with migrations applied, dropped when the test finishes. */
export async function freshDatabase(): Promise<{ url: string; handle: DatabaseHandle; drop(): Promise<void> }> {
  const name = `atlas_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const handle = connect(url.toString(), { max: 5 });
  await runMigrations(handle);
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
  close(): Promise<void>;
}

export async function startApp(env: Record<string, string> = {}): Promise<TestApp> {
  const database = await freshDatabase();
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
    keys: staticKeyProvider([randomBytes(32)]),
    setupCode: SETUP_CODE,
  });
  return {
    app,
    handle: database.handle,
    async close() {
      await app.close();
      await database.drop();
    },
  };
}

/** A browser-like client: keeps its session cookie and CSRF token. */
export function browser(app: FastifyInstance) {
  const agent = {
    cookie: '',
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
      const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (first) agent.cookie = first.split(';')[0]!.endsWith('=') ? '' : first.split(';')[0]!;
      const data = response.body ? JSON.parse(response.body) : null;
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
