import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { certProbe, certificateHost, isPublicAddress, type CertProbe } from '../src/services/cert-probe.js';
import type { DomainDetails, DomainLookup } from '../src/services/domain-lookup.js';
import { due, standing } from '../src/services/trackers.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('tracker values', () => {
  it('refuses private, loopback, and link-local addresses', () => {
    expect(isPublicAddress('93.184.215.14')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
    for (const a of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.20.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0'])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of ['::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'not an ip'])
      expect(isPublicAddress(a), a).toBe(false);
  });

  it('turns what was typed into a host to check', () => {
    expect(certificateHost('https://Portal.Example.com/login')).toBe('portal.example.com');
    expect(certificateHost('mail.example.com.')).toBe('mail.example.com');
    expect(certificateHost('*.example.com')).toBeNull();
    expect(certificateHost('10.0.0.1')).toBeNull();
    expect(certificateHost('')).toBeNull();
  });

  it("won't connect to a name that resolves to a private address", async () => {
    const resolveTo = (address: string) =>
      certProbe({ timeoutMs: 2000, resolve: async () => [{ address: '93.184.215.14' }, { address }] });
    await expect(resolveTo('10.0.0.5')('intranet.example.com')).rejects.toThrow(/private address/);
    await expect(resolveTo('::1')('intranet.example.com')).rejects.toThrow(/private address/);
    await expect(resolveTo('10.0.0.5')('*.example.com')).rejects.toThrow(/Not a host name/);
  });

  it('places dates, and decides when an item is due', () => {
    const today = '2026-09-29';
    expect(standing('2026-09-28', today)).toBe('expired');
    expect(standing('2026-10-29', today)).toBe('soon');
    expect(standing('2026-10-30', today)).toBe('active');
    expect(standing(null, today)).toBe('unknown');
    const now = Date.parse('2026-09-29T12:00:00Z');
    const ago = (h: number) => ({ checkedAt: new Date(now - h * 3_600_000), ok: true });
    expect(due('domain', null, null, now)).toBe(true);
    expect(due('ssl', ago(21), null, now)).toBe(true);
    expect(due('ssl', ago(2), null, now)).toBe(false);
    expect(due('domain', ago(48), '2027-09-01', now)).toBe(false);
    expect(due('domain', ago(48), '2026-10-15', now)).toBe(true);
    expect(due('domain', ago(24 * 8), '2027-09-01', now)).toBe(true);
    expect(due('domain', { checkedAt: new Date(now - 7 * 3_600_000), ok: false }, null, now)).toBe(true);
  });
});

