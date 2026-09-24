import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { UpdateService, compareVersions } from '../src/services/updates.js';
import { APP_VERSION } from '../src/version.js';
import { OWNER, setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `MSP Atlas ${tag}`,
  body: `Notes for ${tag}`,
  html_url: `https://github.com/ithealthtech/nexus-atlas/releases/tag/${tag}`,
  published_at: '2026-09-24T18:16:00Z',
  draft: false,
  prerelease: false,
  ...extra,
});

function fakeGitHub(list: unknown[], status = 200) {
  let calls = 0;
  const fn = (async () => {
    calls++;
    return new Response(JSON.stringify(list), { status });
  }) as typeof fetch;
  return { fn, calls: () => calls };
}

describe('compareVersions', () => {
  it('orders x.y.z numerically and ignores a leading v', () => {
    expect(compareVersions('v1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('v1.2.0', 'v1.10.0')).toBe(-1);
    expect(compareVersions('1.0.1', 'v1.0.1')).toBe(0);
  });
});

describe('UpdateService', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-updater-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists only published, newer, x.y.z releases, newest first, and caches the check', async () => {
    const gh = fakeGitHub([
      release('v1.0.1'),
      release('v1.0.3'),
      release('v1.1.0-beta', {}),
      release('v2.0.0', { prerelease: true }),
      release('v1.0.4', { draft: true }),
      release('v1.0.2'),
    ]);
    const service = new UpdateService({ repo: 'o/r', current: '1.0.1', dir, fetch: gh.fn });
    const info = await service.info();
    expect(info.available.map((r) => r.tag)).toEqual(['v1.0.3', 'v1.0.2']);
    expect(info.canApply).toBe(true);
    expect(info.run.state).toBe('idle');
    await service.info();
    expect(gh.calls()).toBe(1);
    await service.info(true);
    expect(gh.calls()).toBe(2);
  });

  it('reports a failed check without throwing', async () => {
    const service = new UpdateService({ repo: 'o/r', current: '1.0.1', fetch: fakeGitHub([], 503).fn });
    const info = await service.info();
    expect(info.checkError).toMatch(/503/);
    expect(info.available).toEqual([]);
    expect(info.canApply).toBe(false);
  });

  it('writes a request only for a newer published release, and only one at a time', async () => {
    const service = new UpdateService({
      repo: 'o/r',
      current: '1.0.1',
      dir,
      fetch: fakeGitHub([release('v1.0.2'), release('v1.0.0')]).fn,
    });
    await expect(service.request('v1.0.0', 'Owner')).rejects.toThrow(/newer/);
    await expect(service.request('v9.9.9', 'Owner')).rejects.toThrow(/newer/);
    await expect(service.request('v1.0.2; rm -rf /', 'Owner')).rejects.toThrow(/newer/);
    const run = await service.request('v1.0.2', 'Owner');
    expect(run.state).toBe('requested');
    expect(JSON.parse(readFileSync(join(dir, 'inbox', 'request.json'), 'utf8'))).toMatchObject({
      tag: 'v1.0.2',
      requestedBy: 'Owner',
    });
    await expect(service.request('v1.0.2', 'Owner')).rejects.toThrow(/already in progress/);
  });

  it('reads the updater status file', async () => {
    const service = new UpdateService({ repo: 'o/r', current: '1.0.1', dir, fetch: fakeGitHub([]).fn });
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ state: 'failed', tag: 'v1.0.2', message: 'npm ci failed' }),
    );
    expect(await service.run()).toMatchObject({ state: 'failed', tag: 'v1.0.2', message: 'npm ci failed' });
    writeFileSync(join(dir, 'status.json'), 'not json');
    expect((await service.run()).state).toBe('idle');
  });

  it('refuses to request without an updater', async () => {
    const service = new UpdateService({ repo: 'o/r', current: '1.0.1', fetch: fakeGitHub([release('v1.0.2')]).fn });
    await expect(service.request('v1.0.2', 'Owner')).rejects.toThrow(/no updater/);
  });
});

describe('update routes', () => {
  let t: TestApp;
  let owner: Browser;
  let dir: string;
  const newer = `v${APP_VERSION.replace(/\d+$/, (n) => String(Number(n) + 1))}`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'atlas-updater-'));
    t = await startApp({ ATLAS_UPDATER_DIR: dir }, { updateFetch: fakeGitHub([release(newer)]).fn });
    ({ b: owner } = await setupOwner(t.app));
  });
  afterEach(async () => {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('shows available releases and requests an update after a fresh password confirmation', async () => {
    const info = await owner.call('GET', '/api/updates');
    expect(info.status).toBe(200);
    expect(info.data.current).toBe(APP_VERSION);
    expect(info.data.available[0].tag).toBe(newer);

    await t.handle.db.execute(sql`update sessions set reauth_at = null`);
    const stale = await owner.call('POST', '/api/updates/apply', { tag: newer });
    expect(stale.data.code).toBe('reauth');
    expect(existsSync(join(dir, 'inbox', 'request.json'))).toBe(false);

    await owner.call('POST', '/api/session/reauth', { password: OWNER.password });
    const applied = await owner.call('POST', '/api/updates/apply', { tag: newer });
    expect(applied.status, JSON.stringify(applied.data)).toBe(202);
    expect(JSON.parse(readFileSync(join(dir, 'inbox', 'request.json'), 'utf8')).tag).toBe(newer);
    expect((await owner.call('GET', '/api/updates')).data.run.state).toBe('requested');

    const log = await t.handle.db.execute(
      sql`select action, detail from security_events where action = 'Update requested'`,
    );
    expect(log.rows).toEqual([{ action: 'Update requested', detail: newer }]);
  });

  it('rejects a missing or malformed tag', async () => {
    expect((await owner.call('POST', '/api/updates/apply', {})).status).toBe(400);
    expect((await owner.call('POST', '/api/updates/apply', { tag: 'x'.repeat(100) })).status).toBe(400);
  });

  it('requires a signed-in session', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/updates' })).statusCode).toBe(401);
  });
});
