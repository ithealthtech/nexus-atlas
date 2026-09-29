import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { complexityProblem } from '@atlas/shared';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { VaultKeys } from '../src/crypto/vault-keys.js';
import { MailService } from '../src/services/mail.js';
import { RotationService } from '../src/services/rotation.js';
import { SettingsService } from '../src/services/settings.js';
import { VaultService } from '../src/services/vault.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const CLIENT_ID = 'asio-client-id-123';
const SECRET = 'asio-secret-value-456';
const OLD = 'Old-Local-Admin-Pass-2025!';
const NEW = 'Xk7#pQ2!mZ9$wR4&vT8@nL3%';
const TEMP = 'temporary pass 1234';

/** A fake Asio API: sign-in, companies, and the automation task call that runs the rotation script. */
function fakeAsio() {
  const state = {
    tasks: [] as { scriptId: string; targets: unknown; parameters: Record<string, string> }[],
    refuse: false,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/token') {
      const body = JSON.parse(String(init?.body));
      if (body.client_id !== CLIENT_ID || body.client_secret !== SECRET) return json({ error: 'invalid_client' }, 401);
      return json({ access_token: `tok ${body.scope}`, expires_in: 3600 });
    }
    const auth = (init?.headers as Record<string, string>).Authorization ?? '';
    if (url.pathname === '/api/platform/v1/company/companies') return json([{ id: 'c1', name: 'Harbor Dental Group' }]);
    if (url.pathname === '/api/platform/v1/automation/tasks') {
      if (!auth.includes('platform.automation.create')) return json({ message: 'missing scope' }, 403);
      if (state.refuse) return json({ message: 'script not found' }, 404);
      const body = JSON.parse(String(init?.body));
      state.tasks.push({
        scriptId: body.scriptId,
        targets: body.targets,
        parameters: Object.fromEntries(body.parameters.map((p: { name: string; value: string }) => [p.name, p.value])),
      });
      return json({ id: `task-${state.tasks.length}` }, 201);
    }
    return json({}, 404);
  }) as typeof fetch;
  return { state, fetcher };
}

