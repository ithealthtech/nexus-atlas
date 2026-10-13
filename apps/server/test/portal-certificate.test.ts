import { X509Certificate } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PortalCertificate,
  caddyAuthorities,
  probeChain,
  type ServedChain,
} from '../src/services/portal-certificate.js';
import { INTERMEDIATE, LEAF, OTHER_ROOT, ROOT, SELF_SIGNED } from './portal-certs.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const cert = (pem: string) => new X509Certificate(pem);
/** What a server presented, and the TLS library's verdict on it (null: a public authority vouches for it). */
const served = (pems: string[], error: string | null): ServedChain => ({
  chain: pems.map(cert),
  authorized: error === null,
  error,
});
const same = (a: string, b: string) => expect(cert(a).fingerprint256).toBe(cert(b).fingerprint256);

describe('PortalCertificate', () => {
  it('finds the authority behind a certificate from the server’s own web proxy, and proves it', async () => {
    const asked: [string, number][] = [];
    const portal = new PortalCertificate({
      publicUrl: 'https://192.168.1.220',
      // As Caddy serves it: the certificate and its intermediate, but not the root.
      probe: async (host, port) => {
        asked.push([host, port]);
        return served([LEAF, INTERMEDIATE], 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
      },
      // The proxy's answer is not taken on trust: only the root that signed what was served is accepted.
      authorities: async () => [OTHER_ROOT, 'not a certificate', ROOT],
      now: () => NOW,
    });
    const view = await portal.view();
    expect(asked).toEqual([['192.168.1.220', 443]]);
    expect(view).toMatchObject({
      url: 'https://192.168.1.220',
      host: '192.168.1.220',
      status: 'private',
      problem: null,
      coversHost: true,
      certificate: {
        // It has no name of its own, only the addresses it covers.
        name: '192.168.1.220',
        issuer: 'Atlas Test Local Authority - Intermediate',
        names: ['192.168.1.220', 'atlas.lan'],
        fingerprint: cert(LEAF).fingerprint256,
      },
      authority: {
        name: 'Atlas Test Local Authority - Root',
        isAuthority: true,
        source: 'proxy',
        fingerprint: cert(ROOT).fingerprint256,
      },
    });
    // What Windows shows when the file is installed, so the two can be compared.
    expect(view.authority!.thumbprint).toMatch(/^[0-9A-F]{40}$/);
    expect(view.authority!.thumbprint).toBe(cert(ROOT).fingerprint.replace(/:/g, ''));
    expect(view.certificate!.daysLeft).toBeGreaterThan(36_000);
    expect(view.certificate!.validTo).toMatch(/^21\d\d-/);

    const file = await portal.authorityFile();
    expect(file!.filename).toBe('atlas-certificate-authority.crt');
    expect(file!.pem).toContain('-----BEGIN CERTIFICATE-----');
    expect(file!.pem).not.toContain('PRIVATE KEY');
    same(file!.pem, ROOT);
  });

  it('offers nothing when the proxy’s authority didn’t sign what is served', async () => {
    const portal = new PortalCertificate({
      publicUrl: 'https://192.168.1.220',
      probe: async () => served([LEAF, INTERMEDIATE], 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'),
      authorities: async () => [OTHER_ROOT, INTERMEDIATE, LEAF],
      now: () => NOW,
    });
    expect(await portal.view()).toMatchObject({ status: 'private', authority: null });
    expect(await portal.authorityFile()).toBeNull();
  });

  it('has nothing to install when a public authority already vouches for it', async () => {
    let asked = 0;
    const portal = new PortalCertificate({
      publicUrl: 'https://atlas.lan',
      probe: async () => served([LEAF, INTERMEDIATE], null),
      authorities: async () => {
        asked++;
        return [ROOT];
      },
      now: () => NOW,
    });
    expect(await portal.view()).toMatchObject({ status: 'trusted', coversHost: true, authority: null });
    expect(await portal.authorityFile()).toBeNull();
    expect(asked).toBe(0);
  });

  it('treats a lone self-signed certificate as its own thing to trust, for that one site', async () => {
    const asked: [string, number][] = [];
    const portal = new PortalCertificate({
      publicUrl: 'https://atlas.example.internal:8443/somewhere',
      probe: async (host, port) => {
        asked.push([host, port]);
        return served([SELF_SIGNED], 'DEPTH_ZERO_SELF_SIGNED_CERT');
      },
      now: () => NOW,
    });
    const view = await portal.view();
    expect(asked).toEqual([['atlas.example.internal', 8443]]);
    expect(view).toMatchObject({
      url: 'https://atlas.example.internal:8443',
      status: 'private',
      coversHost: true,
      certificate: { name: 'atlas.example.internal', issuer: 'Itself (self-signed)' },
      authority: { name: 'atlas.example.internal', isAuthority: false, source: 'served' },
    });
    same((await portal.authorityFile())!.pem, SELF_SIGNED);
  });

  it('says when the certificate is for another address, has expired, or is refused for another reason', async () => {
    const reading = (publicUrl: string, error: string, now = NOW) =>
      new PortalCertificate({
        publicUrl,
        probe: async () => served([LEAF, INTERMEDIATE], error),
        now: () => now,
      }).view();
    expect(await reading('https://elsewhere.example.com', 'ERR_TLS_CERT_ALTNAME_INVALID')).toMatchObject({
      status: 'mismatch',
      coversHost: false,
      authority: null,
    });
    const later = Date.parse('2200-01-01T00:00:00.000Z');
    const expired = await reading('https://atlas.lan', 'CERT_HAS_EXPIRED', later);
    expect(expired.status).toBe('expired');
    expect(expired.certificate!.daysLeft).toBeLessThan(0);
    expect(await reading('https://atlas.lan', 'CERT_REVOKED')).toMatchObject({
      status: 'untrusted',
      problem: 'Computers refuse it (CERT_REVOKED).',
    });
  });

  it('doesn’t connect anywhere without HTTPS, and says so when it can’t connect', async () => {
    let connected = 0;
    const plain = new PortalCertificate({
      publicUrl: 'http://localhost:4318',
      probe: async () => {
        connected++;
        return served([LEAF], null);
      },
    });
    expect(await plain.view()).toMatchObject({ status: 'none', certificate: null, authority: null });
    expect(connected).toBe(0);

    const down = new PortalCertificate({
      publicUrl: 'https://atlas.lan',
      probe: async () => {
        throw new Error('connect ECONNREFUSED 192.168.1.220:443');
      },
    });
    const view = await down.view();
    expect(view.status).toBe('unreachable');
    expect(view.problem).toContain('ECONNREFUSED');
    expect(await down.authorityFile()).toBeNull();
  });

  it('reads the certificate at most every half a minute', async () => {
    let now = NOW;
    let connected = 0;
    const portal = new PortalCertificate({
      publicUrl: 'https://atlas.lan',
      probe: async () => {
        connected++;
        return served([LEAF, INTERMEDIATE], null);
      },
      now: () => now,
    });
    await portal.view();
    await portal.authorityFile();
    now += 29_000;
    await portal.view();
    expect(connected).toBe(1);
    now += 2000;
    await portal.view();
    expect(connected).toBe(2);
  });
});

describe('caddyAuthorities', () => {
  const answering = (status: number, body: unknown) => {
    const urls: string[] = [];
    const fn = (async (url: URL | string) => {
      urls.push(String(url));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
    return { fn, urls };
  };

  it('reads the root certificate from Caddy’s local admin address', async () => {
    const caddy = answering(200, {
      id: 'local',
      name: 'Caddy Local Authority',
      root_common_name: 'Caddy Local Authority - 2026 ECC Root',
      root_certificate: ROOT,
      intermediate_certificate: INTERMEDIATE,
    });
    expect(await caddyAuthorities(undefined, caddy.fn)()).toEqual([ROOT]);
    expect(caddy.urls).toEqual(['http://127.0.0.1:2019/pki/ca/local']);
  });

  it('comes back empty when Caddy isn’t there or answers something else', async () => {
    expect(await caddyAuthorities(undefined, answering(404, 'not found').fn)()).toEqual([]);
    expect(await caddyAuthorities(undefined, answering(200, '<html>').fn)()).toEqual([]);
    expect(await caddyAuthorities(undefined, answering(200, { root_certificate: 42 }).fn)()).toEqual([]);
    expect(await caddyAuthorities(undefined, answering(200, { root_certificate: 'x'.repeat(30_000) }).fn)()).toEqual(
      [],
    );
    const refused = (async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:2019');
    }) as typeof fetch;
    expect(await caddyAuthorities(undefined, refused)()).toEqual([]);
  });
});

// CI starts a real Caddy with its own certificate authority (the installer's setup for an address with no public
// name) and points this at it, so the connection, Caddy's admin API, and the proof are all the real thing.
describe.skipIf(!process.env.ATLAS_TEST_CADDY)('against a real Caddy', () => {
  it('reads what Caddy serves and gets the authority that signed it', async () => {
    const publicUrl = process.env.ATLAS_TEST_CADDY!;
    const host = new URL(publicUrl).hostname;
    const portal = new PortalCertificate({ publicUrl, probe: probeChain, authorities: caddyAuthorities() });
    // Caddy issues the certificate the first time the address is asked for, so give it a moment.
    let view = await portal.view();
    for (let i = 0; i < 20 && view.status === 'unreachable'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      view = await new PortalCertificate({ publicUrl, probe: probeChain, authorities: caddyAuthorities() }).view();
    }
    expect(view.status, JSON.stringify(view)).toBe('private');
    expect(view.coversHost).toBe(true);
    expect(view.certificate!.names).toContain(host);
    expect(view.certificate!.daysLeft).toBeGreaterThanOrEqual(0);
    expect(view.authority, JSON.stringify(view)).toMatchObject({ isAuthority: true, source: 'proxy' });

    const fresh = new PortalCertificate({ publicUrl, probe: probeChain, authorities: caddyAuthorities() });
    const file = await fresh.authorityFile();
    const root = new X509Certificate(file!.pem);
    expect(root.ca).toBe(true);
    expect(root.checkIssued(root)).toBe(true);
    // The root really is the top of what the connection presents.
    const { chain } = await probeChain(host, Number(new URL(publicUrl).port) || 443);
    const top = chain.at(-1)!;
    expect(top.verify(root.publicKey) || top.fingerprint256 === root.fingerprint256).toBe(true);
  });
});

describe('certificate routes', () => {
  let t: TestApp;
  let owner: Browser;

  beforeEach(async () => {
    t = await startApp(
      {},
      {
        portalProbe: async () => {
          throw new Error('the test server has no HTTPS address to read');
        },
      },
    );
    ({ b: owner } = await setupOwner(t.app));
  });
  afterEach(async () => {
    await t.close();
  });

  it('shows administrators the certificate, and has nothing to download without HTTPS', async () => {
    const view = await owner.call('GET', '/api/system/certificate');
    expect(view.status).toBe(200);
    expect(view.data).toMatchObject({ url: 'http://localhost', status: 'none', certificate: null, authority: null });
    expect((await owner.call('GET', '/api/system/certificate/authority')).status).toBe(404);

    expect((await t.app.inject({ method: 'GET', url: '/api/system/certificate' })).statusCode).toBe(401);
    await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess Tech',
      password: 'temporary pass 1234',
      role: 'technician',
      allClients: 'edit_passwords',
    });
    const { b: tech, r: signedIn } = await signIn(t.app, 'tess@atlas.test', 'temporary pass 1234');
    expect(signedIn.status, JSON.stringify(signedIn.data)).toBeLessThan(300);
    await tech.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    await enroll(tech);
    expect((await tech.call('GET', '/api/system/certificate')).status).toBe(403);
    expect((await tech.call('GET', '/api/system/certificate/authority')).status).toBe(403);
  });
});
