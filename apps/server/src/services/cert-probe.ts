import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { connect, type PeerCertificate } from 'node:tls';

/** What a server's certificate says. */
export interface ServedCertificate {
  host: string;
  /** YYYY-MM-DD the certificate stops being valid. */
  expires: string;
  issuer: string;
  commonName: string;
  altNames: string[];
  /** Whether it chains to a trusted root and matches the host. */
  trusted: boolean;
  /** Why it isn't trusted, in the TLS library's words. */
  problem: string;
}

export type CertProbe = (host: string, port?: number) => Promise<ServedCertificate>;

// Addresses a check must never reach: this network, private ranges, loopback, link-local (including cloud
// metadata), carrier-grade NAT, documentation, benchmarking, multicast, and reserved.
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6');

/** Whether an address is one a check may connect to: public, not private, loopback, or link-local. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;
  // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is judged as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!);
  return !blocked.check(address, 'ipv6');
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Turns what someone typed ("https://portal.example.com/login", "Portal.Example.com.") into a host name to check,
 * or null when it isn't one. Wildcards and IP addresses are refused: a wildcard names no one server, and an
 * address can't be checked against the certificate's names.
 */
export function certificateHost(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = new URL(value).hostname;
  } catch {
    return null;
  }
  value = value
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
  return HOST.test(value) ? value : null;
}

const name = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() ?? '';

/** The issuing organization (Let's Encrypt, DigiCert…), or its common name when it gives none. */
function issuerOf(cert: PeerCertificate) {
  return (name(cert.issuer?.O) || name(cert.issuer?.CN)).slice(0, 200);
}

function altNamesOf(cert: PeerCertificate) {
  return (cert.subjectaltname ?? '')
    .split(/,\s*/)
    .filter((n) => n.startsWith('DNS:'))
    .map((n) => n.slice(4).toLowerCase())
    .slice(0, 100);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref()),
  ]);
}

/**
 * Reads the certificate a host serves on port 443. Read-only: it completes a TLS handshake and closes, sending no
 * request and no credentials. The host must resolve only to public addresses, and the connection goes to the
 * address that was checked, so a DNS answer can't be swapped in between.
 */
export function certProbe(
  options: {
    timeoutMs?: number;
    /** Replaces DNS resolution (tests). */
    resolve?: (host: string) => Promise<{ address: string }[]>;
  } = {},
): CertProbe {
  const timeoutMs = options.timeoutMs ?? 8000;
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }));
  return async (input, port = 443) => {
    const host = certificateHost(input);
    if (!host) throw new Error('Not a host name that can be checked.');
    const addresses = await withTimeout(resolve(host), timeoutMs, 'The name did not resolve in time.').catch(
      (error: Error & { code?: string }) => {
        throw new Error(
          error.code === 'ENOTFOUND' || error.code === 'ENODATA' ? 'The name does not resolve.' : error.message,
        );
      },
    );
    if (!addresses.length) throw new Error('The name does not resolve.');
    if (addresses.some((a) => !isPublicAddress(a.address)))
      throw new Error('The name resolves to a private address, which the tracker does not check.');
    // Try each checked address in turn (an IPv6 address may be listed first where there's no IPv6 route).
    let last: Error = new Error('The name does not resolve.');
    for (const { address } of addresses.slice(0, 4)) {
      try {
        return await read(host, address, port, timeoutMs);
      } catch (error) {
        last = error as Error;
        if (!(error as { retry?: boolean }).retry) break;
      }
    }
    throw last;
  };
}

/** One TLS handshake with one address. Connection failures are marked so the next address can be tried. */
function read(host: string, address: string, port: number, timeoutMs: number) {
  return new Promise<ServedCertificate>((resolve, reject) => {
    const socket = connect({ host: address, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs });
    const fail = (message: string, retry = false) => {
      socket.destroy();
      reject(Object.assign(new Error(message), { retry }));
    };
    socket.once('timeout', () => fail('The server did not answer in time.', true));
    socket.once('error', (error: Error & { code?: string }) =>
      fail(
        error.code === 'ECONNREFUSED'
          ? 'Nothing answers on port 443.'
          : `The secure connection failed (${error.code ?? error.message}).`,
        true,
      ),
    );
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      const problem = authorized ? '' : String(socket.authorizationError ?? '');
      socket.end();
      const expires = cert?.valid_to ? new Date(cert.valid_to) : null;
      if (!cert || !expires || Number.isNaN(expires.getTime())) return fail('The server sent no certificate.');
      resolve({
        host,
        expires: expires.toISOString().slice(0, 10),
        issuer: issuerOf(cert),
        commonName: name(cert.subject?.CN).toLowerCase(),
        altNames: altNamesOf(cert),
        trusted: authorized,
        problem,
      });
    });
  });
}