describe('automated password rotation', () => {
  let t: TestApp;
  let owner: Browser;
  let asio: ReturnType<typeof fakeAsio>;
  let rotation: RotationService;
  let harbor: string;
  let northline: string;
  let device: string;
  let password: string;
  const keys = staticKeyProvider([randomBytes(32)]);

  beforeEach(async () => {
    asio = fakeAsio();
    t = await startApp({}, { cwRmmFetch: asio.fetcher, keys });
    owner = (await setupOwner(t.app)).b;
    // The same services the app runs, to drive the schedule without waiting for its timer.
    const settings = new SettingsService(t.handle.db, keys);
    rotation = new RotationService(t.handle.db, {
      vault: new VaultService(new VaultKeys(t.handle.db, keys)),
      settings,
      mail: new MailService(settings, async () => undefined),
      publicOrigin: 'http://localhost',
      fetcher: asio.fetcher,
    });

    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    expect(
      (
        await owner.call('PUT', '/api/integrations/cw-rmm', {
          clientId: CLIENT_ID,
          clientSecret: SECRET,
          autoSync: false,
        })
      ).status,
    ).toBe(200);
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
    // A device as a sync leaves it: a Configurations asset linked to its RMM endpoint.
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const configuration = layouts.find((l) => l.key === 'configuration')!.id;
    device = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: configuration,
        name: 'HDG-WS-07',
        fields: {},
      })
    ).data.id;
    const org = (await t.handle.db.select().from(schema.orgs))[0]!.id;
    await t.handle.db
      .insert(schema.externalRefs)
      .values({ orgId: org, source: 'cw-rmm', kind: 'assets', externalId: 'e7', entityId: device });
    password = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, {
        name: 'HDG-WS-07 local admin',
        username: 'HDG-WS-07\\Administrator',
        secret: OLD,
      })
    ).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const turnOn = async () => {
    // Refused settings are not saved.
    expect((await owner.call('PUT', '/api/rotation/settings', { enabled: true, scriptId: '' })).status).toBe(400);
    expect((await owner.call('GET', '/api/rotation/settings')).data).toEqual({ enabled: false, scriptId: '' });
    expect((await owner.call('PUT', '/api/rotation/settings', { enabled: true, scriptId: 'script-42' })).status).toBe(
      200,
    );
    const policy = await owner.call('PUT', '/api/rotation/policies', {
      clientId: null,
      accountType: 'local_admin',
      intervalDays: 30,
      complexity: { length: 20 },
    });
    expect(policy.status, JSON.stringify(policy.data)).toBe(200);
  };
  const enrollDevice = async () => {
    const target = await owner.call('POST', '/api/rotation/targets', {
      passwordId: password,
      assetId: device,
      accountType: 'local_admin',
    });
    expect(target.status, JSON.stringify(target.data)).toBe(201);
    return target.data.id as string;
  };
  const start = async (targetId: string) => {
    const run = await owner.call('POST', `/api/rotation/targets/${targetId}/rotate`, {});
    expect(run.status, JSON.stringify(run.data)).toBe(202);
    return { run: run.data, token: asio.state.tasks.at(-1)!.parameters.Token! };
  };
  const agent = (path: 'candidate' | 'result', token: string, body: unknown) =>
    t.app.inject({
      method: 'POST',
      url: `/api/rotation/agent/${path}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body as object,
    });
  const reveal = async () =>
    (await owner.call('POST', `/api/passwords/${password}/reveal`, { field: 'secret' })).data.value;
  const events = async () =>
    (await t.handle.db.select({ action: schema.securityEvents.action }).from(schema.securityEvents)).map(
      (e) => e.action,
    );

  it('runs the script on the device and saves the new password only once the device confirms it', async () => {
    await turnOn();
    const targetId = await enrollDevice();
    const { run, token } = await start(targetId);
    expect(run).toMatchObject({ status: 'dispatched', passwordName: 'HDG-WS-07 local admin', assetName: 'HDG-WS-07' });
    const task = asio.state.tasks[0]!;
    expect(task.scriptId).toBe('script-42');
    expect(task.targets).toEqual([{ type: 'endpoint', id: 'e7' }]);
    expect(task.parameters).toMatchObject({
      AccountType: 'local_admin',
      Account: 'HDG-WS-07\\Administrator',
      Length: '20',
      Symbols: '1',
    });
    // The script's parameters never carry a password, only the attempt's token.
    expect(JSON.stringify(task)).not.toContain(OLD);

    // A password that breaks the policy is refused, so the script stops before changing anything.
    expect((await agent('candidate', token, { password: 'short' })).statusCode).toBe(400);
    expect((await agent('result', token, { ok: true })).statusCode).toBe(409);
    expect((await agent('candidate', token, { password: NEW })).statusCode).toBe(200);
    // Only the first report counts: a stolen token can't swap in its own password.
    expect((await agent('candidate', token, { password: `${NEW}x` })).statusCode).toBe(409);
    // Reported but not confirmed: the vault still has the old one, and the new one isn't stored in the clear.
    expect(await reveal()).toBe(OLD);
    const stored = await t.handle.db.execute(sql`select candidate from rotation_runs`);
    expect(JSON.stringify(stored.rows)).not.toContain(NEW);

    expect((await agent('result', token, { ok: true })).statusCode).toBe(200);
    expect(await reveal()).toBe(NEW);
    const history = (await owner.call('GET', `/api/passwords/${password}/history`)).data;
    expect(history[0].changedByName).toBe('Automatic rotation');
    expect(
      (await owner.call('POST', `/api/passwords/${password}/history/${history[0].id}/reveal`, {})).data.value,
    ).toBe(OLD);
    const audit = (await owner.call('GET', `/api/passwords/${password}/audit`)).data as { action: string }[];
    expect(audit.map((a) => a.action)).toContain('Changed password (automatic rotation)');
    expect(await events()).toContain('Password rotated automatically');

    // The token dies with the attempt.
    expect((await agent('result', token, { ok: true })).statusCode).toBe(401);
    const [target] = (await owner.call('GET', '/api/rotation/targets')).data;
    expect(target).toMatchObject({ lastStatus: 'succeeded', intervalDays: 30 });
    expect(target.lastRotatedAt).not.toBeNull();
  });

  it('keeps the old password and raises an alert when the device fails', async () => {
    await turnOn();
    const targetId = await enrollDevice();
    const { token } = await start(targetId);
    expect((await agent('candidate', token, { password: NEW })).statusCode).toBe(200);
    expect((await agent('result', token, { ok: false, error: 'Access is denied.' })).statusCode).toBe(200);
    expect(await reveal()).toBe(OLD);
    const [run] = (await owner.call('GET', '/api/rotation/runs')).data;
    expect(run).toMatchObject({ status: 'failed', error: 'Access is denied.' });
    expect(await events()).toContain('Password rotation failed');
    const audit = (await owner.call('GET', `/api/passwords/${password}/audit`)).data as { action: string }[];
    expect(audit.map((a) => a.action)).toContain('Automatic rotation failed; the password was not changed');
    // The device said it didn't change the account, so its password isn't kept.
    expect((await owner.call('GET', `/api/passwords/${password}/history`)).data).toHaveLength(0);
  });

  it('fails an attempt the device never confirms, keeping what it reported in history', async () => {
    await turnOn();
    const targetId = await enrollDevice();
    const { token } = await start(targetId);
    expect((await agent('candidate', token, { password: NEW })).statusCode).toBe(200);
    await rotation.tick((await t.handle.db.select().from(schema.orgs))[0]!.id, new Date(Date.now() + 3 * 3_600_000));
    expect(await reveal()).toBe(OLD);
    expect((await owner.call('GET', '/api/rotation/runs')).data[0]).toMatchObject({ status: 'failed' });
    const history = (await owner.call('GET', `/api/passwords/${password}/history`)).data;
    expect(history[0].changedByName).toBe('Automatic rotation (unconfirmed, not applied)');
    expect(
      (await owner.call('POST', `/api/passwords/${password}/history/${history[0].id}/reveal`, {})).data.value,
    ).toBe(NEW);
    expect((await agent('result', token, { ok: true })).statusCode).toBe(401);
  });

  it('revokes outstanding device tokens', async () => {
    await turnOn();
    const targetId = await enrollDevice();
    const { token } = await start(targetId);
    expect((await owner.call('POST', '/api/rotation/revoke-tokens', {})).data).toEqual({ revoked: 1 });
    expect((await agent('candidate', token, { password: NEW })).statusCode).toBe(401);
    expect((await owner.call('GET', '/api/rotation/runs')).data[0]).toMatchObject({ status: 'cancelled' });
    // Garbage tokens get the same answer as revoked ones.
    expect((await agent('candidate', 'atlasrot_' + 'A'.repeat(43), { password: NEW })).statusCode).toBe(401);
    expect((await agent('candidate', 'nonsense', { password: NEW })).statusCode).toBe(401);
    expect(await reveal()).toBe(OLD);

    // Cancelling after the device reported its password keeps that password in history, in case it was set.
    const second = await start(targetId);
    expect((await agent('candidate', second.token, { password: NEW })).statusCode).toBe(200);
    await owner.call('POST', `/api/rotation/runs/${second.run.id}/cancel`, {});
    const history = (await owner.call('GET', `/api/passwords/${password}/history`)).data;
    expect(history).toHaveLength(1);
    expect((await agent('result', second.token, { ok: true })).statusCode).toBe(401);
    expect(await reveal()).toBe(OLD);
    // An archived password isn't rotated.
    await owner.call('POST', `/api/passwords/${password}/archive`, { archived: true });
    expect((await owner.call('POST', `/api/rotation/targets/${targetId}/rotate`, {})).status).toBe(400);
  });

  it('refuses a reported password moved to another attempt (sealed to its own)', async () => {
    await turnOn();
    const targetId = await enrollDevice();
    const first = await start(targetId);
    expect((await agent('candidate', first.token, { password: NEW })).statusCode).toBe(200);
    const [{ candidate }] = (await t.handle.db.execute(sql`select candidate from rotation_runs`)).rows as {
      candidate: string;
    }[];
    await owner.call('POST', `/api/rotation/runs/${first.run.id}/cancel`, {});
    const second = await start(targetId);
    expect((await agent('candidate', second.token, { password: `${NEW}-other` })).statusCode).toBe(200);
    await t.handle.db.update(schema.rotationRuns).set({ candidate }).where(eq(schema.rotationRuns.id, second.run.id));
    expect((await agent('result', second.token, { ok: true })).statusCode).toBeGreaterThanOrEqual(400);
    expect(await reveal()).toBe(OLD);
  });

  it('starts due rotations on schedule, following the client’s own policy over the default', async () => {
    const org = (await t.handle.db.select().from(schema.orgs))[0]!.id;
    const targetId = await enrollDevice();
    // Off: nothing starts.
    expect(await rotation.tick(org)).toEqual({ started: 0 });
    await turnOn();
    // The client's own policy wins; paused, it stops this client's rotations.
    await owner.call('PUT', '/api/rotation/policies', {
      clientId: harbor,
      accountType: 'local_admin',
      intervalDays: 7,
      enabled: false,
    });
    expect(await rotation.tick(org)).toEqual({ started: 0 });
    await owner.call('PUT', '/api/rotation/policies', {
      clientId: harbor,
      accountType: 'local_admin',
      intervalDays: 7,
    });
    expect(await rotation.tick(org)).toEqual({ started: 1 });
    // One attempt at a time.
    expect(await rotation.tick(org)).toEqual({ started: 0 });
    const token = asio.state.tasks[0]!.parameters.Token!;
    await agent('candidate', token, { password: NEW });
    await agent('result', token, { ok: true });
    expect((await owner.call('GET', '/api/rotation/targets')).data[0]).toMatchObject({ id: targetId, intervalDays: 7 });
    // Not due again until the interval passes.
    expect(await rotation.tick(org, new Date(Date.now() + 6 * 86_400_000))).toEqual({ started: 0 });
    expect(await rotation.tick(org, new Date(Date.now() + 8 * 86_400_000))).toEqual({ started: 1 });
  });

  it('waits a day after an attempt that could not start, and says why', async () => {
    const org = (await t.handle.db.select().from(schema.orgs))[0]!.id;
    await turnOn();
    await enrollDevice();
    asio.state.refuse = true;
    expect(await rotation.tick(org)).toEqual({ started: 1 });
    const [run] = (await owner.call('GET', '/api/rotation/runs')).data;
    expect(run.status).toBe('failed');
    expect(run.error).toContain('script not found');
    asio.state.refuse = false;
    expect(await rotation.tick(org, new Date(Date.now() + 3_600_000))).toEqual({ started: 0 });
    expect(await rotation.tick(org, new Date(Date.now() + 25 * 3_600_000))).toEqual({ started: 1 });
  });

  it('only pairs a password with a synced device in the same client', async () => {
    await turnOn();
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const configuration = layouts.find((l) => l.key === 'configuration')!.id;
    const other = (
      await owner.call('POST', `/api/clients/${northline}/assets`, {
        layoutId: configuration,
        name: 'NLA-WS-01',
        fields: {},
      })
    ).data.id;
    const unsynced = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: configuration,
        name: 'HDG-WS-99',
        fields: {},
      })
    ).data.id;
    // Only synced devices are offered, and only for the client asked about.
    expect((await owner.call('GET', `/api/rotation/clients/${harbor}/devices`)).data).toEqual([
      { id: device, name: 'HDG-WS-07' },
    ]);
    expect((await owner.call('GET', `/api/rotation/clients/${northline}/devices`)).data).toEqual([]);
    const body = { passwordId: password, accountType: 'local_admin' };
    expect((await owner.call('POST', '/api/rotation/targets', { ...body, assetId: other })).status).toBe(404);
    expect((await owner.call('POST', '/api/rotation/targets', { ...body, assetId: unsynced })).status).toBe(400);
    await enrollDevice();
    expect((await owner.call('POST', '/api/rotation/targets', { ...body, assetId: device })).status).toBe(409);
  });

  it('is for administrators only, and the device routes take only a token', async () => {
    await turnOn();
    const targetId = await enrollDevice();
    const created = await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tech',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const { b: tech } = await signIn(t.app, 'tech@atlas.test', TEMP);
    const changed = await tech.call('POST', '/api/account/password', { current: TEMP, next: 'rotation staff pass 5' });
    expect(changed.status, JSON.stringify(changed.data)).toBe(200);
    await enroll(tech);
    for (const [method, url] of [
      ['GET', '/api/rotation/targets'],
      ['GET', '/api/rotation/runs'],
      ['GET', '/api/rotation/policies'],
      ['POST', `/api/rotation/targets/${targetId}/rotate`],
      ['POST', '/api/rotation/revoke-tokens'],
    ] as const)
      expect((await tech.call(method, url, method === 'GET' ? undefined : {})).status, url).toBe(403);
    // Device routes don't take a session in place of a token.
    expect((await owner.call('POST', '/api/rotation/agent/candidate', { password: NEW })).status).toBe(401);
  });

  it('checks reported passwords against the policy', () => {
    const policy = { length: 16, upper: true, lower: true, digits: true, symbols: false };
    expect(complexityProblem('abcdefghijklmnopQ1', policy)).toBeNull();
    expect(complexityProblem('abcdefghijklmnopq1', policy)).toContain('upper-case');
    expect(complexityProblem('Ab1', policy)).toContain('shorter');
  });
});
