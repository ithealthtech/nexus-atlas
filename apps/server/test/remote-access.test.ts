import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { ServiceRun, UpdateRun } from '@atlas/shared';
import { loadConfig } from '../src/config.js';
import { RemoteAccess, parseAccessConf } from '../src/services/remote-access.js';
import { SystemServices } from '../src/services/system-services.js';
import { UpdateService } from '../src/services/updates.js';
import { OWNER, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const idle = { state: 'idle', requestedBy: null, requestedAt: null, finishedAt: null, message: null } as const;
const noUpdate: UpdateRun = { ...idle, tag: null };
const noService: ServiceRun = { ...idle, action: null };
const TOKEN = 'eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYiLCJzIjoiWm1Wa1pXTmhaR1ZsWm1ZeE1qTTBOVFkzT0RrdyJ9';
const inbox = (dir: string) => join(dir, 'inbox', 'request.json');
const put = (path: string, body: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
};

describe('TRUST_PROXY', () => {
  const trust = (TRUST_PROXY?: string) => loadConfig({ DATABASE_URL: 'postgres://x@y/z', TRUST_PROXY }).TRUST_PROXY;

  it('takes true or false, or a list of addresses and ranges', () => {
    expect(trust(undefined)).toBe(false);
    expect(trust('false')).toBe(false);
    expect(trust('true')).toBe(true);
    expect(trust('1')).toBe(true);
    expect(trust('127.0.0.1,::1, 10.0.0.0/24 ,fd7a:115c::/48')).toEqual([
      '127.0.0.1',
      '::1',
      '10.0.0.0/24',
      'fd7a:115c::/48',
    ]);
  });

  it('refuses anything else, so a typo never trusts everyone', () => {
    expect(() => trust('127.0.0.1,proxy.local')).toThrow(/proxy.local isn't an address/);
    expect(() => trust('10.0.0.1; rm -rf /')).toThrow(/isn't an address/);
  });
});

describe('parseAccessConf', () => {
  it('reads the saved choice as data', () => {
    expect(
      parseAccessConf('MODE=proxy\nPUBLIC_URL=https://atlas.example.com\nTRUSTED=,10.0.0.5,10.0.1.0/24\nFUNNEL=no\n'),
    ).toEqual({
      mode: 'proxy',
      trusted: ['10.0.0.5', '10.0.1.0/24'],
      funnel: false,
    });
    expect(parseAccessConf('MODE=tailscale\r\nFUNNEL=yes')).toMatchObject({ mode: 'tailscale', funnel: true });
    expect(parseAccessConf('MODE=$(reboot)\n').mode).toBeNull();
  });
});

describe('RemoteAccess', () => {
  let dir: string;
  let conf: string;
  let update: UpdateRun;
  let service: ServiceRun;
  const make = (extra: Partial<ConstructorParameters<typeof RemoteAccess>[0]> = {}) =>
    new RemoteAccess({
      dir,
      confDir: conf,
      publicUrl: 'https://192.168.1.220',
      updates: { run: async () => update },
      services: { run: async () => service },
      now: () => NOW,
      ...extra,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-access-'));
    conf = mkdtempSync(join(tmpdir(), 'atlas-conf-'));
    update = noUpdate;
    service = noService;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(conf, { recursive: true, force: true });
  });

  it('shows the installer’s own setup until another is chosen', async () => {
    expect(await make().view()).toEqual({
      canAct: true,
      mode: 'direct',
      publicUrl: 'https://192.168.1.220',
      trusted: [],
      funnel: false,
      hasTunnelToken: false,
      run: idle,
    });
    put(join(conf, 'access.conf'), 'MODE=cloudflare\nPUBLIC_URL=https://atlas.example.com\nTRUSTED=\nFUNNEL=no\n');
    put(join(conf, 'cloudflared.env'), 'TUNNEL_TOKEN=secret');
    expect(await make({ publicUrl: 'https://atlas.example.com' }).view()).toMatchObject({
      mode: 'cloudflare',
      publicUrl: 'https://atlas.example.com',
      hasTunnelToken: true,
    });
  });

  it('says what it can’t tell on servers without the helper', async () => {
    const view = await make({ dir: undefined }).view();
    expect(view).toMatchObject({ canAct: false, mode: null, publicUrl: 'https://192.168.1.220' });
    await expect(
      make({ dir: undefined }).request({ mode: 'direct', publicUrl: 'https://a.example.com' }, 'A'),
    ).rejects.toMatchObject({
      status: 409,
    });
  });

  it('checks each choice before asking the helper', async () => {
    const refused = async (body: unknown) => {
      await expect(make().request(body, 'Avery')).rejects.toMatchObject({ status: 400 });
      expect(existsSync(inbox(dir))).toBe(false);
    };
    await refused({ mode: 'ftp', publicUrl: 'https://atlas.example.com' });
    await refused({ mode: 'direct' });
    await refused({ mode: 'direct', publicUrl: 'http://atlas.example.com' });
    await refused({ mode: 'direct', publicUrl: 'https://atlas.example.com/path' });
    await refused({ mode: 'direct', publicUrl: 'https://atlas.example.com; reboot' });
    await refused({ mode: 'proxy', publicUrl: 'https://atlas.example.com' });
    await refused({ mode: 'proxy', publicUrl: 'https://atlas.example.com', trusted: ['proxy.local'] });
    await refused({ mode: 'cloudflare', publicUrl: 'https://atlas.example.com' });
    await refused({ mode: 'cloudflare', publicUrl: 'https://atlas.example.com', cloudflareToken: 'short' });
    await refused({ mode: 'tailscale', tailscaleAuthKey: 'not-a-key' });
  });

  it('writes only what the chosen way needs', async () => {
    await make().request(
      { mode: 'proxy', publicUrl: 'https://atlas.example.com/', trusted: ['10.0.0.5', '10.0.1.0/24'], funnel: true },
      'Avery',
    );
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8'))).toEqual({
      kind: 'access',
      mode: 'proxy',
      publicUrl: 'https://atlas.example.com',
      trusted: '10.0.0.5,10.0.1.0/24',
      requestedBy: 'Avery',
      requestedAt: new Date(NOW).toISOString(),
    });
    rmSync(inbox(dir));

    await make().request(
      {
        mode: 'tailscale',
        publicUrl: 'https://ignored.example.com',
        funnel: true,
        tailscaleAuthKey: 'tskey-auth-k123456789',
      },
      'Avery',
    );
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8'))).toMatchObject({
      kind: 'access',
      mode: 'tailscale',
      funnel: true,
      tailscaleAuthKey: 'tskey-auth-k123456789',
    });
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8'))).not.toHaveProperty('publicUrl');
    rmSync(inbox(dir));

    // A saved token needn't be pasted again.
    put(join(conf, 'cloudflared.env'), 'TUNNEL_TOKEN=secret');
    await make().request({ mode: 'cloudflare', publicUrl: 'https://atlas.example.com' }, 'Avery');
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8'))).not.toHaveProperty('cloudflareToken');
  });

  it('waits while the server is doing something else', async () => {
    update = { ...noUpdate, state: 'running' };
    await expect(make().request({ mode: 'direct', publicUrl: 'https://a.example.com' }, 'A')).rejects.toMatchObject({
      status: 409,
    });
    update = noUpdate;
    service = { ...noService, state: 'requested' };
    await expect(make().request({ mode: 'direct', publicUrl: 'https://a.example.com' }, 'A')).rejects.toMatchObject({
      status: 409,
    });
    service = noService;
    put(
      join(dir, 'access.json'),
      JSON.stringify({
        state: 'running',
        requestedAt: new Date(NOW - 60_000).toISOString(),
        updatedAt: new Date(NOW - 5_000).toISOString(),
      }),
    );
    await expect(make().request({ mode: 'direct', publicUrl: 'https://a.example.com' }, 'A')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('reports what the helper did, and a change it never picked up', async () => {
    put(
      join(dir, 'access.json'),
      JSON.stringify({
        state: 'succeeded',
        requestedBy: 'Avery',
        message: 'Atlas is reached at https://atlas.example.com',
        finishedAt: '2026-10-14T11:59:00.000Z',
      }),
    );
    expect(await make().run()).toMatchObject({
      state: 'succeeded',
      message: 'Atlas is reached at https://atlas.example.com',
    });
    put(
      inbox(dir),
      JSON.stringify({ kind: 'access', requestedBy: 'Avery', requestedAt: new Date(NOW - 10 * 60_000).toISOString() }),
    );
    expect(await make().run()).toMatchObject({
      state: 'failed',
      message: expect.stringContaining('msp-atlas-updater.path'),
    });
  });

  it('isn’t mistaken for an update or a service action, and neither replaces it', async () => {
    put(
      inbox(dir),
      JSON.stringify({
        kind: 'access',
        mode: 'direct',
        requestedBy: 'Avery',
        requestedAt: new Date(NOW).toISOString(),
      }),
    );
    const updates = new UpdateService({
      repo: 'ithealthtech/nexus-atlas',
      current: '1.7.27',
      dir,
      now: () => NOW,
      fetch: async () => new Response('[]'),
    });
    expect((await updates.run()).state).toBe('idle');
    const services = new SystemServices({ dir, updates, now: () => NOW });
    expect((await services.run()).state).toBe('idle');
    await expect(services.request('restart-atlas', 'Avery')).rejects.toMatchObject({ status: 409 });
    await expect(updates.request('v1.7.28', 'Avery')).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8')).kind).toBe('access');
  });
});

describe('remote access routes', () => {
  let t: TestApp;
  let owner: Browser;
  let dir: string;
  let conf: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-access-'));
    conf = mkdtempSync(join(tmpdir(), 'atlas-conf-'));
    t = await startApp({ ATLAS_UPDATER_DIR: dir, ATLAS_CONF_DIR: conf });
    ({ b: owner } = await setupOwner(t.app));
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(conf, { recursive: true, force: true });
  });

  it('lets the owner change it after a fresh password confirmation, and never logs the token', async () => {
    const view = await owner.call('GET', '/api/system/access');
    expect(view.data).toMatchObject({
      canAct: true,
      mode: 'direct',
      publicUrl: 'http://localhost',
      run: { state: 'idle' },
    });

    const body = { mode: 'cloudflare', publicUrl: 'https://atlas.example.com', cloudflareToken: TOKEN };
    await t.handle.db.execute(sql`update sessions set reauth_at = null`);
    const stale = await owner.call('POST', '/api/system/access', body);
    expect([stale.status, stale.data.code]).toEqual([403, 'reauth']);
    expect(existsSync(inbox(dir))).toBe(false);

    await owner.call('POST', '/api/session/reauth', { password: OWNER.password });
    const asked = await owner.call('POST', '/api/system/access', body);
    expect(asked.status, JSON.stringify(asked.data)).toBe(202);
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8'))).toMatchObject({ kind: 'access', cloudflareToken: TOKEN });
    expect((await owner.call('GET', '/api/system/access')).data.run.state).toBe('requested');

    const log = await t.handle.db.execute(
      sql`select action, detail from security_events where action like 'Remote access%'`,
    );
    expect(log.rows).toEqual([
      { action: 'Remote access change requested', detail: 'Cloudflare Tunnel: https://atlas.example.com' },
    ]);
    expect(JSON.stringify(log.rows)).not.toContain(TOKEN);
  });

  it('is shown to administrators, changed only by the owner, and never through an API key', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/system/access' })).statusCode).toBe(401);
    await owner.call('POST', '/api/users', {
      email: 'ada@atlas.test',
      name: 'Ada Admin',
      password: 'temporary pass 1234',
      role: 'admin',
    });
    const { b: admin } = await signIn(t.app, 'ada@atlas.test', 'temporary pass 1234');
    await admin.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    await enroll(admin);
    expect((await admin.call('GET', '/api/system/access')).status).toBe(200);
    await admin.call('POST', '/api/session/reauth', { password: 'cobalt fresh pass 12' });
    const tried = await admin.call('POST', '/api/system/access', {
      mode: 'direct',
      publicUrl: 'https://atlas.example.com',
    });
    expect(tried.status).toBe(403);

    const key = (await owner.call('POST', '/api/api-keys', { name: 'Sync', scopes: ['read', 'write', 'passwords'] }))
      .data;
    const viaKey = await t.app.inject({
      method: 'POST',
      url: '/api/v1/system/access',
      headers: { authorization: `Bearer ${key.token}` },
      payload: { mode: 'direct', publicUrl: 'https://atlas.example.com' },
    });
    expect(viaKey.statusCode).toBe(403);
    expect(existsSync(inbox(dir))).toBe(false);
  });
});
