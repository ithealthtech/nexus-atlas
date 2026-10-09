import { X509Certificate, randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';
import { samlSettingsSchema, type SamlServiceProvider, type SamlView } from '@atlas/shared';
import { open, seal, type KeyProvider } from '../crypto/keys.js';
import { HttpError } from '../errors.js';
import type { StoredSaml } from './settings.js';

const REQUEST_TTL_MS = 10 * 60_000;
const MAX_CERTS = 3;

/** What a sign-in remembers between sending the person to the identity provider and their return. */
interface Pending {
  id: string;
  expires: number;
}

export interface SamlIdentity {
  /** The identity provider's name ID for the account. What an Atlas account is linked to. */
  subject: string;
  email: string;
  name: string;
}

// Where identity providers put the email address and display name, most specific first.
const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'emailAddress',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
];
const NAME_ATTRIBUTES = [
  'displayName',
  'name',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
  'urn:oid:2.16.840.1.113730.3.1.241',
];
const GIVEN = ['firstName', 'givenName', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'];
const FAMILY = ['lastName', 'surname', 'sn', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const first = (profile: Profile, names: string[]) => {
  for (const name of names) {
    const value = profile[name];
    const text = Array.isArray(value) ? value[0] : value;
    if (typeof text === 'string' && text.trim()) return text.trim();
  }
  return '';
};

/** The certificates in pasted text: PEM blocks, or one bare base64 certificate. Each is checked to parse. */
export function parseCertificates(text: string): string[] {
  const blocks = [...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map(
    (m) => m[1]!,
  );
  const candidates = (blocks.length ? blocks : [text]).map((b) => b.replace(/\s+/g, ''));
  const problem = 'That isn’t a certificate. Paste the signing certificate (X.509) from your identity provider.';
  if (!candidates.length || candidates.length > MAX_CERTS)
    throw new HttpError(400, problem, undefined, { idpCert: problem });
  for (const der of candidates) {
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(der)) throw new Error('not base64');
      new X509Certificate(Buffer.from(der, 'base64'));
    } catch {
      throw new HttpError(400, problem, undefined, { idpCert: problem });
    }
  }
  return [...new Set(candidates)];
}

const certificateInfo = (der: string) => {
  const cert = new X509Certificate(Buffer.from(der, 'base64'));
  return {
    subject: cert.subject.replace(/\n/g, ', '),
    expires: new Date(cert.validTo).toISOString(),
    fingerprint: cert.fingerprint256,
  };
};

/**
 * SAML 2.0 sign-in, as a service provider: Atlas sends the person to the identity provider (HTTP-Redirect) and takes
 * the signed response back by form post. The XML checks (signature against the saved certificate, issuer, audience,
 * validity window, and which request is being answered) are done by @node-saml/node-saml; this class decides what
 * is asked of it and reads the result.
 */
export class SamlService {
  // Requests already answered, so a captured response can't be used a second time while it is still in date.
  private used = new Map<string, number>();

  constructor(private readonly keys: KeyProvider) {}

  private aad = 'saml|request';

  serviceProvider(publicOrigin: string): SamlServiceProvider {
    return {
      entityId: `${publicOrigin}/api/auth/saml/metadata`,
      acsUrl: `${publicOrigin}/api/auth/saml/acs`,
      metadataUrl: `${publicOrigin}/api/auth/saml/metadata`,
    };
  }

  /** Checks settings from the form and turns them into what is stored. A certificate left out keeps the saved one. */
  settingsFrom(input: unknown, current: StoredSaml | null): StoredSaml {
    const body = samlSettingsSchema.parse(input);
    const idpCerts = body.idpCert ? parseCertificates(body.idpCert) : current?.idpCerts;
    if (!idpCerts?.length) {
      const problem = 'Paste the signing certificate from your identity provider.';
      throw new HttpError(400, problem, undefined, { idpCert: problem });
    }
    return {
      name: body.name,
      entryPoint: body.entryPoint,
      idpIssuer: body.idpIssuer,
      idpCerts,
      enabled: body.enabled,
      trustMfa: body.trustMfa && body.enabled,
      requireSso: body.requireSso && body.enabled,
    };
  }

  view(settings: StoredSaml): SamlView {
    return {
      name: settings.name,
      entryPoint: settings.entryPoint,
      idpIssuer: settings.idpIssuer,
      certificates: settings.idpCerts.map(certificateInfo),
      enabled: settings.enabled,
      trustMfa: settings.trustMfa,
      requireSso: settings.requireSso,
    };
  }

  private client(settings: StoredSaml, sp: SamlServiceProvider, requestId: string | null) {
    return new SAML({
      entryPoint: settings.entryPoint,
      callbackUrl: sp.acsUrl,
      issuer: sp.entityId,
      audience: sp.entityId,
      idpIssuer: settings.idpIssuer,
      idpCert: settings.idpCerts,
      // The assertion is what says who signed in, so it must be signed itself. Providers differ on whether they
      // also sign the response around it.
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      signatureAlgorithm: 'sha256',
      identifierFormat: null,
      // Which sign-in methods to use is the identity provider's policy, not something Atlas asks for.
      disableRequestedAuthnContext: true,
      acceptedClockSkewMs: 120_000,
      maxAssertionAgeMs: REQUEST_TTL_MS,
      // Only an answer to the request this browser made is accepted: never an unsolicited response.
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_MS,
      generateUniqueId: () => requestId ?? `_${randomBytes(20).toString('hex')}`,
      cacheProvider: {
        saveAsync: async () => null,
        // The library reads the value as when the request was made, to apply the expiry above.
        getAsync: async (key) => (requestId && key === requestId ? new Date().toISOString() : null),
        removeAsync: async () => null,
      },
    });
  }

  /** The address to send the person to, and the sealed cookie value that remembers which request was made. */
  async begin(settings: StoredSaml, sp: SamlServiceProvider): Promise<{ url: string; cookie: string }> {
    const pending: Pending = { id: `_${randomBytes(20).toString('hex')}`, expires: Date.now() + REQUEST_TTL_MS };
    const url = await this.client(settings, sp, pending.id).getAuthorizeUrlAsync('', undefined, {});
    return { url, cookie: seal(this.keys, JSON.stringify(pending), this.aad) };
  }

  /** Checks the identity provider's response and returns who signed in. Any doubt is a refusal. */
  async complete(
    settings: StoredSaml,
    sp: SamlServiceProvider,
    response: string | undefined,
    cookie: string | undefined,
  ): Promise<SamlIdentity> {
    const expired = new HttpError(400, 'That sign-in took too long. Try again.', 'sso_expired');
    if (!cookie) throw expired;
    let pending: Pending;
    try {
      pending = JSON.parse(open(this.keys, cookie, this.aad)) as Pending;
    } catch {
      throw expired;
    }
    const now = Date.now();
    if (!pending.id || pending.expires < now) throw expired;
    for (const [id, until] of this.used) if (until < now) this.used.delete(id);
    if (this.used.has(pending.id)) throw expired;
    if (!response || response.length > 400_000) throw new HttpError(400, 'Sign-in failed.', 'sso_failed');

    let profile: Profile | null;
    try {
      ({ profile } = await this.client(settings, sp, pending.id).validatePostResponseAsync({
        SAMLResponse: response,
      }));
    } catch {
      // The library's messages describe the XML; the person only needs to know it didn't work.
      throw new HttpError(401, 'Sign-in failed.', 'sso_failed');
    }
    if (!profile?.nameID || profile.issuer !== settings.idpIssuer)
      throw new HttpError(401, 'Sign-in failed.', 'sso_failed');
    this.used.set(pending.id, pending.expires);

    const fromAttribute = first(profile, EMAIL_ATTRIBUTES);
    const email = (EMAIL.test(fromAttribute) ? fromAttribute : EMAIL.test(profile.nameID) ? profile.nameID : '')
      .toLowerCase()
      .slice(0, 254);
    const name =
      first(profile, NAME_ATTRIBUTES) || [first(profile, GIVEN), first(profile, FAMILY)].filter(Boolean).join(' ');
    return { subject: profile.nameID.slice(0, 500), email, name: name.slice(0, 200) };
  }

  /** The XML an identity provider can import to learn Atlas's entity ID and where to post responses. */
  metadata(sp: SamlServiceProvider): string {
    const settings: StoredSaml = {
      name: '',
      entryPoint: 'https://idp.invalid/sso',
      idpIssuer: 'unset',
      idpCerts: ['unset'],
      enabled: false,
      trustMfa: false,
      requireSso: false,
    };
    return this.client(settings, sp, null).generateServiceProviderMetadata(null, null);
  }
}
