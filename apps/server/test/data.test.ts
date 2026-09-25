import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { unzipSync, strFromU8 } from 'fflate';
import { loginAddress } from '../src/services/importers/hudu.js';
import { OWNER, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

// ---------- a fake Hudu instance ----------
function fakeHudu(options: { key?: string } = {}) {
  const companies = Array.from({ length: 26 }, (_, i) => ({
    id: i + 1,
    name: i === 0 ? 'Harbor Dental Group' : `Company ${String(i + 1).padStart(2, '0')}`,
    company_type: 'Customer',
    address_line_1: i === 0 ? '410 Harbor St' : null,
    city: 'Raleigh',
    state: 'NC',
    zip: '27601',
    notes: '<p>Three <b>offices</b></p>',
    archived: false,
  }));
  companies.push({ id: 99, name: 'Old Client', company_type: 'Customer', archived: true } as never);
  const data: Record<string, unknown[]> = {
    companies,
    asset_layouts: [
      {
        id: 7,
        name: 'Firewalls',
        fields: [
          { label: 'IP Address', field_type: 'Text', position: 1 },
          { label: 'Warranty Expiration', field_type: 'Date', position: 2 },
          { label: 'Managed', field_type: 'CheckBox', position: 3 },
          { label: 'Admin URL', field_type: 'Website', position: 4 },
          { label: 'Admin password', field_type: 'Password', position: 5 },
          { label: 'Contact email', field_type: 'Email', position: 6 },
        ],
      },
    ],
    assets: [
      {
        id: 501,
        company_id: 1,
        asset_layout_id: 7,
        name: 'HDG-FW-01',
        primary_serial: 'FGT60F-123',
        fields: [
          { label: 'IP Address', value: '10.20.0.1' },
          { label: 'Warranty Expiration', value: '2027-03-01T00:00:00Z' },
          { label: 'Managed', value: true },
          { label: 'Admin URL', value: '10.20.0.1:8443' },
          { label: 'Admin password', value: 'should-not-be-imported' },
          { label: 'Contact email', value: 'not an email' },
        ],
      },
    ],
    articles: [
      {
        id: 900,
        company_id: 1,
        name: 'Firewall reboot',
        content:
          '<h2>Before</h2><p>Call the <strong>carrier</strong> &amp; wait.</p><ul><li>Export config</li><li>Reboot</li></ul><script>alert(1)</script><p><a href="javascript:alert(1)">bad</a></p>',
      },
      { id: 901, company_id: null, name: 'Onboarding SOP', content: '<p>Global steps</p>' },
    ],
    asset_passwords: [
      {
        id: 3001,
        company_id: 1,
        name: 'Firewall admin',
        username: 'admin',
        password: 'Hudu-Secret-9981!',
        // As Hudu sends them: `url` is Hudu's page for the password, `login_url` the site it signs in to.
        url: 'https://itdr.huducloud.test/passwords/f3a9c2e1',
        login_url: 'https://10.20.0.1',
        otp_secret: 'JBSWY3DPEHPK3PXP',
        password_folder_name: 'Network',
        passwordable_type: 'Asset',
        passwordable_id: 501,
      },
      { id: 3002, company_id: null, name: 'Orphan', password: 'x' },
    ],
  };
  const calls: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if ((init?.headers as Record<string, string>)['x-api-key'] !== (options.key ?? 'hudu-key-1234567890'))
      return new Response('{"error":"unauthorized"}', { status: 401 });
    const key = url.pathname.replace('/api/v1/', '');
    const page = Number(url.searchParams.get('page') ?? 1);
    const items = (data[key] ?? []).slice((page - 1) * 25, page * 25);
    return new Response(JSON.stringify({ [key]: items }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetcher, calls, data };
}

async function waitForJob(b: Browser, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('import did not finish');
}

describe('REST API keys', () => {
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

  const v1 = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, body?: unknown) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body ? { payload: body as object } : {}),
    });

  it('creates scoped keys, shows the secret once, and enforces scopes', async () => {
    const read = await owner.call('POST', '/api/api-keys', { name: 'Reporting', scopes: ['read'] });
    expect(read.status).toBe(201);
    expect(read.data.token).toMatch(/^atlas_[A-Za-z0-9]{10}_[A-Za-z0-9_-]{43}$/);
    const list = (await owner.call('GET', '/api/api-keys')).data;
    expect(JSON.stringify(list)).not.toContain(read.data.token.split('_')[2]);
    const stored = await t.handle.db.execute(sql`select secret_hash from api_keys`);
    expect(JSON.stringify(stored.rows)).not.toContain(read.data.token);

    expect((await v1('GET', '/clients')).statusCode).toBe(401);
    const clients = await v1('GET', '/clients', read.data.token);
    expect(clients.statusCode).toBe(200);
    expect(clients.json().map((c: { name: string }) => c.name)).toEqual(['Harbor Dental Group']);
    expect((await v1('POST', '/clients', read.data.token, { name: 'Nope' })).statusCode).toBe(403);
    expect((await v1('GET', '/passwords', read.data.token)).statusCode).toBe(403);
    expect((await v1('GET', '/users', read.data.token)).statusCode).toBe(403);
    expect((await v1('GET', '/settings/email', read.data.token)).statusCode).toBe(403);
    // A browser session can't be used on /api/v1, and a key can't be used on /api.
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/v1/clients', headers: { cookie: owner.cookie } })).statusCode,
    ).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/clients',
          headers: { authorization: `Bearer ${read.data.token}` },
        })
      ).statusCode,
    ).toBe(401);

    const write = (await owner.call('POST', '/api/api-keys', { name: 'Sync', scopes: ['read', 'write', 'passwords'] }))
      .data;
    const created = await v1('POST', `/clients/${harbor}/passwords`, write.token, {
      name: 'Router',
      secret: 'R0uter!pass-2026',
    });
    expect(created.statusCode).toBe(201);
    const reveal = await v1('POST', `/passwords/${created.json().id}/reveal`, write.token, {});
    expect(reveal.json().value).toBe('R0uter!pass-2026');
    const audit = (await owner.call('GET', `/api/passwords/${created.json().id}/audit`)).data;
    expect(audit[0].actorName).toContain('API key: Sync');

    expect((await owner.call('DELETE', `/api/api-keys/${read.data.id}`)).status).toBe(200);
    expect((await v1('GET', '/clients', read.data.token)).statusCode).toBe(401);
    const tampered = `${write.token.slice(0, -1)}${write.token.endsWith('A') ? 'B' : 'A'}`;
    expect((await v1('GET', '/clients', tampered)).statusCode).toBe(401);
  });

  it('keys act with their creator’s access and only admins create them', async () => {
    await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tess Tech',
      role: 'technician',
      allClients: 'edit',
      password: TEMP,
    });
    const { b } = await signIn(t.app, 'tech@atlas.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'a better pass 5678' });
    await enroll(b);
    expect((await b.call('POST', '/api/api-keys', { name: 'Mine', scopes: ['read'] })).status).toBe(403);
    const events = (await owner.call('GET', '/api/security-events')).data.map((e: { action: string }) => e.action);
    expect(events).not.toContain('API key created');
  });

  it('publishes an OpenAPI description', async () => {
    const spec = (await t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('http://localhost/api/v1');
    expect(spec.paths['/clients'].post.requestBody.content['application/json'].schema.properties.name).toBeTruthy();
    expect(spec.paths['/passwords/{id}/reveal'].post).toBeTruthy();
  });
});

