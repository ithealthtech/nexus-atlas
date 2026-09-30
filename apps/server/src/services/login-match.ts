import { parse } from 'tldts';

/**
 * Whether a saved login's address belongs to a page, for the browser extension.
 *
 * - `exact`: the same host name (ports aside).
 * - `domain`: another host under the same registrable domain, such as portal.example.com for login.example.com.
 *   The public suffix list decides the registrable domain, including private suffixes like github.io, so two
 *   customers' sites on a shared host never match each other.
 *
 * IP addresses and single-label names (a device at 192.168.1.1, a NAS called "nas") only ever match exactly.
 * A login saved with https never matches a plain-http page, so a downgraded page can't collect it.
 */
export type LoginMatch = 'exact' | 'domain';

export interface Site {
  protocol: 'http:' | 'https:';
  host: string;
  /** Registrable domain, or null for IP addresses and names without a public suffix. */
  domain: string | null;
}

/** The page or saved address as a site, or null when it isn't a web address. Addresses saved without a scheme are read as https. */
export function siteOf(address: string): Site | null {
  const trimmed = address.trim();
  // Another scheme without slashes (mailto:, tel:) isn't a web address; "host:port" is one saved without a scheme.
  if (!trimmed || (!trimmed.includes('://') && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed))) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (!host) return null;
  const parsed = parse(host, { allowPrivateDomains: true });
  const domain = parsed.isIp || !parsed.domain || !parsed.publicSuffix ? null : parsed.domain;
  return { protocol: url.protocol, host, domain };
}

export function matchLogin(saved: string, page: Site): LoginMatch | null {
  const site = siteOf(saved);
  if (!site) return null;
  if (site.protocol === 'https:' && page.protocol !== 'https:') return null;
  if (site.host === page.host) return 'exact';
  if (site.domain && site.domain === page.domain) return 'domain';
  return null;
}
