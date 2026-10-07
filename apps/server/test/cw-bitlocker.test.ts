import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const CLIENT_ID = 'asio-client-id-123';
const SECRET = 'asio-secret-value-456';
const KEY_C = '111111-222222-333333-444444-555555-666666-077077-123453';
const KEY_D = '000011-000022-000033-000044-000055-000066-000077-000088';
const KEY_NEW = '000099-000110-000121-000132-000143-000154-000165-000176';

/** A fake Asio API with two devices and their custom fields. */
function fakeAsio() {
  const state = {
    calls: [] as string[],
    // Whether the key may read custom fields.
    customFields: true,
    fields: new Map<string, { name: string; attributeId: string; value: string }[]>([
      [
        'e1',
        [
          { name: 'Atlas link', attributeId: 'a1', value: 'https://atlas.example.com/assets/x' },
          {
            name: 'Disk encryption',
            attributeId: 'a2',
            value: `C: ID: {4F2A9C1E-7B44-4D0E-9A51-0C6E2B8D1F77} Password: ${KEY_C}\nD: ID: {AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE} Password: ${KEY_D}`,
          },
        ],
      ],
      ['e2', [{ name: 'Disk encryption', attributeId: 'a2', value: 'Not encrypted' }]],
    ]),
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    state.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname === '/v1/token') return json({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' });
    if (url.pathname === '/api/platform/v1/company/companies') return json([{ id: 'c1', name: 'Harbor Dental Group' }]);
    if (/^\/api\/platform\/v1\/company\/companies\/\w+\/sites$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/platform/v2/device/categories/all/endpoints') {
      const request = JSON.parse(String(init?.body));
      if (request.resourceType !== 'company') return json({ message: 'invalid resource type' }, 400);
      return json({
        endpoints: Number(url.searchParams.get('cursor'))
          ? []
          : [
              { endpointId: 'e1', friendlyName: 'HDG-DC-01', endpointType: 'Server' },
              { endpointId: 'e2', friendlyName: 'HDG-WS-01', endpointType: 'Desktop' },
            ],
      });
    }
    const custom = url.pathname.match(/^\/api\/platform\/v2\/device\/endpoints\/(\w+)\/custom-fields$/);
    if (custom)
      return state.customFields ? json(state.fields.get(custom[1]!) ?? []) : json({ message: 'Forbidden' }, 403);
    return json({}, 404);
  }) as typeof fetch;
  return { state, fetcher };
}

async function waitForJob(b: Browser, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

type Entry = { id: string; name: string; kind: string; username: string };

describe('BitLocker recovery keys from ConnectWise RMM custom fields', () => {
  let t: TestApp;
  let owner: Browser;
  let asio: ReturnType<typeof fakeAsio>;
  let harbor: string;
  const sync = async () => waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);
  const keys = async () =>
    ((await owner.call('GET', `/api/passwords?client=${harbor}`)).data as Entry[])
      .filter((p) => p.kind === 'bitlocker')
      .sort((a, b) => a.name.localeCompare(b.name));

  beforeEach(async () => {
    asio = fakeAsio();
    t = await startApp({}, { cwRmmFetch: asio.fetcher });
    owner = (await setupOwner(t.app)).b;
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [{ companyId: 'c1', action: 'link', clientId: harbor }],
    });
  });
  afterEach(async () => {
    await t.close();
  });

  it('is off until chosen, then saves each key to the vault once, linked to its device', async () => {
    await sync();
    expect(asio.state.calls.some((c) => c.endsWith('/custom-fields'))).toBe(false);
    expect(await keys()).toHaveLength(0);

    const options = (await owner.call('GET', '/api/integrations/cw-rmm')).data.options;
    expect(options.bitlocker).toBe(false);
    await owner.call('PUT', '/api/integrations/cw-rmm/options', { ...options, bitlocker: true });
    const job = await sync();
    expect(job.status).toBe('done');
    expect(job.counts.bitlocker.created).toBe(2);
    // The job log names devices and fields, never a key.
    expect(JSON.stringify(job)).not.toContain(KEY_C.slice(0, 13));

    const saved = await keys();
    expect(saved.map((p) => [p.name, p.username])).toEqual([
      ['HDG-DC-01 · C:', '4F2A9C1E-7B44-4D0E-9A51-0C6E2B8D1F77'],
      ['HDG-DC-01 · D:', 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE'],
    ]);
    expect((await owner.call('POST', `/api/passwords/${saved[0]!.id}/reveal`, {})).data.value).toBe(KEY_C);
    // Stored as ciphertext only.
    const raw = await t.handle.pool.query('select * from passwords');
    expect(JSON.stringify(raw.rows)).not.toContain(KEY_C);

    const assets = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as {
      id: string;
      name: string;
      fields: Record<string, unknown>;
    }[];
    const dc = assets.find((a) => a.name === 'HDG-DC-01')!;
    const related = (await owner.call('GET', `/api/items/asset/${dc.id}/relations`)).data as { title: string }[];
    expect(related.map((r) => r.title).sort()).toEqual(['HDG-DC-01 · C:', 'HDG-DC-01 · D:']);
    // Nothing of a key in any asset's fields.
    expect(JSON.stringify(assets)).not.toContain(KEY_C);

    // Unchanged keys aren't saved again; a new key for a drive is added and the old one kept.
    expect((await sync()).counts.bitlocker.created ?? 0).toBe(0);
    asio.state.fields.get('e1')![1]!.value = `C: Password: ${KEY_NEW}`;
    expect((await sync()).counts.bitlocker.created).toBe(1);
    expect(await keys()).toHaveLength(3);
  });

  it('moves a key found in an asset field into the vault, and says so when custom fields cannot be read', async () => {
    await sync();
    const asset = (
      (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { id: string; name: string }[]
    ).find((a) => a.name === 'HDG-WS-01')!;
    // A key that an import or a person left in one of the asset's text fields, in plain text.
    const detail = (await owner.call('GET', `/api/assets/${asset.id}`)).data as {
      layoutId: string;
      fields: Record<string, unknown>;
    };
    const layouts = (await owner.call('GET', '/api/layouts')).data as {
      id: string;
      fields: { key: string; type: string }[];
    }[];
    const field = layouts
      .find((l) => l.id === detail.layoutId)!
      .fields.find((f) => f.type === 'text' && f.key !== 'manufacturer' && !(f.key in detail.fields))!.key;
    await t.handle.pool.query(
      `update assets set fields = fields || jsonb_build_object($2::text, $3::text) where id = $1`,
      [asset.id, field, `Front desk. Recovery: ${KEY_D}`],
    );
    const options = (await owner.call('GET', '/api/integrations/cw-rmm')).data.options;
    await owner.call('PUT', '/api/integrations/cw-rmm/options', { ...options, bitlocker: true, devices: false });
    asio.state.customFields = false;
    const job = await sync();
    expect(job.status).toBe('done');
    expect(job.messages.join(' ')).toMatch(/BitLocker keys not read from ConnectWise device custom fields/);
    expect(job.messages.join(' ')).toMatch(/Moved BitLocker recovery keys out of 1 asset/);

    const saved = await keys();
    expect(saved.map((p) => p.name)).toEqual(['HDG-WS-01 · BitLocker']);
    expect((await owner.call('POST', `/api/passwords/${saved[0]!.id}/reveal`, {})).data.value).toBe(KEY_D);
    const after = (await owner.call('GET', `/api/assets/${asset.id}`)).data;
    expect(after.fields[field]).toBe('Front desk. Recovery');
  });
});
