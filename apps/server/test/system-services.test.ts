import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { SERVICE_ACTIONS, type UpdateRun } from '@atlas/shared';
import { SystemServices, type ShowUnit } from '../src/services/system-services.js';
import { UpdateService } from '../src/services/updates.js';
import { OWNER, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const noUpdate: UpdateRun = {
  state: 'idle',
  tag: null,
  requestedBy: null,
  requestedAt: null,
  finishedAt: null,
  message: null,
};
// What systemd says about each unit: Atlas up for an hour, the proxy failed, no database service, the rest unasked.
const shown: Record<string, Record<string, string> | null> = {
  'msp-atlas.service': {
    LoadState: 'loaded',
    ActiveState: 'active',
    SubState: 'running',
    // Started one hour after the server did; the server has been up for two.
    ActiveEnterTimestampMonotonic: String(3600 * 1_000_000),
  },
  'caddy.service': {
    LoadState: 'loaded',
    ActiveState: 'failed',
    SubState: 'failed',
    ActiveEnterTimestampMonotonic: '0',
  },
  'postgresql.service': { LoadState: 'not-found', ActiveState: 'inactive', SubState: 'dead' },
  'msp-atlas-updater.path': null,
};
const show: ShowUnit = async (unit) => shown[unit] ?? null;
const inbox = (dir: string) => join(dir, 'inbox', 'request.json');
const put = (path: string, body: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
};

describe('SystemServices', () => {
  let dir: string;
  let update: UpdateRun;
  const make = (extra: Partial<ConstructorParameters<typeof SystemServices>[0]> = {}) =>
    new SystemServices({
      dir,
      updates: { run: async () => update },
      show,
      now: () => NOW,
      uptime: () => 7200,
      ...extra,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-services-'));
    update = noUpdate;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads each service’s state from systemd, and when a running one started', async () => {
    expect(await make().services()).toEqual([
      {
        id: 'atlas',
        name: 'Atlas',
        unit: 'msp-atlas.service',
        state: 'running',
        since: '2026-10-13T11:00:00.000Z',
        restart: 'restart-atlas',
      },
      { id: 'proxy', name: 'Web proxy', unit: 'caddy.service', state: 'failed', since: null, restart: 'restart-proxy' },
      {
        id: 'database',
        name: 'Database',
        unit: 'postgresql.service',
        state: 'missing',
        since: null,
        restart: 'restart-database',
      },
      { id: 'updater', name: 'Updater', unit: 'msp-atlas-updater.path', state: 'unknown', since: null, restart: null },
    ]);
  });

  it('has nothing to show or do on a server without the helper', async () => {
    const none = make({ dir: undefined });
    expect(await none.overview(true)).toEqual({
      canAct: false,
      databaseReachable: true,
      services: [],
      run: { state: 'idle', action: null, requestedBy: null, requestedAt: null, finishedAt: null, message: null },
    });
    await expect(none.request('restart-atlas', 'Avery Owner')).rejects.toMatchObject({ status: 409 });
  });

  it('writes a request naming one of the known actions, and nothing else', async () => {
    const services = make();
    for (const bad of [undefined, '', 'reboot', 'restart-atlas; rm -rf /', { action: 'repair' }, ['repair']])
      await expect(services.request(bad, 'Avery Owner')).rejects.toMatchObject({ status: 400 });
    expect(existsSync(inbox(dir))).toBe(false);

    const run = await services.request('restart-proxy', 'Avery Owner');
    expect(run).toEqual({
      state: 'requested',
      action: 'restart-proxy',
      requestedBy: 'Avery Owner',
      requestedAt: '2026-10-13T12:00:00.000Z',
      finishedAt: null,
      message: null,
    });
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8'))).toEqual({
      kind: 'service',
      action: 'restart-proxy',
      requestedBy: 'Avery Owner',
      requestedAt: '2026-10-13T12:00:00.000Z',
    });
    expect((await services.run()).state).toBe('requested');
    // One thing at a time.
    await expect(services.request('repair', 'Avery Owner')).rejects.toMatchObject({ status: 409 });
    // Every action the page offers is one the helper is sent.
    expect(SERVICE_ACTIONS).toEqual(['restart-atlas', 'restart-proxy', 'restart-database', 'repair']);
  });

  it('waits for an update, and an update waits for it', async () => {
    update = { ...noUpdate, state: 'running', tag: 'v9.9.9' };
    await expect(make().request('restart-atlas', 'Avery Owner')).rejects.toMatchObject({
      status: 409,
      message: 'An update is in progress. Wait for it to finish.',
    });
    expect(existsSync(inbox(dir))).toBe(false);

    update = noUpdate;
    await make().request('restart-atlas', 'Avery Owner');
    const fetchReleases = (async () =>
      new Response(JSON.stringify([{ tag_name: 'v99.0.0', draft: false, prerelease: false }]))) as typeof fetch;
    const updates = new UpdateService({
      repo: 'ithealthtech/nexus-atlas',
      current: '1.0.0',
      dir,
      fetch: fetchReleases,
      now: () => NOW,
    });
    // The Updates page doesn't mistake the waiting service action for an update.
    expect((await updates.run()).state).toBe('idle');
    await expect(updates.request('v99.0.0', 'Avery Owner')).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8')).kind).toBe('service');
    // And the Services page doesn't mistake a waiting update for one of its own.
    rmSync(inbox(dir));
    await updates.request('v99.0.0', 'Avery Owner');
    expect((await make().run()).state).toBe('idle');
    expect((await updates.run()).state).toBe('requested');
  });

  it('leaves a few seconds between actions, so systemd never stops starting the helper', async () => {
    let now = NOW;
    const services = make({ now: () => now });
    const done = () =>
      put(join(dir, 'service.json'), {
        state: 'succeeded',
        action: 'restart-proxy',
        requestedBy: 'Avery Owner',
        requestedAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW + 800).toISOString(),
        message: 'The web proxy was restarted.',
        updatedAt: new Date(NOW + 800).toISOString(),
      });
    await services.request('restart-proxy', 'Avery Owner');
    // The helper took the request and finished within a second.
    rmSync(inbox(dir));
    done();
    now = NOW + 2000;
    await expect(services.request('restart-proxy', 'Avery Owner')).rejects.toMatchObject({
      status: 409,
      message: 'The server has just done something. Give it a few seconds, then try again.',
    });
    expect(existsSync(inbox(dir))).toBe(false);
    now = NOW + 5000;
    expect((await services.request('restart-proxy', 'Avery Owner')).state).toBe('requested');
  });

  it('reports what the helper wrote, and notices a run or a request that died', async () => {
    const services = make();
    const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
    const result = (state: string, extra: Record<string, unknown> = {}) =>
      put(join(dir, 'service.json'), {
        state,
        action: 'repair',
        requestedBy: 'Avery Owner',
        requestedAt: at(1),
        finishedAt: null,
        message: 'Repairing permissions and services, then restarting them.',
        updatedAt: at(1),
        ...extra,
      });

    result('running');
    expect(await services.run()).toMatchObject({ state: 'running', action: 'repair', requestedBy: 'Avery Owner' });
    await expect(services.request('restart-atlas', 'Avery Owner')).rejects.toMatchObject({ status: 409 });

    result('succeeded', {
      finishedAt: at(0),
      message: 'Permissions and services were repaired, and Atlas is answering.',
    });
    expect(await services.run()).toMatchObject({
      state: 'succeeded',
      message: 'Permissions and services were repaired, and Atlas is answering.',
    });

    // "Running" for longer than any action takes: the run was killed.
    result('running', { updatedAt: at(30) });
    expect(await services.run()).toMatchObject({ state: 'failed', action: 'repair' });
    // After that another action can be asked for.
    await services.request('restart-atlas', 'Avery Owner');
    expect(await services.run()).toMatchObject({ state: 'requested', action: 'restart-atlas' });

    // A request nobody picked up.
    put(inbox(dir), { kind: 'service', action: 'restart-atlas', requestedBy: 'Avery Owner', requestedAt: at(5) });
    const stuck = await services.run();
    expect(stuck.state).toBe('failed');
    expect(stuck.message).toContain('msp-atlas-updater.path');

    // Nothing the helper didn't write is believed.
    rmSync(inbox(dir));
    result('exploded', { action: 'format-disk' });
    expect((await services.run()).state).toBe('idle');
    result('failed', { action: 'format-disk', message: 'x'.repeat(5000) });
    const odd = await services.run();
    expect(odd.action).toBeNull();
    expect(odd.message).toHaveLength(2000);
  });
});

