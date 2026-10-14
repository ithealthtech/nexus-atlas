import { X509Certificate } from 'node:crypto';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import type { PortalCertificateStatus, PortalCertificateView } from '@atlas/shared';

/** The certificates a server presented, leaf first, and whether a public authority vouches for them. */
export interface ServedChain {
  chain: X509Certificate[];
  authorized: boolean;
  /** The TLS library's reason when not authorized, such as SELF_SIGNED_CERT_IN_CHAIN. */
  error: string | null;
}
export type ChainProbe = (host: string, port: number) => Promise<ServedChain>;
/** Root certificates (PEM) that the web proxy on this server issues from, if it will say. */
export type AuthorityFetch = () => Promise<string[]>;

const CACHE_MS = 30_000;
const DAY_MS = 86_400_000;

/** Connects the way a browser would and keeps what was presented, trusted or not. */
export const probeChain: ChainProbe = (host, port) =>
  new Promise((resolve, reject) => {
    const socket = connect({
      host,
      port,
      // An IP address is never sent as a server name; the certificate is checked against the address itself.
      servername: isIP(host) ? undefined : host,
      // The point is to read a certificate that may not be trusted. Nothing is sent over this connection.
      rejectUnauthorized: false,
      timeout: 8000,
    });
    socket.once('secureConnect', () => {
      const chain: X509Certificate[] = [];
      let cert = socket.getPeerX509Certificate();
      while (cert && chain.length < 10) {
        chain.push(cert);
        const next = cert.issuerCertificate;
        if (!next || next.fingerprint256 === cert.fingerprint256) break;
        cert = next;
      }
      const authorized = socket.authorized;
      const error = authorized ? null : String(socket.authorizationError ?? 'unknown');
      socket.destroy();
      resolve({ chain, authorized, error });
    });
    socket.once('timeout', () => socket.destroy(new Error('The connection timed out.')));
    socket.once('error', reject);
  });

/** A plain GET, answered with a status and a body. */
export type HttpGet = (url: URL) => Promise<{ status: number; body: string }>;

// Not fetch: fetch marks its requests the way a browser does (Sec-Fetch-Mode), and Caddy's admin address refuses
// those unless they come from an origin it allows, as protection against web pages reaching it.
const httpGet: HttpGet = (url) =>
  new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', headers: { accept: 'application/json' }, timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 100_000) req.destroy(new Error('The answer was too large.'));
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('The request timed out.')));
    req.on('error', reject);
    req.end();
  });

/**
 * Caddy, which the Linux installer sets up in front of Atlas, describes its own certificate authority on its
 * local admin address. Only its public root certificate is read. Anything else answering there is ignored, and
 * what comes back is only ever used after checking that it really issued the certificate the portal serves.
 */
export const caddyAuthorities =
  (adminUrl = 'http://127.0.0.1:2019', get: HttpGet = httpGet): AuthorityFetch =>
  async () => {
    try {
      const res = await get(new URL('/pki/ca/local', adminUrl));
      if (res.status !== 200) return [];
      const body = JSON.parse(res.body) as { root_certificate?: unknown } | null;
      const root = body?.root_certificate;
      return typeof root === 'string' && root.length < 20_000 ? [root] : [];
    } catch {
      return [];
    }
  };

/** Signed by itself: a root authority, or a lone self-signed certificate. */
const selfIssued = (cert: X509Certificate) => {
  try {
    return cert.checkIssued(cert) && cert.verify(cert.publicKey);
  } catch {
    return false;
  }
};
const issuedBy = (cert: X509Certificate, issuer: X509Certificate) => {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey);
  } catch {
    return false;
  }
};

/**
 * The common name (or organization) from a subject or issuer, which Node gives one field to a line. A certificate
 * issued for an address alone has no subject at all, and Node then gives undefined, whatever its types say.
 */
function nameOf(distinguished: string | undefined): string | null {
  const fields = new Map(
    (distinguished ?? '')
      .split('\n')
      .map((line) => line.split('='))
      .filter((p) => p.length >= 2)
      .map(([key, ...rest]) => [key!.trim(), rest.join('=').trim()] as const),
  );
  return fields.get('CN') || fields.get('O') || null;
}

/** The addresses a certificate covers: "DNS:atlas.example.com, IP Address:192.168.1.20". */
function namesOf(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? '')
    .split(',')
    .map((part) => part.trim())
    .map((part) => /^(?:DNS|IP Address):(.+)$/.exec(part)?.[1]?.trim())
    .filter((name): name is string => !!name);
}

const covers = (cert: X509Certificate, host: string) => {
  try {
    return isIP(host) ? cert.checkIP(host) !== undefined : cert.checkHost(host) !== undefined;
  } catch {
    return false;
  }
};

