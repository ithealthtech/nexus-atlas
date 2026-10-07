import { constants, createPublicKey, publicEncrypt, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const KEY_C = '111111-222222-333333-444444-555555-666666-077077-123453';
const KEY_D = '000011-000022-000033-000044-000055-000066-000077-000088';
const KEY_NEW = '000099-000110-000121-000132-000143-000154-000165-000176';
const PROTECTOR_C = '4f2a9c1e-7b44-4d0e-9a51-0c6e2b8d1f77';
const MACHINE = '6f1c2e9a-1111-4222-8333-444455556666';

/** What the script would hold: read out of the script an enrollment returns, as the RMM would run it. */
function agentFrom(script: string) {
  const value = (name: string) => new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(script)![1]!;
  const url = (b64: string) => Buffer.from(b64, 'base64').toString('base64url');
  const key = createPublicKey({
    key: { kty: 'RSA', n: url(value('modulus')), e: url(value('exponent')) },
    format: 'jwk',
  });
  return {
    agentId: value('agentId'),
    endpoint: value('endpoint'),
    token: value('uploadToken'),
    seal: (plain: string) =>
      publicEncrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(plain),
      ).toString('base64'),
  };
}
type Agent = ReturnType<typeof agentFrom>;

describe('BitLocker collector', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const enrollment = async (body: Record<string, unknown> = {}) => {
    const made = await owner.call('POST', '/api/bitlocker/enrollments', {
      clientId: harbor,
      name: 'All workstations',
      ...body,
    });
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    return {
      id: made.data.enrollment.id as string,
      agent: agentFrom(made.data.script),
      script: made.data.script as string,
    };
  };
  const report = (
    agent: Agent,
    over: Record<string, unknown> = {},
    volumes: { mount: string; protection: string; keys: [string, string][] }[] = [
      { mount: 'C:', protection: 'On', keys: [[PROTECTOR_C, KEY_C]] },
    ],
  ) => ({
    version: 1,
    reportId: randomUUID(),
    agentId: agent.agentId,
    collectedAt: new Date().toISOString(),
    machineId: MACHINE,
    hostname: 'HDG-WS-01',
    os: 'Microsoft Windows 11 Pro',
    serialNumber: '5CG1234XYZ',
    volumes: volumes.map((v) => ({
      volumeId: `vol-${v.mount}`,
      mountPoint: v.mount,
      protection: v.protection,
      encryptionMethod: v.protection === 'On' ? 'XTS-AES-256' : 'None',
      encryptionPercentage: v.protection === 'On' ? 100 : 0,
      conversionStatus: v.protection === 'On' ? 'Fully encrypted' : 'Fully decrypted',
      protectors: v.keys.map(([keyId, key]) => ({ keyId, cipher: agent.seal(key) })),
    })),
    ...over,
  });
  /** A request as the script makes it: a bearer token, no cookies, no origin. */
  const upload = async (agent: Agent, body: unknown, headers: Record<string, string> = {}) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/bitlocker/ingest',
      headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(body),
    });
    return { status: res.statusCode, data: res.json() };
  };
  const keys = async () =>
    (
      (await owner.call('GET', `/api/passwords?client=${harbor}`)).data as {
        id: string;
        name: string;
        kind: string;
        username: string;
      }[]
    )
      .filter((p) => p.kind === 'bitlocker')
      .sort((a, b) => a.name.localeCompare(b.name));

  it('enrolls a client, takes in a report, and saves the key to the vault linked to the machine’s asset', async () => {
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const asset = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: layouts.find((l) => l.key === 'configuration')!.id,
        name: 'Front desk PC',
        fields: { serial_number: '5cg1234xyz' },
      })
    ).data;
    const { agent, script } = await enrollment();
    expect(agent.endpoint).toBe('http://localhost/api/bitlocker/ingest');
    // Only a hash of the token and a sealed private key are kept.
    const stored = JSON.stringify((await t.handle.pool.query('select * from bitlocker_enrollments')).rows);
    expect(stored).not.toContain(agent.token);
    expect(stored).not.toContain('PRIVATE KEY');
    expect(script).toContain('MSP Atlas BitLocker collector');

    const sent = await upload(
      agent,
      report(agent, {}, [
        { mount: 'C:', protection: 'On', keys: [[PROTECTOR_C, KEY_C]] },
        { mount: 'D:', protection: 'Off', keys: [] },
      ]),
    );
    expect(sent).toEqual({ status: 200, data: { accepted: true, keys: 1 } });

    const saved = await keys();
    expect(saved.map((p) => [p.name, p.username])).toEqual([['HDG-WS-01 · C:', PROTECTOR_C.toUpperCase()]]);
    expect((await owner.call('POST', `/api/passwords/${saved[0]!.id}/reveal`, {})).data.value).toBe(KEY_C);
    expect(JSON.stringify((await t.handle.pool.query('select * from passwords')).rows)).not.toContain(KEY_C);
    expect(JSON.stringify((await t.handle.pool.query('select * from bitlocker_devices')).rows)).not.toContain(KEY_C);

    // Matched to the asset by serial number, whatever the asset is called.
    const related = (await owner.call('GET', `/api/items/asset/${asset.id}/relations`)).data as { title: string }[];
    expect(related.map((r) => r.title)).toEqual(['HDG-WS-01 · C:']);
    const status = (await owner.call('GET', `/api/assets/${asset.id}/bitlocker`)).data;
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ hostname: 'HDG-WS-01', status: 'unprotected', assetId: asset.id });
    expect(status[0].volumes).toMatchObject([
      { mountPoint: 'C:', protection: 'On', keys: 1 },
      { mountPoint: 'D:', protection: 'Off', keys: 0 },
    ]);

    const view = (await owner.call('GET', '/api/bitlocker/collector')).data;
    expect(view.enrollments).toMatchObject([{ name: 'All workstations', scope: 'client', devices: 1, revoked: false }]);
    expect(view.devices).toMatchObject([{ hostname: 'HDG-WS-01', assetName: 'Front desk PC' }]);
    // Neither the token nor the keys come back from the list.
    expect(JSON.stringify(view)).not.toContain(agent.token);
  });

  it('saves each key once, keeps the newest status, and still saves a key from a late report', async () => {
    const { agent } = await enrollment();
    const first = report(agent);
    expect((await upload(agent, first)).data).toEqual({ accepted: true, keys: 1 });
    // The same report again (a retry after a lost acknowledgment) changes nothing.
    expect((await upload(agent, first)).data).toEqual({ accepted: false, duplicate: true });
    // The next run finds the same key: nothing new to save.
    expect((await upload(agent, report(agent))).data).toEqual({ accepted: true, keys: 0 });
    expect(await keys()).toHaveLength(1);

    // A report queued during an outage arrives after a newer one. Its key is kept; its status doesn't win.
    await upload(agent, report(agent, {}, [{ mount: 'C:', protection: 'On', keys: [[randomUUID(), KEY_NEW]] }]));
    const late = report(agent, { collectedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }, [
      { mount: 'C:', protection: 'Off', keys: [[randomUUID(), KEY_D]] },
    ]);
    expect((await upload(agent, late)).data).toEqual({ accepted: true, keys: 1 });
    expect(await keys()).toHaveLength(3);
    const [device] = (await owner.call('GET', '/api/bitlocker/collector')).data.devices;
    expect(device.status).toBe('protected');

    // One readable volume doesn't make a machine protected while another couldn't be read.
    await upload(
      agent,
      report(agent, {}, [
        { mount: 'C:', protection: 'On', keys: [] },
        { mount: 'F:', protection: 'Unknown', keys: [] },
      ]),
    );
    expect((await owner.call('GET', '/api/bitlocker/collector')).data.devices[0].status).toBe('unknown');

    // A key already in the vault under the same protector ID (typed in, or from the RMM field) isn't copied.
    const typed = '000187-000198-000209-000220-000231-000242-000253-000264';
    const protector = randomUUID();
    await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      kind: 'bitlocker',
      name: 'Typed in by hand',
      username: protector.toUpperCase(),
      secret: typed,
    });
    expect(
      (await upload(agent, report(agent, {}, [{ mount: 'E:', protection: 'On', keys: [[protector, typed]] }]))).data,
    ).toEqual({ accepted: true, keys: 0 });
    expect(await keys()).toHaveLength(4);
  });

  it('refuses anything that is not a valid report from a live enrollment', async () => {
    const { id, agent } = await enrollment();
    // No token, a wrong token, a browser.
    expect((await upload({ ...agent, token: '' }, report(agent))).status).toBe(401);
    expect((await upload({ ...agent, token: 'cd'.repeat(32) }, report(agent))).status).toBe(401);
    expect((await upload(agent, report(agent), { origin: 'http://localhost' })).status).toBe(403);
    expect((await upload(agent, report(agent), { cookie: owner.cookie })).status).toBe(403);
    // Another enrollment's ID, extra fields, a date in the future.
    expect((await upload(agent, report(agent, { agentId: randomUUID() }))).status).toBe(403);
    expect((await upload(agent, { ...report(agent), extra: true })).status).toBe(400);
    expect(
      (await upload(agent, report(agent, { collectedAt: new Date(Date.now() + 3600_000).toISOString() }))).status,
    ).toBe(400);
    // Something encrypted to the key that isn't a recovery password, and bytes that don't decrypt at all.
    const junk = report(agent, {}, [{ mount: 'C:', protection: 'On', keys: [[randomUUID(), 'DROP TABLE passwords']] }]);
    expect((await upload(agent, junk)).data).toEqual({ accepted: true, keys: 0, rejected: 1 });
    const garbled = report(agent);
    garbled.volumes[0]!.protectors[0]!.cipher = 'A'.repeat(512);
    expect((await upload(agent, garbled)).data).toEqual({ accepted: true, keys: 0, rejected: 1 });
    expect(await keys()).toHaveLength(0);

    // If saving fails part-way, the same report sent again is taken in full, not waved through as a duplicate.
    const pool = t.handle.pool;
    const [{ private_key: sealed }] = (
      await pool.query('select private_key from bitlocker_enrollments where id = $1', [id])
    ).rows as { private_key: string }[];
    await pool.query('update bitlocker_enrollments set private_key = $2 where id = $1', [id, 'v2:broken']);
    const interrupted = report(agent, {}, [{ mount: 'G:', protection: 'On', keys: [[randomUUID(), KEY_D]] }]);
    expect((await upload(agent, interrupted)).status).toBe(500);
    expect(await keys()).toHaveLength(0);
    await pool.query('update bitlocker_enrollments set private_key = $2 where id = $1', [id, sealed]);
    expect((await upload(agent, interrupted)).data).toEqual({ accepted: true, keys: 1 });
    expect((await upload(agent, interrupted)).data).toEqual({ accepted: false, duplicate: true });

    // A blocked machine, then a revoked enrollment. What's in the vault stays.
    expect((await upload(agent, report(agent))).data).toEqual({ accepted: true, keys: 1 });
    const [device] = (await owner.call('GET', '/api/bitlocker/collector')).data.devices;
    await owner.call('POST', `/api/bitlocker/devices/${device.id}/block`, { blocked: true });
    expect((await upload(agent, report(agent))).status).toBe(403);
    await owner.call('POST', `/api/bitlocker/devices/${device.id}/block`, { blocked: false });
    expect((await upload(agent, report(agent))).status).toBe(200);
    expect((await owner.call('DELETE', `/api/bitlocker/enrollments/${id}`)).data.enrollments[0].revoked).toBe(true);
    expect((await upload(agent, report(agent))).status).toBe(403);
    expect(await keys()).toHaveLength(2);
  });

  it('binds a one-device enrollment to its first machine, and is for administrators only', async () => {
    const { agent } = await enrollment({ name: 'Server', scope: 'device' });
    expect((await upload(agent, report(agent))).status).toBe(200);
    const other = report(agent, { machineId: randomUUID(), hostname: 'SOMEWHERE-ELSE' });
    expect((await upload(agent, other)).status).toBe(403);
    // A client-wide enrollment takes any number of machines.
    const shared = (await enrollment({ name: 'Everything' })).agent;
    expect((await upload(shared, report(shared))).status).toBe(200);
    expect((await upload(shared, report(shared, { machineId: randomUUID(), hostname: 'HDG-WS-02' }, []))).status).toBe(
      200,
    );
    expect((await owner.call('GET', '/api/bitlocker/collector')).data.devices).toHaveLength(3);

    const created = await owner.call('POST', '/api/users', {
      email: 'casey@atlas.test',
      name: 'Casey',
      password: 'temporary pass 1234',
      role: 'technician',
      allClients: 'edit',
    });
    expect(created.status).toBe(201);
    const { b: tech } = await signIn(t.app, 'casey@atlas.test', 'temporary pass 1234');
    await tech.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    await enroll(tech);
    expect((await tech.call('GET', '/api/bitlocker/collector')).status).toBe(403);
    expect((await tech.call('POST', '/api/bitlocker/enrollments', { clientId: harbor, name: 'x' })).status).toBe(403);
  });
});