describe('service routes', () => {
  let t: TestApp;
  let owner: Browser;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-services-'));
    t = await startApp({ ATLAS_UPDATER_DIR: dir }, { serviceShow: show });
    ({ b: owner } = await setupOwner(t.app));
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows the services and asks for an action after a fresh password confirmation', async () => {
    const overview = await owner.call('GET', '/api/system/services');
    expect(overview.status).toBe(200);
    expect(overview.data).toMatchObject({ canAct: true, databaseReachable: true, run: { state: 'idle' } });
    expect(overview.data.services.map((s: { id: string; state: string }) => [s.id, s.state])).toEqual([
      ['atlas', 'running'],
      ['proxy', 'failed'],
      ['database', 'missing'],
      ['updater', 'unknown'],
    ]);

    await t.handle.db.execute(sql`update sessions set reauth_at = null`);
    const stale = await owner.call('POST', '/api/system/services/run', { action: 'restart-proxy' });
    expect([stale.status, stale.data.code]).toEqual([403, 'reauth']);
    expect(existsSync(inbox(dir))).toBe(false);

    await owner.call('POST', '/api/session/reauth', { password: OWNER.password });
    expect((await owner.call('POST', '/api/system/services/run', {})).status).toBe(400);
    expect((await owner.call('POST', '/api/system/services/run', { action: 'reboot' })).status).toBe(400);
    const asked = await owner.call('POST', '/api/system/services/run', { action: 'restart-proxy' });
    expect(asked.status, JSON.stringify(asked.data)).toBe(202);
    expect(asked.data).toMatchObject({ state: 'requested', action: 'restart-proxy', requestedBy: 'Avery Owner' });
    expect(JSON.parse(readFileSync(inbox(dir), 'utf8'))).toMatchObject({ kind: 'service', action: 'restart-proxy' });
    expect((await owner.call('GET', '/api/system/services')).data.run.state).toBe('requested');
    expect((await owner.call('POST', '/api/system/services/run', { action: 'repair' })).status).toBe(409);

    // Refused requests aren't logged; the one that went through is.
    const log = await t.handle.db.execute(
      sql`select action, detail from security_events where action = 'Service action requested'`,
    );
    expect(log.rows).toEqual([{ action: 'Service action requested', detail: 'Restart the web proxy' }]);
  });

  it('is for administrators signed in to Atlas', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/system/services' })).statusCode).toBe(401);

    await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess Tech',
      password: 'temporary pass 1234',
      role: 'technician',
    });
    const { b: tech } = await signIn(t.app, 'tess@atlas.test', 'temporary pass 1234');
    await tech.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    await enroll(tech);
    expect((await tech.call('GET', '/api/system/services')).status).toBe(403);
    expect((await tech.call('POST', '/api/system/services/run', { action: 'restart-atlas' })).status).toBe(403);

    const key = (await owner.call('POST', '/api/api-keys', { name: 'Sync', scopes: ['read', 'write', 'passwords'] }))
      .data;
    const viaKey = await t.app.inject({
      method: 'POST',
      url: '/api/v1/system/services/run',
      headers: { authorization: `Bearer ${key.token}` },
      payload: { action: 'restart-atlas' },
    });
    expect(viaKey.statusCode).toBe(403);
    expect(existsSync(inbox(dir))).toBe(false);
  });
});