// Reasons that mean "nobody public vouches for this", as opposed to an expired or mismatched certificate.
const PRIVATE_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

interface Reading {
  view: PortalCertificateView;
  authority: X509Certificate | null;
}

/**
 * What certificate the portal serves, read the way a visitor's computer reads it: by connecting to the public
 * address. When it comes from this server's own certificate authority (the installer's choice for an address
 * with no public name), browsers and Atlas for Windows refuse it until that authority's certificate is installed
 * on the computer. This finds that certificate, proves it is the one behind what is being served, and hands it
 * out. It is a public certificate; the authority's private key never leaves the web proxy.
 */
export class PortalCertificate {
  private cache: { at: number; reading: Reading } | null = null;

  constructor(
    private readonly options: {
      publicUrl: string;
      probe?: ChainProbe;
      authorities?: AuthorityFetch;
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async read(): Promise<Reading> {
    if (this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache.reading;
    const reading = await this.readNow();
    this.cache = { at: this.now(), reading };
    return reading;
  }

  private async readNow(): Promise<Reading> {
    const url = new URL(this.options.publicUrl);
    // IPv6 addresses come bracketed in a URL.
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const base = { url: url.origin, host, certificate: null, coversHost: false, authority: null } as const;
    if (url.protocol !== 'https:')
      return {
        view: { ...base, status: 'none', problem: 'Atlas isn’t served over HTTPS at this address.' },
        authority: null,
      };

    let served: ServedChain;
    try {
      served = await (this.options.probe ?? probeChain)(host, Number(url.port) || 443);
    } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : 'unknown reason';
      return {
        view: {
          ...base,
          status: 'unreachable',
          problem: `Atlas couldn’t connect to ${url.host} to read it (${reason}).`,
        },
        authority: null,
      };
    }
    const leaf = served.chain[0];
    if (!leaf)
      return {
        view: { ...base, status: 'unreachable', problem: `${url.host} didn’t present a certificate.` },
        authority: null,
      };

    // The certificate that would make a computer trust this one: the root it was served with, or the web
    // proxy's own root, but only if it really signed the top of what was served.
    const top = served.chain.at(-1)!;
    let authority: X509Certificate | null = null;
    let source: 'served' | 'proxy' = 'served';
    if (!served.authorized) {
      if (selfIssued(top)) authority = top;
      else
        for (const pem of await (this.options.authorities ?? (async () => []))()) {
          try {
            const root = new X509Certificate(pem);
            if (selfIssued(root) && issuedBy(top, root)) {
              authority = root;
              source = 'proxy';
              break;
            }
          } catch {
            // Not a certificate.
          }
        }
    }

    const coversHost = covers(leaf, host);
    const status: PortalCertificateStatus = served.authorized
      ? 'trusted'
      : served.error === 'CERT_HAS_EXPIRED'
        ? 'expired'
        : authority || PRIVATE_ERRORS.has(served.error ?? '')
          ? 'private'
          : !coversHost
            ? 'mismatch'
            : 'untrusted';
    const describe = (cert: X509Certificate) => ({
      validFrom: new Date(cert.validFrom).toISOString(),
      validTo: new Date(cert.validTo).toISOString(),
      daysLeft: Math.floor((new Date(cert.validTo).getTime() - this.now()) / DAY_MS),
      fingerprint: cert.fingerprint256,
      thumbprint: cert.fingerprint.replace(/:/g, ''),
    });
    return {
      authority,
      view: {
        url: url.origin,
        host,
        status,
        problem: status === 'untrusted' ? `Computers refuse it (${served.error}).` : null,
        coversHost,
        certificate: {
          // Certificates issued for an address alone often have no name of their own.
          name: nameOf(leaf.subject) ?? namesOf(leaf)[0] ?? host,
          issuer: selfIssued(leaf) ? 'Itself (self-signed)' : (nameOf(leaf.issuer) ?? 'Unknown'),
          names: namesOf(leaf),
          ...describe(leaf),
        },
        authority: authority
          ? {
              name: nameOf(authority.subject) ?? 'This server’s certificate',
              // A lone self-signed certificate is its own authority: trusting it trusts this one site.
              isAuthority: authority.ca,
              source,
              ...describe(authority),
            }
          : null,
      },
    };
  }

  async view(): Promise<PortalCertificateView> {
    return (await this.read()).view;
  }

  /** The certificate to install on computers so they trust the portal, or null when there's nothing to install. */
  async authorityFile(): Promise<{ filename: string; pem: string } | null> {
    const { authority } = await this.read();
    return authority ? { filename: 'atlas-certificate-authority.crt', pem: authority.toString() } : null;
  }
}