describe('domain and SSL trackers', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let northline: string;
  let domainLayout: string;
  let sslLayout: string;
  const registry: Record<string, DomainDetails> = {};
  const served: Record<string, { expires: string; issuer: string } | Error> = {};
  const probed: string[] = [];

  const domains = {
    lookup: async (name: string) => registry[name] ?? null,
  } as unknown as DomainLookup;
  const probe: CertProbe = async (host) => {
    probed.push(host);
    const s = served[host];
    if (!s) throw new Error('Nothing answers on port 443.');
    if (s instanceof Error) throw s;
    return {
      host,
      expires: s.expires,
      issuer: s.issuer,
      commonName: host,
      altNames: [host],
      trusted: true,
      problem: '',
    };
  };

  const asset = async (clientId: string, layoutId: string, name: string, fields: Record<string, string> = {}) => {
    const r = await owner.call('POST', `/api/clients/${clientId}/assets`, { layoutId, name, fields });
    expect(r.status, JSON.stringify(r.data)).toBe(201);
    return r.data.id as string;
  };

  beforeEach(async () => {
    for (const k of Object.keys(registry)) delete registry[k];
    for (const k of Object.keys(served)) delete served[k];
    probed.length = 0;
    t = await startApp({}, { domainLookup: domains, certProbe: probe });
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    domainLayout = layouts.find((l) => l.key === 'domain')!.id;
    sslLayout = layouts.find((l) => l.key === 'ssl_certificate')!.id;
    await asset(harbor, domainLayout, 'harbordental.example', { expires: inDays(-3) });
    await asset(harbor, domainLayout, 'harbor-old.example');
    await asset(harbor, sslLayout, 'Portal certificate', {
      common_name: 'portal.harbordental.example',
      expires: inDays(10),
    });
    await asset(northline, domainLayout, 'northline.example', { expires: inDays(300) });
    await asset(northline, sslLayout, 'Wildcard', { common_name: '*.northline.example' });
  });
  afterEach(async () => {
    await t.close();
  });

  it('counts domains and certificates by expiry, for the clients the viewer can read', async () => {
    const report = (await owner.call('GET', '/api/trackers')).data;
    expect(report.soonDays).toBe(30);
    expect(report.domain).toEqual({ total: 3, expired: 1, soon: 0, active: 1, unknown: 1 });
    expect(report.ssl).toEqual({ total: 2, expired: 0, soon: 1, active: 0, unknown: 1 });
    expect(report.clients[0].clientName).toBe('Harbor Dental Group');
    const soon = (await owner.call('GET', '/api/trackers/items?kind=ssl&filter=soon')).data;
    expect(soon).toEqual([expect.objectContaining({ name: 'Portal certificate', daysLeft: 10, checkedAt: null })]);
    expect((await owner.call('GET', '/api/trackers/items?kind=web')).status).toBe(400);
    expect((await owner.call('GET', '/api/trackers/items?kind=ssl&filter=later')).status).toBe(400);
  });

  it('re-checks domains, reads certificates, and adds certificates for domains', async () => {
    registry['harbordental.example'] = {
      domain: 'harbordental.example',
      expires: inDays(362),
      registrar: 'Example Registrar',
    };
    registry['northline.example'] = { domain: 'northline.example', expires: inDays(300) };
    served['portal.harbordental.example'] = { expires: inDays(80), issuer: "Let's Encrypt" };
    served['harbordental.example'] = { expires: inDays(60), issuer: 'DigiCert Inc' };
    served['northline.example'] = new Error(
      'The name resolves to a private address, which the tracker does not check.',
    );

    const run = await owner.call('POST', '/api/trackers/check', { client: harbor });
    expect(run.status, JSON.stringify(run.data)).toBe(200);
    expect(run.data).toEqual({ domains: 2, certificates: 3, created: 1, failed: 1 });
    // Harbor only: Northline wasn't asked for.
    expect(probed.sort()).toEqual(['harbor-old.example', 'harbordental.example', 'portal.harbordental.example']);

    const domainsNow = (await owner.call('GET', `/api/trackers/items?kind=domain&client=${harbor}`)).data;
    expect(domainsNow).toEqual([
      expect.objectContaining({
        name: 'harbordental.example',
        expires: inDays(362),
        source: 'Example Registrar',
        ok: true,
      }),
      expect.objectContaining({ name: 'harbor-old.example', expires: null, ok: false }),
    ]);
    const certs = (await owner.call('GET', `/api/trackers/items?kind=ssl&client=${harbor}`)).data;
    expect(certs).toEqual([
      expect.objectContaining({ name: 'harbordental.example', expires: inDays(60), source: 'DigiCert Inc', ok: true }),
      expect.objectContaining({ name: 'Portal certificate', expires: inDays(80), source: "Let's Encrypt", ok: true }),
    ]);
    // Saved on the asset as a new version, by whoever pressed Check now.
    const portal = (await owner.call('GET', `/api/assets/${certs[1].assetId}`)).data;
    expect(portal.fields).toMatchObject({ expires: inDays(80), issuer: "Let's Encrypt" });
    expect(portal.version).toBe(2);

    // Again straight away: rate-limited.
    expect((await owner.call('POST', '/api/trackers/check', { client: harbor })).status).toBe(429);
  });

  it('runs on a schedule as the tracker, only what is due, and never adds a certificate twice', async () => {
    registry['northline.example'] = { domain: 'northline.example', expires: inDays(300) };
    served['northline.example'] = { expires: inDays(45), issuer: 'Sectigo' };
    // The scheduler runs the service as the organization's tracker actor; drive the service directly.
    const { TrackerService } = await import('../src/services/trackers.js');
    const { SettingsService } = await import('../src/services/settings.js');
    const { staticKeyProvider } = await import('../src/crypto/keys.js');
    const service = new TrackerService(
      t.handle.db,
      new SettingsService(t.handle.db, staticKeyProvider([Buffer.alloc(32)])),
      {
        domains,
        probe,
      },
    );
    const [{ id: orgId }] = (await t.handle.db.execute(sql`select id from orgs`)).rows as { id: string }[];
    const actor = await service.trackerActor(orgId);
    expect(actor?.name).toBe('Domain and SSL tracker');
    // The same site entered twice gets one certificate, not two.
    await asset(northline, domainLayout, 'https://northline.example/');
    const first = await service.run(actor!);
    expect(first.created).toBe(1);
    const second = await service.run(actor!);
    expect(second).toEqual({ domains: 0, certificates: 0, created: 0, failed: 0 });
    const northlineCerts = (await owner.call('GET', `/api/trackers/items?kind=ssl&client=${northline}`)).data;
    expect(northlineCerts.map((c: { name: string }) => c.name)).toEqual(['northline.example', 'Wildcard']);
    expect(northlineCerts[1]).toMatchObject({ ok: false, detail: expect.stringMatching(/No host to check/) });
    // A scheduled tick takes and releases its lock on one connection, so the next tick can run.
    const { TrackerScheduler } = await import('../src/services/trackers.js');
    const scheduler = new TrackerScheduler(
      t.handle,
      new SettingsService(t.handle.db, staticKeyProvider([Buffer.alloc(32)])),
      service,
      (e) => {
        throw e;
      },
    );
    await scheduler.tick();
    const held = await t.handle.db.execute(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = 727278`,
    );
    expect((held.rows[0] as { n: number }).n).toBe(0);
    const activity = await t.handle.db.execute(
      sql`select author_name from revisions where version = 1 and author_name = 'Domain and SSL tracker'`,
    );
    expect(activity.rows.length).toBe(1);

    // Turning off adding certificates is an administrator's setting, recorded as a security event.
    expect((await owner.call('GET', '/api/settings/trackers')).data).toEqual({
      enabled: true,
      createCertificates: true,
    });
    const saved = await owner.call('PUT', '/api/settings/trackers', { enabled: false, createCertificates: false });
    expect(saved.data).toEqual({ enabled: false, createCertificates: false });
    const events = await t.handle.db.execute(sql`select action from security_events`);
    expect(events.rows.map((r) => r.action)).toContain('Domain and SSL tracker settings changed');
  });

  it('hides clients the viewer cannot read, and lets only editors check', async () => {
    const created = await owner.call('POST', '/api/users', {
      email: 'viewer@northline.test',
      name: 'Northline Viewer',
      role: 'client_viewer',
      password: TEMP,
      grants: [{ clientId: northline, level: 'read' }],
    });
    expect(created.status).toBe(201);
    const { b } = await signIn(t.app, 'viewer@northline.test', TEMP);
    const changed = await b.call('POST', '/api/account/password', { current: TEMP, next: 'harbor lights read only 7' });
    expect(changed.data.stage).toBe('active');
    const report = (await b.call('GET', '/api/trackers')).data;
    expect(report.domain.total).toBe(1);
    expect(report.clients.map((c: { clientId: string }) => c.clientId)).toEqual([northline]);
    expect((await b.call('GET', `/api/trackers?client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', `/api/trackers/items?kind=domain&client=${harbor}`)).status).toBe(404);
    expect((await b.call('POST', '/api/trackers/check', { client: northline })).status).toBe(403);
    expect((await b.call('POST', '/api/trackers/check', {})).status).toBe(403);
    expect((await b.call('PUT', '/api/settings/trackers', { enabled: false })).status).toBe(403);
    expect(probed).toEqual([]);
  });
});
