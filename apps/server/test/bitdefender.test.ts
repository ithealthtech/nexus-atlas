import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { bitdefenderAccessUrl, bitdefenderHealth } from '@atlas/shared';
import { endpointRow } from '../src/services/integrations/bitdefender.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const PERSONAL = 'personal-key-0123456789';
const SERVICE = 'service-key-0123456789';
const URL_ = 'https://cloud.gravityzone.bitdefender.com/api';
type Json = Record<string, unknown>;

/** A fake GravityZone: JSON-RPC on /api/v1.x/jsonrpc/<api>, personal keys by Basic auth, service keys by header. */
function fakeGravityZone() {
  const state = {
    calls: [] as string[],
    partner: true,
    endpoints: new Map<string, Json[]>([
      [
        'g1',
        [
          { id: 'e1', name: 'HDG-DC-01', fqdn: 'hdg-dc-01.harbor.local', macs: ['aabbccddee01'], ip: '10.0.0.10' },
          { id: 'e2', name: 'HDG-WS-02', fqdn: 'hdg-ws-02.harbor.local', macs: ['aabbccddee02'] },
          { id: 'e3', name: 'RECEPTION', fqdn: 'reception.harbor.local', macs: ['3c:52:82:1a:2b:3c'] },
          { id: 'e4', name: 'SPARE-LAPTOP', fqdn: '', macs: [] },
          // Another company's endpoint, which a partner-level listing can include.
          { id: 'e5', name: 'NLA-STRAY', fqdn: '', macs: [] },
        ],
      ],
      ['g2', [{ id: 'n1', name: 'NLA-WS-01', macs: [] }]],
    ]),
    details: new Map<string, Json>([
      [
        'e1',
        {
          name: 'HDG-DC-01',
          state: 1,
          lastSeen: new Date().toISOString(),
          malwareStatus: { infected: false, detection: false },
          agent: { licensed: 1, signatureOutdated: false, productOutdated: false, productVersion: '7.9.1' },
          policy: { name: 'Servers', applied: true },
          modules: { antimalware: true, firewall: true, edrSensor: true, encryption: false },
          riskScore: { value: '12%', impact: 'Low' },
        },
      ],
      [
        'e2',
        {
          name: 'HDG-WS-02',
          state: 1,
          lastSeen: new Date().toISOString(),
          malwareStatus: { infected: true, detection: true },
          agent: { licensed: 1, signatureOutdated: false },
          policy: { name: 'Workstations', applied: true },
        },
      ],
      [
        'e3',
        {
          name: 'RECEPTION',
          state: 2,
          lastSeen: new Date(Date.now() - 20 * 86_400_000).toISOString(),
          malwareStatus: {},
          agent: { licensed: 2, signatureOutdated: true },
          policy: { name: 'Workstations', applied: false },
        },
      ],
      [
        'e4',
        {
          name: 'SPARE-LAPTOP',
          state: 1,
          lastSeen: new Date().toISOString(),
          malwareStatus: {},
          agent: { licensed: 1, signatureOutdated: false },
          policy: { name: 'Workstations', applied: true },
        },
      ],
      ['n1', { name: 'NLA-WS-01', state: 1, lastSeen: new Date().toISOString(), agent: { licensed: 1 } }],
      ['e5', { name: 'NLA-STRAY', companyId: 'g2', state: 1, agent: { licensed: 1 } }],
    ]),
  };
  // A partner's tree: Harbor directly under it, Northline in a company folder, Cedar Ridge under a sub-partner.
  const children: Record<string, { companies: Json[]; partners: Json[]; folders: Json[] }> = {
    p0: {
      companies: [{ id: 'g1', name: 'Harbor Dental Group' }],
      partners: [{ id: 'p1', name: 'Coastal Reseller' }],
      folders: [{ id: 'f1', name: 'Architects' }],
    },
    f1: { companies: [{ id: 'g2', name: 'Northline Architecture' }], partners: [], folders: [] },
    p1: { companies: [{ id: 'g3', name: 'Cedar Ridge Credit Union' }], partners: [], folders: [] },
  };
  const reply = (id: unknown, body: Json, status = 200) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = init?.headers as Record<string, string>;
    const request = JSON.parse(String(init?.body)) as { id: unknown; method: string; params: Json };
    state.calls.push(`${url.pathname} ${request.method}`);
    const basic = headers.authorization === `Basic ${Buffer.from(`${PERSONAL}:`).toString('base64')}`;
    if (!basic && headers['x-api-key'] !== SERVICE) return reply(request.id, {}, 401);
    if (url.hostname !== 'cloud.gravityzone.bitdefender.com') return reply(request.id, {}, 404);
    const api = url.pathname.replace(/^\/api\/v1\.[01]\/jsonrpc\//, '');
    if (api === 'network' && ['getCompaniesList', 'getCompanyFoldersList'].includes(request.method)) {
      // A company's own key isn't allowed the partner methods.
      if (!state.partner) return reply(request.id, { error: { code: -32000, message: 'Not allowed' } }, 403);
      const node = children[String(request.params.parentId)];
      const partnersOnly = (request.params.filters as Json | undefined)?.companyType === 0;
      return reply(request.id, {
        result: !node
          ? []
          : request.method === 'getCompanyFoldersList'
            ? node.folders
            : partnersOnly
              ? node.partners
              : [...node.companies, ...node.partners],
      });
    }
    if (api === 'companies' && request.method === 'getCompanyDetails')
      return reply(request.id, {
        result: state.partner ? { id: 'p0', name: 'IT Done Right' } : { id: 'g1', name: 'Harbor Dental Group' },
      });
    if (api === 'network' && request.method === 'getEndpointsList') {
      expect(url.pathname).toContain('/v1.1/');
      const all = state.endpoints.get(String(request.params.parentId)) ?? [];
      const perPage = Number(request.params.perPage);
      const page = Number(request.params.page);
      const items = all.slice((page - 1) * perPage, page * perPage);
      return reply(request.id, {
        result: { items, page, perPage, total: all.length, hasMoreRecords: page * perPage < all.length },
      });
    }
    if (api === 'network' && request.method === 'getManagedEndpointDetails') {
      const found = state.details.get(String(request.params.endpointId));
      return found
        ? reply(request.id, { result: { id: request.params.endpointId, ...found } })
        : reply(request.id, { error: { code: -32002, message: 'Not found' } });
    }
    return reply(request.id, { error: { code: -32601, message: 'Method not found' } });
  }) as typeof fetch;
  return { state, fetcher };
}

