import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DomainLookup, dnsHostFor, normalizeDomain } from '../src/services/domain-lookup.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const RDAP = {
  entities: [
    { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'Someone Else']]] },
    {
      roles: ['registrar'],
      vcardArray: [
        'vcard',
        [
          ['version', {}, 'text', '4.0'],
          ['fn', {}, 'text', 'Example Registrar, LLC'],
        ],
      ],
    },
  ],
  events: [
    { eventAction: 'registration', eventDate: '2001-03-04T05:00:00Z' },
    { eventAction: 'expiration', eventDate: '2027-03-04T05:00:00Z' },
  ],
};

function fakeLookup(opts: { rdap?: unknown; status?: number; ns?: string[] | Error } = {}) {
  const urls: string[] = [];
  const lookup = new DomainLookup({
    fetch: (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(opts.rdap ?? RDAP), { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
    resolveNs: async () => {
      if (opts.ns instanceof Error) throw opts.ns;
      return opts.ns ?? ['NS2.Example-DNS.ns.cloudflare.com.', 'ns1.example-dns.ns.cloudflare.com'];
    },
  });
  return { lookup, urls };
}

describe('normalizeDomain', () => {
  it('reduces URLs and typed names to the domain', () => {
    expect(normalizeDomain(' https://www.Example.com/path?q=1 ')).toBe('example.com');
    expect(normalizeDomain('shop.example.co.uk.')).toBe('shop.example.co.uk');
    expect(normalizeDomain('example.com:8443')).toBe('example.com');
  });
  it('rejects IPs, single labels, and odd input', () => {
    for (const bad of ['', '10.20.0.1', 'localhost', 'exa mple.com', 'example..com', '-bad.com', 'a@b.com'])
      expect(normalizeDomain(bad), bad).toBeNull();
  });
});

describe('DomainLookup', () => {
  it('finds registrar, expiry, name servers, and DNS host', async () => {
    const { lookup, urls } = fakeLookup();
    expect(await lookup.lookup('https://www.example.com')).toEqual({
      domain: 'example.com',
      registrar: 'Example Registrar, LLC',
      expires: '2027-03-04',
      nameservers: 'ns1.example-dns.ns.cloudflare.com\nns2.example-dns.ns.cloudflare.com',
      dns_host: 'Cloudflare',
    });
    expect(urls).toEqual(['https://rdap.org/domain/example.com']);
  });

  it('returns what it can when RDAP or DNS fail', async () => {
    expect(await fakeLookup({ status: 404 }).lookup.lookup('example.com')).toMatchObject({
      domain: 'example.com',
      dns_host: 'Cloudflare',
    });
    const noDns = await fakeLookup({ ns: new Error('ENOTFOUND') }).lookup.lookup('example.com');
    expect(noDns).toEqual({ domain: 'example.com', registrar: 'Example Registrar, LLC', expires: '2027-03-04' });
    expect(
      await fakeLookup({ rdap: { events: [{ eventAction: 'expiration', eventDate: 'garbage' }] } }).lookup.lookup(
        'example.com',
      ),
    ).not.toHaveProperty('expires');
  });

  it('names common DNS providers', () => {
    expect(dnsHostFor(['ns-1.awsdns-01.org'])).toBe('Amazon Route 53');
    expect(dnsHostFor(['ns1-02.azure-dns.com'])).toBe('Azure DNS');
    expect(dnsHostFor(['ns71.domaincontrol.com'])).toBe('GoDaddy');
    expect(dnsHostFor(['ns1.unknown-host.example'])).toBeUndefined();
  });
});

describe('Domains assets', () => {
  let t: TestApp;
  let owner: Browser;
  let client: string;
  let domainLayout: string;
  let otherLayout: string;

  beforeEach(async () => {
    t = await startApp({}, { domainLookup: fakeLookup().lookup });
    ({ b: owner } = await setupOwner(t.app));
    client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    domainLayout = layouts.find((l) => l.key === 'domain')!.id;
    otherLayout = layouts.find((l) => l.key === 'application')!.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('fills blank fields on create and keeps what was entered', async () => {
    const created = await owner.call('POST', `/api/clients/${client}/assets`, {
      layoutId: domainLayout,
      name: 'harbordental.example.com',
      fields: { registrar: 'Typed by hand' },
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    expect(created.data.fields).toMatchObject({
      registrar: 'Typed by hand',
      expires: '2027-03-04',
      dns_host: 'Cloudflare',
      nameservers: expect.stringContaining('ns1.example-dns.ns.cloudflare.com'),
    });
  });

  it('fills a field cleared on update, but not other layouts', async () => {
    const created = (
      await owner.call('POST', `/api/clients/${client}/assets`, {
        layoutId: domainLayout,
        name: 'harbordental.example.com',
        fields: {},
      })
    ).data;
    const updated = await owner.call('PATCH', `/api/assets/${created.id}`, {
      version: created.version,
      fields: { ...created.fields, dns_host: '' },
    });
    expect(updated.data.fields.dns_host).toBe('Cloudflare');

    const app = await owner.call('POST', `/api/clients/${client}/assets`, {
      layoutId: otherLayout,
      name: 'example.com',
      fields: {},
    });
    expect(app.data.fields).toEqual({});
  });

  it('looks a domain up without saving, and rejects non-domains', async () => {
    const found = await owner.call('POST', '/api/domains/lookup', { domain: 'https://www.example.com/' });
    expect(found.status).toBe(200);
    expect(found.data).toMatchObject({ domain: 'example.com', registrar: 'Example Registrar, LLC' });
    expect((await owner.call('POST', '/api/domains/lookup', { domain: '10.0.0.1' })).status).toBe(400);
    expect((await owner.call('POST', '/api/domains/lookup', {})).status).toBe(400);
    expect((await t.app.inject({ method: 'POST', url: '/api/domains/lookup', payload: {} })).statusCode).toBe(401);
  });
});