describe('Hudu password addresses', () => {
  const HUDU = 'https://itdr.huducloud.test';
  it('uses the saved login address, never Hudu’s link to the password', () => {
    expect(loginAddress({ login_url: 'https://portal.vendor.test', url: `${HUDU}/passwords/1` }, HUDU)).toBe(
      'https://portal.vendor.test',
    );
    expect(loginAddress({ login_url: '', url: `${HUDU}/passwords/1` }, HUDU)).toBe('');
    expect(loginAddress({ url: 'https://ITDR.huducloud.test/a/passwords/1' }, HUDU)).toBe('');
    // Older Hudu versions without login_url: a non-Hudu address in url is still the site.
    expect(loginAddress({ url: 'https://10.20.0.1' }, HUDU)).toBe('https://10.20.0.1');
    expect(loginAddress({ url: '10.20.0.1:8443' }, HUDU)).toBe('10.20.0.1:8443');
    expect(loginAddress({}, HUDU)).toBe('');
  });
});

describe('Hudu import', () => {
  let t: TestApp;
  let owner: Browser;
  let hudu: ReturnType<typeof fakeHudu>;
  beforeEach(async () => {
    hudu = fakeHudu();
    t = await startApp({}, { huduFetch: hudu.fetcher });
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('connects, previews, imports everything, and updates on a second run', async () => {
    expect((await owner.call('POST', '/api/import/hudu/preview', {})).status).toBe(400);
    expect(
      (await owner.call('PUT', '/api/import/hudu', { url: 'http://insecure.test', apiKey: 'hudu-key-1234567890' }))
        .status,
    ).toBe(400);
    const saved = await owner.call('PUT', '/api/import/hudu', {
      url: 'https://itdr.huducloud.test/',
      apiKey: 'hudu-key-1234567890',
    });
    expect(saved.data).toEqual({ url: 'https://itdr.huducloud.test', hasKey: true });
    const raw = await t.handle.db.execute(sql`select settings::text as s from orgs`);
    expect((raw.rows[0] as { s: string }).s).not.toContain('hudu-key-1234567890');

    const preview = await owner.call('POST', '/api/import/hudu/preview', {});
    expect(preview.data).toEqual({ companies: 26, assetLayouts: 1, assets: 1, articles: 2, passwords: 2 });
    expect(hudu.calls).toContain('/api/v1/companies?page=2');

    const start = await owner.call('POST', '/api/import/hudu/run', {});
    expect(start.status).toBe(202);
    const job = await waitForJob(owner, start.data.id);
    expect(job.status, JSON.stringify(job)).toBe('done');
    expect(job.counts.clients).toMatchObject({ created: 26, failed: 0 });
    expect(job.counts.assets).toMatchObject({ created: 1, failed: 0 });
    expect(job.counts.documents, JSON.stringify(job.messages)).toMatchObject({ created: 2 });
    expect(job.counts.passwords).toMatchObject({ created: 1, skipped: 1 });

    const clients = (await owner.call('GET', '/api/clients')).data as { id: string; name: string; notes: string }[];
    expect(clients.map((c) => c.name)).not.toContain('Old Client');
    const harbor = clients.find((c) => c.name === 'Harbor Dental Group')!;
    expect(harbor.notes).toContain('Three offices');
    expect((await owner.call('GET', `/api/clients/${harbor.id}/locations`)).data[0]).toMatchObject({
      address: '410 Harbor St',
      city: 'Raleigh',
    });

    const layout = (await owner.call('GET', '/api/layouts')).data.find((l: { name: string }) => l.name === 'Firewalls');
    expect(layout.fields.map((f: { label: string }) => f.label)).not.toContain('Admin password');
    const [asset] = (await owner.call('GET', `/api/assets?client=${harbor.id}`)).data;
    expect(asset.fields).toMatchObject({
      ip_address: '10.20.0.1',
      warranty_expiration: '2027-03-01',
      managed: true,
      admin_url: 'https://10.20.0.1:8443',
    });
    expect(asset.notes).toContain('Serial: FGT60F-123');
    expect(asset.notes).toContain('Contact email: not an email');
    expect(JSON.stringify(asset)).not.toContain('should-not-be-imported');

    const docs = (await owner.call('GET', `/api/documents?client=${harbor.id}`)).data;
    const doc = (await owner.call('GET', `/api/documents/${docs[0].id}`)).data;
    const text = JSON.stringify(doc.content);
    expect(text).toContain('"heading"');
    expect(text).toContain('carrier');
    expect(text).toContain('bulletList');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('javascript');
    expect(
      (await owner.call('GET', '/api/documents?client=global')).data.map((d: { title: string }) => d.title),
    ).toContain('Onboarding SOP');

    const [password] = (await owner.call('GET', `/api/passwords?client=${harbor.id}`)).data;
    expect(password).toMatchObject({ name: 'Firewall admin', username: 'admin', hasTotp: true });
    // The saved sign-in address, not Hudu's link to the password.
    expect(password.url).toBe('https://10.20.0.1');
    // Hudu's folder sets the type, and the password stays linked to the asset it was attached to.
    expect(password).toMatchObject({ category: 'network', categoryGuessed: false });
    expect(password.linkedAssets.map((a: { name: string }) => a.name)).toEqual(['HDG-FW-01']);
    expect((await owner.call('POST', `/api/passwords/${password.id}/reveal`, {})).data.value).toBe('Hudu-Secret-9981!');

    // Second run: updates, no duplicates.
    hudu.data.companies![0] = { ...(hudu.data.companies![0] as object), notes: 'Four offices now' };
    const again = await waitForJob(owner, (await owner.call('POST', '/api/import/hudu/run', {})).data.id);
    expect(again.counts.clients).toMatchObject({ created: 0, updated: 26 });
    expect(again.counts.passwords).toMatchObject({ created: 0, updated: 1 });
    const after = (await owner.call('GET', '/api/clients')).data as { name: string; notes: string }[];
    expect(after).toHaveLength(26);
    expect(after.find((c) => c.name === 'Harbor Dental Group')!.notes).toContain('Four offices now');
    expect((await owner.call('GET', `/api/passwords?client=${harbor.id}`)).data).toHaveLength(1);
  });

  it('runs one import at a time, and frees the slot held by an abandoned import', async () => {
    await owner.call('PUT', '/api/import/hudu', { url: 'https://itdr.huducloud.test', apiKey: 'hudu-key-1234567890' });
    const starts = await Promise.all([
      owner.call('POST', '/api/import/hudu/run', {}),
      owner.call('POST', '/api/import/hudu/run', {}),
    ]);
    expect(starts.map((r) => r.status).sort()).toEqual([202, 409]);
    await waitForJob(owner, starts.find((r) => r.status === 202)!.data.id);

    // A job still marked running with a recent heartbeat blocks; one whose heartbeat stopped long ago doesn't.
    const [org] = (await t.handle.db.execute(sql`select id from orgs`)).rows as { id: string }[];
    const insert = async (minutesAgo: number) =>
      (
        (
          await t.handle.db.execute(
            sql`insert into import_jobs (org_id, source, started_by_name, heartbeat_at)
                values (${org!.id}, 'hudu', 'Crashed run', now() - make_interval(mins => ${minutesAgo}))
                returning id`,
          )
        ).rows[0] as { id: string }
      ).id;
    const fresh = await insert(1);
    expect((await owner.call('POST', '/api/import/hudu/run', {})).status).toBe(409);
    await t.handle.db.execute(sql`delete from import_jobs where id = ${fresh}`);
    const abandoned = await insert(30);
    const next = await owner.call('POST', '/api/import/hudu/run', {});
    expect(next.status).toBe(202);
    const old = (await owner.call('GET', `/api/import/jobs/${abandoned}`)).data;
    expect(old.status).toBe('failed');
    expect(old.messages.join(' ')).toContain('Atlas stopped while this import was running');
    expect((await waitForJob(owner, next.data.id)).status).toBe('done');
  });

  it('reports a rejected API key', async () => {
    await owner.call('PUT', '/api/import/hudu', { url: 'https://itdr.huducloud.test', apiKey: 'wrong-key-000000000' });
    const preview = await owner.call('POST', '/api/import/hudu/preview', {});
    expect(preview.status).toBe(400);
    expect(preview.data.error).toContain('rejected the API key');
  });

  it('brings over integration-synced and loosely labelled asset details, not just names', async () => {
    hudu.data.asset_layouts!.push(
      {
        id: 8,
        name: 'Computer Assets',
        fields: [
          { id: 81, label: 'Operating System', field_type: 'Text', position: 1 },
          { id: 82, label: 'IP Address', field_type: 'Text', position: 2 },
          { id: 83, label: 'Assigned User', field_type: 'Text', position: 3 },
          { id: 84, label: 'Warranty Expiration', field_type: 'Date', position: 4 },
          { id: 85, label: 'Local Admin', field_type: 'Password', position: 5 },
        ],
      },
      {
        id: 9,
        name: 'People',
        fields: [
          { id: 91, label: 'Title', field_type: 'Text', position: 1 },
          { id: 92, label: 'Email', field_type: 'Email', position: 2 },
          { id: 93, label: 'Phone', field_type: 'Phone', position: 3 },
        ],
      },
    );
    hudu.data.assets!.push(
      {
        id: 601,
        company_id: 1,
        asset_layout_id: 8,
        name: 'HDG-WS-014',
        primary_manufacturer: 'Dell',
        primary_serial: 'ABC1234',
        // Labels differ in case/spacing, one only has a caption, one only the layout field id.
        fields: [
          { label: 'operating  system', value: 'Windows 11 Pro' },
          { caption: 'Assigned User', value: 'Dana Reyes' },
          { asset_layout_field_id: 84, label: 'Warranty (renamed)', value: '2027-06-30' },
          { label: 'Local Admin', value: 'never-import-this' },
          { label: 'Rack Unit', value: 'U12' },
        ],
        cards: [
          {
            integrator_name: 'NinjaOne',
            data: {
              ip_address: '10.20.4.14',
              last_seen: '2026-09-24T10:00:00Z',
              cpu: { model: 'Intel i7-1365U', cores: 10 },
              bitlocker_recovery_key: 'never-import-this-either',
              disks: ['C: 512 GB'],
            },
          },
        ],
      },
      {
        id: 602,
        company_id: 1,
        asset_layout_id: 9,
        name: 'Dana Reyes',
        primary_mail: 'dana@harbordental.test',
        custom_fields: [{ title: 'Office Manager' }, { phone: '919-555-0142' }],
      },
    );
    await owner.call('PUT', '/api/import/hudu', { url: 'https://itdr.huducloud.test', apiKey: 'hudu-key-1234567890' });
    const job = await waitForJob(owner, (await owner.call('POST', '/api/import/hudu/run', {})).data.id);
    expect(job.status, JSON.stringify(job)).toBe('done');
    expect(job.counts.assets).toMatchObject({ created: 3, failed: 0 });
    expect(job.messages.join('\n')).toContain('Computer Assets: Rack Unit didn');

    const all = (await owner.call('GET', '/api/assets')).data as { id: string; name: string }[];
    const get = async (name: string) =>
      (await owner.call('GET', `/api/assets/${all.find((a) => a.name === name)!.id}`)).data;

    const pc = await get('HDG-WS-014');
    expect(pc.fields).toEqual({
      operating_system: 'Windows 11 Pro',
      assigned_user: 'Dana Reyes',
      warranty_expiration: '2027-06-30',
      ip_address: '10.20.4.14',
    });
    expect(pc.notes).toContain('Manufacturer: Dell');
    expect(pc.notes).toContain('Rack Unit: U12');
    expect(pc.notes).toContain('From NinjaOne:');
    expect(pc.notes).toContain('cpu model: Intel i7-1365U');
    expect(pc.notes).toContain('disks: C: 512 GB');
    expect(JSON.stringify(pc)).not.toContain('never-import-this');

    const person = await get('Dana Reyes');
    expect(person.fields).toEqual({ title: 'Office Manager', email: 'dana@harbordental.test', phone: '919-555-0142' });
  });
});

describe('CSV import and export', () => {
  let t: TestApp;
  let owner: Browser;
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('validates in a dry run, then imports clients, contacts, assets, and passwords by client name', async () => {
    const clients = [
      { name: 'Harbor Dental Group', type: 'Customer', notes: 'Dentists' },
      { name: 'Northline Architecture' },
      { name: '' },
    ];
    const dry = await owner.call('POST', '/api/import/csv', { target: 'clients', rows: clients, dryRun: true });
    expect(dry.data).toMatchObject({ created: 0, errors: [{ row: 4 }] });
    expect((await owner.call('GET', '/api/clients')).data).toHaveLength(0);
    const real = await owner.call('POST', '/api/import/csv', { target: 'clients', rows: clients });
    expect(real.data).toMatchObject({ created: 2, updated: 0 });
    // Same sheet again: matched by name.
    expect(
      (await owner.call('POST', '/api/import/csv', { target: 'clients', rows: clients.slice(0, 2) })).data,
    ).toMatchObject({ created: 0, updated: 2 });

    // Updating a client changes only the columns in the file; its other settings stay.
    const northline = (await owner.call('GET', '/api/clients')).data.find(
      (c: { name: string }) => c.name === 'Northline Architecture',
    );
    await owner.call('PATCH', `/api/clients/${northline.id}`, { type: 'Architects', requireRevealReason: true });
    await owner.call('POST', '/api/import/csv', {
      target: 'clients',
      rows: [{ name: 'northline architecture', notes: 'Two studios' }],
    });
    expect((await owner.call('GET', `/api/clients/${northline.id}`)).data).toMatchObject({
      name: 'Northline Architecture',
      type: 'Architects',
      requireRevealReason: true,
      notes: 'Two studios',
    });

    const contacts = await owner.call('POST', '/api/import/csv', {
      target: 'contacts',
      rows: [
        { client: 'harbor dental group', name: 'Dana Morales', email: 'dana@harbor.test', primary: 'yes' },
        { client: 'Nowhere Inc', name: 'Ghost' },
        { client: 'Harbor Dental Group', name: 'Bad Email', email: 'nope' },
      ],
    });
    expect(contacts.data.created).toBe(1);
    expect(contacts.data.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
    expect(contacts.data.errors[0].message).toContain('No client named "Nowhere Inc"');

    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const ssl = layouts.find((l) => l.key === 'ssl_certificate')!.id;
    const assets = await owner.call('POST', '/api/import/csv', {
      target: 'assets',
      layoutId: ssl,
      rows: [
        {
          client: 'Harbor Dental Group',
          name: 'portal.harbor.test',
          common_name: 'portal.harbor.test',
          expires: '2027-01-31',
        },
        { client: 'Harbor Dental Group', name: 'bad-date', common_name: 'x', expires: 'soon' },
      ],
    });
    expect(assets.data.created).toBe(1);
    expect(assets.data.errors).toHaveLength(1);

    const passwords = await owner.call('POST', '/api/import/csv', {
      target: 'passwords',
      rows: [{ client: 'Harbor Dental Group', name: 'Wi-Fi', password: 'Harbor-WiFi-2026!' }],
    });
    expect(passwords.data).toMatchObject({ created: 1, errors: [] });
  });

  it('exports a client as a zip, with decrypted passwords only for a confirmed administrator', async () => {
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('POST', `/api/clients/${harbor}/contacts`, { name: 'Dana Morales' });
    await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Router', secret: 'R0uter!pass-2026' });
    await owner.call('POST', '/api/documents', {
      title: 'Runbook',
      clientId: harbor,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step one' }] }] },
    });

    const plain = await t.app.inject({
      method: 'GET',
      url: `/api/clients/${harbor}/export`,
      headers: { cookie: owner.cookie },
    });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-type']).toBe('application/zip');
    const files = unzipSync(new Uint8Array(plain.rawPayload));
    const data = JSON.parse(strFromU8(files['client.json']!));
    expect(data.client.name).toBe('Harbor Dental Group');
    expect(data.contacts[0].name).toBe('Dana Morales');
    expect(data.passwords[0].name).toBe('Router');
    expect(JSON.stringify(data)).not.toContain('R0uter!pass-2026');
    expect(Object.keys(files).some((f) => f.startsWith('documents/Runbook'))).toBe(true);
    // Links to a global knowledge-base article are exported whichever end the client's item is stored on.
    const kb = (
      await owner.call('POST', '/api/documents', {
        title: 'Printer SOP',
        clientId: null,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Power cycle' }] }] },
      })
    ).data.id;
    const office = (await owner.call('POST', `/api/clients/${harbor}/locations`, { name: 'Main office' })).data.id;
    const contact = (await owner.call('GET', `/api/clients/${harbor}/contacts`)).data[0].id;
    for (const [type, id] of [
      ['location', office],
      ['contact', contact],
    ])
      expect(await owner.call('POST', `/api/items/document/${kb}/relations`, { type, id })).toMatchObject({
        status: 200,
      });
    const linked = JSON.parse(
      strFromU8(
        unzipSync(
          new Uint8Array(
            (
              await t.app.inject({
                method: 'GET',
                url: `/api/clients/${harbor}/export`,
                headers: { cookie: owner.cookie },
              })
            ).rawPayload,
          ),
        )['client.json']!,
      ),
    );
    const ends = linked.relations.flatMap((r: { a: { id: string }; b: { id: string } }) => [r.a.id, r.b.id]);
    expect(ends).toEqual(expect.arrayContaining([office, contact, kb]));
    expect(linked.relations).toHaveLength(2);
    expect(JSON.stringify(linked.relations)).toContain('"title":"Printer SOP","external":true');

    await t.handle.db.execute(sql`update sessions set reauth_at = null`);
    const stale = await t.app.inject({
      method: 'GET',
      url: `/api/clients/${harbor}/export?passwords=true`,
      headers: { cookie: owner.cookie },
    });
    expect(stale.json().code).toBe('reauth');
    await owner.call('POST', '/api/session/reauth', { password: OWNER.password });
    const full = await t.app.inject({
      method: 'GET',
      url: `/api/clients/${harbor}/export?passwords=true`,
      headers: { cookie: owner.cookie },
    });
    const withSecrets = JSON.parse(strFromU8(unzipSync(new Uint8Array(full.rawPayload))['client.json']!));
    expect(withSecrets.passwords[0].secret).toBe('R0uter!pass-2026');
    const audit = (await owner.call('GET', '/api/vault/audit')).data.map((a: { action: string }) => a.action);
    expect(audit).toContain('Exported (decrypted)');
  });
});

describe('client portal passwords', () => {
  it('shows client accounts only the passwords shared with them, read-only', async () => {
    const t = await startApp();
    try {
      const owner = (await setupOwner(t.app)).b;
      const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
      const shared = (
        await owner.call('POST', `/api/clients/${harbor}/passwords`, {
          name: 'Guest Wi-Fi',
          secret: 'Welcome-Guests-26',
          clientVisible: true,
        })
      ).data;
      const hidden = (
        await owner.call('POST', `/api/clients/${harbor}/passwords`, {
          name: 'Domain admin',
          secret: 'D0main!Admin-26',
        })
      ).data;
      expect(shared.clientVisible).toBe(true);
      await owner.call('POST', '/api/users', {
        email: 'dana@harbor.test',
        name: 'Dana Morales',
        role: 'client_viewer',
        grants: [{ clientId: harbor, level: 'read' }],
        password: TEMP,
      });
      const { b } = await signIn(t.app, 'dana@harbor.test', TEMP);
      await b.call('POST', '/api/account/password', { current: TEMP, next: 'harbor portal 5678' });
      const list = (await b.call('GET', `/api/passwords?client=${harbor}`)).data;
      expect(list, JSON.stringify(list)).toBeInstanceOf(Array);
      expect(list.map((p: { name: string }) => p.name)).toEqual(['Guest Wi-Fi']);
      expect((await b.call('POST', `/api/passwords/${shared.id}/reveal`, {})).data.value).toBe('Welcome-Guests-26');
      expect((await b.call('GET', `/api/passwords/${hidden.id}`)).status).toBe(404);
      expect((await b.call('PATCH', `/api/passwords/${shared.id}`, { name: 'x', version: 1 })).status).toBe(404);
      expect((await b.call('GET', `/api/passwords/${shared.id}/history`)).status).toBe(404);
      expect((await b.call('POST', `/api/passwords/${shared.id}/shares`, { ciphertext: 'a'.repeat(30) })).status).toBe(
        404,
      );
      // Restricting it hides it from the portal again.
      await owner.call('PATCH', `/api/passwords/${shared.id}`, { restricted: true, version: 1 });
      expect((await b.call('GET', `/api/passwords?client=${harbor}`)).data).toHaveLength(0);
    } finally {
      await t.close();
    }
  });
});

describe('activity paging', () => {
  it('fills the page with activity the person may see, skipping restricted passwords in the query', async () => {
    const t = await startApp();
    try {
      const owner = (await setupOwner(t.app)).b;
      const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
      const secret = (
        await owner.call('POST', `/api/clients/${harbor}/passwords`, {
          name: 'Domain admin',
          secret: 'D0main!Admin-26',
          restricted: true,
        })
      ).data;
      await owner.call('POST', '/api/users', {
        email: 'casey@atlas.test',
        name: 'Casey Tech',
        role: 'technician',
        grants: [{ clientId: harbor, level: 'edit_passwords' }],
        password: TEMP,
      });
      const { b } = await signIn(t.app, 'casey@atlas.test', TEMP);
      await b.call('POST', '/api/account/password', { current: TEMP, next: 'cobalt fresh pass 12' });
      await enroll(b);
      const [org] = (await t.handle.db.execute(sql`select id from orgs`)).rows as { id: string }[];
      // 55 older visible entries, then 60 newer ones about the restricted password.
      await t.handle.db.execute(sql`
        insert into activity (org_id, actor_name, client_id, action, entity_type, entity_id, title)
        select ${org!.id}, 'Alex', ${harbor}, 'Updated', 'client', ${harbor}, 'Harbor ' || g
        from generate_series(1, 55) g`);
      await t.handle.db.execute(sql`
        insert into activity (org_id, actor_name, client_id, action, entity_type, entity_id, title)
        select ${org!.id}, 'Alex', ${harbor}, 'Revealed', 'password', ${secret.id}, 'Domain admin'
        from generate_series(1, 60) g`);
      const page = (await b.call('GET', `/api/activity?client=${harbor}&limit=50`)).data as { title: string }[];
      expect(page).toHaveLength(50);
      expect(page.map((a) => a.title)).not.toContain('Domain admin');
      // The owner (an admin) sees the restricted entries.
      const all = (await owner.call('GET', `/api/activity?client=${harbor}&limit=50`)).data as { title: string }[];
      expect(all[0]!.title).toBe('Domain admin');
    } finally {
      await t.close();
    }
  });
});

describe('0.2 migration', () => {
  it('moves users, clients, records, and links from the SQLite file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-legacy-'));
    const t = await startApp();
    try {
      const { openStore } = await import('../../../legacy/server/store.mjs' as string);
      const { openIdentity, hashPassword } = await import('../../../legacy/server/identity.mjs' as string);
      const file = join(dir, 'atlas.sqlite');
      const keyFile = join(dir, 'identity.key');
      writeFileSync(keyFile, randomBytes(32).toString('base64url'));
      const store = openStore(file);
      openIdentity(store, { keyFile });
      const now = new Date().toISOString();
      store.db
        .prepare(
          'INSERT INTO users (id, msp_id, email, name, role, all_clients, password_hash, must_change_password, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          'u1',
          'msp-demo',
          'Legacy.Tech@atlas.test',
          'Lee Legacy',
          'technician',
          1,
          await hashPassword('legacy password 99'),
          0,
          now,
          now,
        );
      store.db.close();

      await setupOwner(t.app);
      const { migrateLegacy } = await import('../src/services/importers/legacy.js');
      const { staticKeyProvider } = await import('../src/crypto/keys.js');
      const { actorFor } = await import('../src/identity/service.js');
      const [ownerRow] = (await t.handle.db.execute(sql`select * from users where role = 'owner'`)).rows as never[];
      const owner = actorFor({
        ...(ownerRow as Record<string, unknown>),
        orgId: (ownerRow as { org_id: string }).org_id,
        mfaSecret: 'x',
        passkeyCount: 0,
        allClients: 'edit_passwords',
      } as never);
      const run = await migrateLegacy(t.handle.db, owner, staticKeyProvider([randomBytes(32)]), { file });
      expect(run.counts.clients!.created).toBeGreaterThan(0);
      expect(run.counts.assets!.created).toBeGreaterThan(0);
      expect(run.counts.documents!.created).toBeGreaterThan(0);
      expect(run.counts.users).toMatchObject({ created: 1 });
      // Only the workspace with accounts moves: the seed's other-msp isolation fixture stays behind.
      const names = ((await t.handle.db.execute(sql`select name from clients`)).rows as { name: string }[]).map(
        (r) => r.name,
      );
      expect(names).toContain('Harbor Dental Group');
      expect(names).not.toContain('Isolation Test Company');
      const titles = ((await t.handle.db.execute(sql`select title from documents`)).rows as { title: string }[]).map(
        (r) => r.title,
      );
      expect(titles).not.toContain('Private tenant record');

      // The 0.2 password hash still works.
      const { r } = await signIn(t.app, 'legacy.tech@atlas.test', 'legacy password 99');
      expect(r.status).toBe(200);

      const again = await migrateLegacy(t.handle.db, owner, staticKeyProvider([randomBytes(32)]), { file });
      expect(again.counts.clients!.created).toBe(0);
      expect(again.counts.users).toMatchObject({ skipped: 1 });

      // With accounts in two workspaces, the migration asks which one instead of mixing them.
      const { DatabaseSync } = await import('node:sqlite');
      const writable = new DatabaseSync(file);
      writable
        .prepare(
          'INSERT INTO users (id, msp_id, email, name, role, all_clients, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run('u2', 'other-msp', 'other@atlas.test', 'Other Tenant', 'admin', 1, 'x', now, now);
      writable.close();
      await expect(migrateLegacy(t.handle.db, owner, staticKeyProvider([randomBytes(32)]), { file })).rejects.toThrow(
        /several workspaces.*msp-demo.*other-msp|several workspaces.*other-msp.*msp-demo/,
      );
      await expect(
        migrateLegacy(t.handle.db, owner, staticKeyProvider([randomBytes(32)]), { file, workspace: 'nope' }),
      ).rejects.toThrow('No workspace "nope"');
      const chosen = await migrateLegacy(t.handle.db, owner, staticKeyProvider([randomBytes(32)]), {
        file,
        workspace: 'msp-demo',
      });
      expect(chosen.counts.clients!.created).toBe(0);
      expect(chosen.counts.users).toMatchObject({ skipped: 1 });
    } finally {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