async function waitForJob(b: Browser, id: string) {
  for (let i = 0; i < 300; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

describe('Bitdefender GravityZone data', () => {
  it('only accepts Bitdefender access URLs, and cuts a pasted method address back to the API', () => {
    expect(bitdefenderAccessUrl('https://cloud.gravityzone.bitdefender.com/api/')).toBe(URL_);
    expect(bitdefenderAccessUrl('https://cloudgz.gravityzone.bitdefender.com/api/v1.0/jsonrpc/network')).toBe(
      'https://cloudgz.gravityzone.bitdefender.com/api',
    );
    for (const bad of [
      'http://cloud.gravityzone.bitdefender.com/api',
      'https://gravityzone.bitdefender.com.evil.test/api',
      'https://evil.test/api',
      'https://cloud.gravityzone.bitdefender.com:8443/api',
      'not a url',
    ])
      expect(bitdefenderAccessUrl(bad), bad).toBeNull();
  });

  it('reads an endpoint’s state, and says plainly what needs attention', () => {
    const row = endpointRow(
      { id: 'x', name: 'PC', macs: ['aa'] },
      {
        state: 2,
        lastSeen: '2026-10-01T10:00:00',
        malwareStatus: { infected: false, detection: true },
        agent: { licensed: 2, signatureOutdated: true, productVersion: '7.9' },
        policy: { name: 'Default', applied: false },
        modules: { antimalware: true, firewall: false },
        riskScore: { value: '64%', impact: 'High' },
      },
    );
    expect(row).toMatchObject({ online: false, licence: 'expired', riskScore: 64, modules: ['antimalware'] });
    const { health, issues } = bitdefenderHealth(
      { ...row, lastSeenAt: row.lastSeenAt!.toISOString() },
      Date.parse('2026-10-22T10:00:00Z'),
    );
    expect(health).toBe('attention');
    expect(issues).toEqual([
      'Licence expired',
      'Malware signatures out of date',
      'Policy not applied',
      'Not seen for 21 days',
      'Malware found and removed in the last 24 hours',
    ]);
    expect(bitdefenderHealth({ ...row, infected: true, lastSeenAt: null }).health).toBe('infected');
  });
});

describe('Bitdefender GravityZone', () => {
  let t: TestApp;
  let owner: Browser;
  let gz: ReturnType<typeof fakeGravityZone>;

  beforeEach(async () => {
    gz = fakeGravityZone();
    t = await startApp({}, { bitdefenderFetch: gz.fetcher });
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('tests the key before saving it, keeps it encrypted, and tells personal and service keys apart', async () => {
    const bad = await owner.call('PUT', '/api/integrations/bitdefender', {
      accessUrl: URL_,
      apiKey: 'wrong-key-0123456',
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain('refused the API key');
    expect((await owner.call('GET', '/api/integrations/bitdefender')).data).toBeNull();
    const elsewhere = await owner.call('PUT', '/api/integrations/bitdefender', {
      accessUrl: 'https://attacker.test/api',
      apiKey: PERSONAL,
    });
    expect(elsewhere.status).toBe(400);
    expect(gz.state.calls.some((c) => c.includes('attacker'))).toBe(false);

    const ok = await owner.call('PUT', '/api/integrations/bitdefender', { accessUrl: URL_, apiKey: SERVICE });
    expect(ok.status).toBe(200);
    // The partner itself, Harbor (directly under it), Northline (in a folder), the sub-partner and its customer.
    expect(ok.data).toMatchObject({ accessUrl: URL_, hasKey: true, companies: 5 });
    const tree = (await owner.call('GET', '/api/integrations/bitdefender/companies')).data as { name: string }[];
    expect(tree.map((c) => c.name)).toEqual([
      'Cedar Ridge Credit Union',
      'Coastal Reseller',
      'Harbor Dental Group',
      'IT Done Right',
      'Northline Architecture',
    ]);
    expect(JSON.stringify(ok.data)).not.toContain(SERVICE);
    const stored = await t.handle.db.execute(sql`select settings::text as s from orgs`);
    expect(JSON.stringify(stored.rows)).not.toContain(SERVICE);
    const auth = await t.handle.db.execute(sql`select settings->'bitdefender'->>'auth' as auth from orgs`);
    expect(auth.rows[0]).toEqual({ auth: 'header' });
    // Saving again without a key keeps it.
    expect((await owner.call('PUT', '/api/integrations/bitdefender', { accessUrl: URL_ })).status).toBe(200);

    // A single company's key (no partner methods) is its own one company.
    gz.state.partner = false;
    await owner.call('PUT', '/api/integrations/bitdefender', { accessUrl: URL_, apiKey: PERSONAL });
    const companies = (await owner.call('GET', '/api/integrations/bitdefender/companies')).data;
    expect(companies.map((c: { id: string }) => c.id)).toEqual(['g1']);
  });

  it('syncs linked companies, matches assets by name and MAC, and shows protection to readers only', async () => {
    await owner.call('PUT', '/api/integrations/bitdefender', { accessUrl: URL_, apiKey: PERSONAL });
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const other = (await owner.call('POST', '/api/clients', { name: 'Unlinked Co' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const configuration = layouts.find((l) => l.key === 'configuration')!.id;
    const dc = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: configuration,
        name: 'hdg-dc-01',
        fields: {},
      })
    ).data.id;
    const front = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: configuration,
        name: 'Front desk PC',
        fields: { mac_address: '3C-52-82-1A-2B-3C' },
      })
    ).data.id;

    const suggested = (await owner.call('GET', '/api/integrations/bitdefender/companies')).data;
    expect(suggested.find((c: { id: string }) => c.id === 'g1')).toMatchObject({ suggestedClientId: harbor });
    await owner.call('PUT', '/api/integrations/bitdefender/companies', {
      mappings: [
        { companyId: 'g1', action: 'link', clientId: harbor },
        { companyId: 'g2', action: 'skip' },
      ],
    });

    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/bitdefender/sync', {})).data.id);
    expect(job.status).toBe('done');
    expect(job.messages.join(' ')).toContain(
      'Harbor Dental Group: 4 endpoints (1 infected, 1 needing attention), 2 matched to assets',
    );
    // The skipped company was never read.
    expect(gz.state.calls.filter((c) => c.includes('getEndpointsList'))).toHaveLength(1);

    const view = (await owner.call('GET', `/api/clients/${harbor}/bitdefender`)).data;
    expect(view).toMatchObject({ linked: true, counts: { infected: 1, attention: 1, protected: 2 } });
    expect(view.endpoints.map((e: { name: string }) => e.name)).toEqual([
      'HDG-WS-02',
      'RECEPTION',
      'HDG-DC-01',
      'SPARE-LAPTOP',
    ]);
    expect(view.endpoints[1]).toMatchObject({ assetId: front, assetName: 'Front desk PC', licence: 'expired' });
    expect(view.endpoints[1].issues).toContain('Licence expired');
    expect((await owner.call('GET', `/api/clients/${other}/bitdefender`)).data).toMatchObject({
      linked: false,
      endpoints: [],
    });
    const asset = (await owner.call('GET', `/api/assets/${dc}/bitdefender`)).data.endpoint;
    expect(asset).toMatchObject({
      name: 'HDG-DC-01',
      health: 'protected',
      policyName: 'Servers',
      riskScore: 12,
      modules: ['antimalware', 'edrSensor', 'firewall'],
    });

    // Reports: the endpoint and security reports carry Bitdefender for a linked client.
    const run = (kind: string) =>
      owner.call('POST', '/api/reports/runs', {
        kind,
        title: `${kind} report`,
        clientIds: [harbor],
        withinDays: 90,
        includeMicrosoft: false,
      });
    type Section = { title: string; columns: string[]; rows: string[][] };
    const sections = (await run('endpoints')).data.snapshot.sections as Section[];
    expect(sections.find((s) => s.title === 'Endpoint health')!.columns).toContain('Bitdefender');
    const bd = sections.find((s) => s.title === 'Bitdefender endpoints')!;
    expect(bd.rows.map((r) => [r[1], r[2]])).toEqual([
      ['HDG-WS-02', 'Infected'],
      ['Front desk PC', 'Needs attention'],
      ['hdg-dc-01', 'Protected'],
      ['SPARE-LAPTOP', 'Protected'],
    ]);
    const overview = ((await run('security')).data.snapshot.sections as Section[]).find(
      (s) => s.title === 'Security overview',
    )!;
    const col = (name: string) => overview.rows[0]![overview.columns.indexOf(name)];
    expect([col('Bitdefender infected'), col('Bitdefender attention'), col('Without Bitdefender')]).toEqual([
      '1',
      '1',
      '0',
    ]);

    // A technician without access to the client sees nothing of it.
    await owner.call('POST', '/api/users', {
      email: 'casey@atlas.test',
      name: 'Casey',
      password: 'temporary pass 1234',
      role: 'technician',
      allClients: 'none',
      grants: [{ clientId: other, level: 'read' }],
    });
    const { b } = await signIn(t.app, 'casey@atlas.test', 'temporary pass 1234');
    await b.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    await enroll(b);
    expect((await b.call('GET', `/api/clients/${harbor}/bitdefender`)).status).toBe(404);
    expect((await b.call('GET', `/api/assets/${dc}/bitdefender`)).status).toBe(404);
    expect((await b.call('GET', '/api/integrations/bitdefender')).status).toBe(403);

    // An endpoint gone from GravityZone is removed on the next sync; with "add assets" on, the rest get assets.
    gz.state.endpoints.set(
      'g1',
      gz.state.endpoints.get('g1')!.filter((e) => e.id !== 'e2'),
    );
    await owner.call('PUT', '/api/integrations/bitdefender/options', { createAssets: true });
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/bitdefender/sync', {})).data.id);
    const after = (await owner.call('GET', `/api/clients/${harbor}/bitdefender`)).data;
    expect(after.endpoints.map((e: { name: string }) => e.name).sort()).toEqual([
      'HDG-DC-01',
      'RECEPTION',
      'SPARE-LAPTOP',
    ]);
    const spare = after.endpoints.find((e: { name: string }) => e.name === 'SPARE-LAPTOP');
    expect(spare.assetId).toBeTruthy();
    // A third sync finds the same asset rather than adding another.
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/bitdefender/sync', {})).data.id);
    const assets = (await owner.call('GET', `/api/assets?client=${harbor}`)).data as { name: string }[];
    expect(assets.filter((a) => a.name === 'SPARE-LAPTOP')).toHaveLength(1);

    // Unlinking a company drops its endpoints; disconnecting drops everything but keeps the assets.
    await owner.call('PUT', '/api/integrations/bitdefender/companies', {
      mappings: [{ companyId: 'g1', action: 'clear' }],
    });
    await waitForJob(owner, (await owner.call('POST', '/api/integrations/bitdefender/sync', {})).data.id);
    expect((await owner.call('GET', `/api/clients/${harbor}/bitdefender`)).data.endpoints).toEqual([]);
    expect((await owner.call('DELETE', '/api/integrations/bitdefender')).status).toBe(200);
    expect((await owner.call('GET', '/api/integrations/bitdefender')).data).toBeNull();
    expect(
      ((await owner.call('GET', `/api/assets?client=${harbor}`)).data as { name: string }[]).some(
        (a) => a.name === 'SPARE-LAPTOP',
      ),
    ).toBe(true);
  });
});
