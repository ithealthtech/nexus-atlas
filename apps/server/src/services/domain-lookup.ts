import { resolveNs } from 'node:dns/promises';
import { isIP } from 'node:net';

/** What a lookup found. Keys match the built-in Domains layout's field keys. */
export interface DomainDetails {
  domain: string;
  registrar?: string;
  expires?: string;
  nameservers?: string;
  dns_host?: string;
}

// Well-known DNS providers, recognized by their name servers.
const DNS_HOSTS: [RegExp, string][] = [
  [/\.ns\.cloudflare\.com$/, 'Cloudflare'],
  [/\.awsdns-\d+\./, 'Amazon Route 53'],
  [/\.azure-dns\./, 'Azure DNS'],
  [/\.domaincontrol\.com$/, 'GoDaddy'],
  [/\.registrar-servers\.com$/, 'Namecheap'],
  [/\.googledomains\.com$|\.google\.com$/, 'Google'],
  [/\.nsone\.net$/, 'NS1'],
  [/\.dnsmadeeasy\.com$/, 'DNS Made Easy'],
  [/\.ultradns\./, 'UltraDNS'],
  [/\.akam\.net$/, 'Akamai'],
  [/\.name-services\.com$/, 'Enom'],
  [/\.worldnic\.com$/, 'Network Solutions'],
  [/\.hostgator\.com$/, 'HostGator'],
  [/\.bluehost\.com$/, 'Bluehost'],
  [/\.wixdns\.net$/, 'Wix'],
  [/\.squarespacedns\.com$/, 'Squarespace'],
  [/\.digitalocean\.com$/, 'DigitalOcean'],
  [/\.linode\.com$/, 'Akamai (Linode)'],
  [/\.dynect\.net$/, 'Oracle Dyn'],
  [/\.he\.net$/, 'Hurricane Electric'],
  [/\.porkbun\.com$/, 'Porkbun'],
  [/\.hover\.com$/, 'Hover'],
  [/\.ionos\.|\.ui-dns\./, 'IONOS'],
];

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Turns what someone typed ("https://www.Example.com/path", "example.com.") into a domain name,
 * or null when it isn't one (IP addresses, single labels, anything with odd characters).
 */
export function normalizeDomain(input: string): string | null {
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
  if (value.startsWith('www.')) value = value.slice(4);
  if (isIP(value) || !HOSTNAME.test(value)) return null;
  return value;
}

export function dnsHostFor(nameservers: string[]) {
  for (const ns of nameservers) for (const [pattern, name] of DNS_HOSTS) if (pattern.test(ns)) return name;
  return undefined;
}

interface RdapEntity {
  roles?: unknown;
  vcardArray?: unknown;
  entities?: unknown;
}

function registrarName(entities: unknown): string | undefined {
  if (!Array.isArray(entities)) return undefined;
  for (const e of entities as RdapEntity[]) {
    if (Array.isArray(e.roles) && e.roles.includes('registrar') && Array.isArray(e.vcardArray)) {
      const props = e.vcardArray[1];
      if (Array.isArray(props))
        for (const p of props)
          if (Array.isArray(p) && p[0] === 'fn' && typeof p[3] === 'string' && p[3].trim())
            return p[3].trim().slice(0, 200);
    }
  }
  return undefined;
}

/**
 * Looks up a domain's registration (RDAP, via rdap.org's registry redirect) and DNS delegation.
 * Never throws: parts that can't be found are simply missing from the result.
 */
export class DomainLookup {
  constructor(
    private readonly options: {
      fetch?: typeof fetch;
      resolveNs?: (domain: string) => Promise<string[]>;
      timeoutMs?: number;
    } = {},
  ) {}

  async lookup(input: string): Promise<DomainDetails | null> {
    const domain = normalizeDomain(input);
    if (!domain) return null;
    const [rdap, ns] = await Promise.all([this.rdap(domain), this.nameservers(domain)]);
    const details: DomainDetails = { domain, ...rdap };
    if (ns.length) {
      details.nameservers = ns.join('\n');
      const host = dnsHostFor(ns);
      if (host) details.dns_host = host;
    }
    return details;
  }

  private async nameservers(domain: string): Promise<string[]> {
    try {
      const resolve = this.options.resolveNs ?? resolveNs;
      const list = await Promise.race([
        resolve(domain),
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), this.options.timeoutMs ?? 5000).unref(),
        ),
      ]);
      return [...new Set(list.map((n) => n.toLowerCase().replace(/\.$/, '')))].sort().slice(0, 13);
    } catch {
      return [];
    }
  }

  private async rdap(domain: string): Promise<Pick<DomainDetails, 'registrar' | 'expires'>> {
    try {
      const res = await (this.options.fetch ?? fetch)(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        headers: { Accept: 'application/rdap+json, application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 8000),
      });
      if (!res.ok) return {};
      const data = (await res.json()) as { entities?: unknown; events?: unknown };
      const out: Pick<DomainDetails, 'registrar' | 'expires'> = {};
      const registrar = registrarName(data.entities);
      if (registrar) out.registrar = registrar;
      if (Array.isArray(data.events)) {
        const expiry = (data.events as { eventAction?: unknown; eventDate?: unknown }[]).find(
          (e) => e.eventAction === 'expiration' && typeof e.eventDate === 'string',
        );
        const date = expiry && new Date(expiry.eventDate as string);
        if (date && !Number.isNaN(date.getTime())) out.expires = date.toISOString().slice(0, 10);
      }
      return out;
    } catch {
      return {};
    }
  }
}
