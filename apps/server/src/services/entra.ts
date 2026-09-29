import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { open, seal, type KeyProvider } from '../crypto/keys.js';
import { HttpError } from '../errors.js';
import type { StoredEntra } from './settings.js';

const LOGIN = 'https://login.microsoftonline.com';
const STATE_TTL_MS = 10 * 60_000;
const b64url = (buf: Buffer) => buf.toString('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What a sign-in needs to remember between sending the person to Microsoft and their return. */
interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  expires: number;
}

export interface EntraIdentity {
  /** The account's object ID: stable, unlike its email address. */
  oid: string;
  email: string;
  name: string;
  tenant: string;
  /** Microsoft asked for more than a password (its "mfa" authentication method). */
  mfa: boolean;
}

/** Sign-in with Microsoft Entra ID: OpenID Connect authorization code flow with PKCE and a client secret. */
export class EntraService {
  private jwks = new Map<string, { keys: { kid: string; [k: string]: unknown }[]; at: number }>();

  constructor(
    private readonly keys: KeyProvider,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private aad = 'entra|state';

  /** The address to send the person to, and the sealed cookie value that remembers state, nonce, and verifier. */
  begin(settings: StoredEntra, redirectUri: string): { url: string; cookie: string } {
    const pending: Pending = {
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier: b64url(randomBytes(48)),
      expires: Date.now() + STATE_TTL_MS,
    };
    const url = new URL(`${LOGIN}/${encodeURIComponent(settings.tenantId)}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: settings.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: 'openid profile email',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: b64url(createHash('sha256').update(pending.verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return { url: url.toString(), cookie: seal(this.keys, JSON.stringify(pending), this.aad) };
  }

  /** Checks the return trip and returns who signed in. Any doubt is a refusal. */
  async complete(
    settings: StoredEntra & { clientSecret: string },
    redirectUri: string,
    query: { code?: string; state?: string; error?: string },
    cookie: string | undefined,
  ): Promise<EntraIdentity> {
    if (query.error) throw new HttpError(400, `Microsoft returned an error: ${query.error}`, 'sso_denied');
    if (!cookie || !query.code || !query.state) throw new HttpError(400, 'The sign-in link expired.', 'sso_expired');
    let pending: Pending;
    try {
      pending = JSON.parse(open(this.keys, cookie, this.aad)) as Pending;
    } catch {
      throw new HttpError(400, 'The sign-in link expired.', 'sso_expired');
    }
    if (pending.expires < Date.now()) throw new HttpError(400, 'The sign-in link expired.', 'sso_expired');
    // The state ties the return trip to the browser that started it.
    if (!same(pending.state, query.state)) throw new HttpError(400, 'The sign-in did not match.', 'sso_state');

    let res: Response;
    try {
      res = await this.fetcher(`${LOGIN}/${encodeURIComponent(settings.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          code: query.code,
          redirect_uri: redirectUri,
          code_verifier: pending.verifier,
          scope: 'openid profile email',
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(502, 'Microsoft could not be reached.', 'sso_failed');
    }
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
    if (!res.ok || !body.id_token) throw new HttpError(400, 'Microsoft did not accept the sign-in.', 'sso_failed');
    return this.verifyIdToken(settings, body.id_token, pending.nonce);
  }

  private async signingKeys(tenant: string) {
    const cached = this.jwks.get(tenant);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.keys;
    const res = await this.fetcher(`${LOGIN}/${encodeURIComponent(tenant)}/discovery/v2.0/keys`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new HttpError(502, 'Microsoft’s signing keys could not be read.', 'sso_failed');
    const keys = ((await res.json()) as { keys?: { kid: string }[] }).keys ?? [];
    this.jwks.set(tenant, { keys, at: Date.now() });
    return keys;
  }

  /** Signature (RS256 against Microsoft's published keys), issuer, audience, expiry, and nonce. */
  private async verifyIdToken(settings: StoredEntra, token: string, nonce: string): Promise<EntraIdentity> {
    const fail = (why: string): never => {
      throw new HttpError(400, `The Microsoft sign-in was not valid (${why}).`, 'sso_invalid');
    };
    const [h, p, sig] = token.split('.');
    if (!h || !p || !sig) return fail('malformed');
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      return fail('malformed');
    }
    if (header.alg !== 'RS256') return fail('algorithm');
    const jwk = (await this.signingKeys(settings.tenantId)).find((k) => k.kid === header.kid);
    if (!jwk) return fail('unknown key');
    const ok = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      createPublicKey({ key: jwk as never, format: 'jwk' }),
      Buffer.from(sig, 'base64url'),
    );
    if (!ok) return fail('signature');
    const tid = String(claims.tid ?? '');
    const isGuid = /^[0-9a-f-]{36}$/i.test(settings.tenantId);
    if (!tid || (isGuid && tid.toLowerCase() !== settings.tenantId.toLowerCase())) return fail('tenant');
    if (claims.iss !== `${LOGIN}/${tid}/v2.0`) return fail('issuer');
    if (claims.aud !== settings.clientId) return fail('audience');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < now - 60) return fail('expired');
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return fail('not yet valid');
    if (typeof claims.nonce !== 'string' || !same(claims.nonce, nonce)) return fail('nonce');
    const oid = String(claims.oid ?? '');
    if (!oid) return fail('no account id');
    const email = String(claims.email ?? claims.preferred_username ?? '')
      .trim()
      .toLowerCase();
    const amr = Array.isArray(claims.amr) ? (claims.amr as unknown[]).map(String) : [];
    return { oid, email, name: String(claims.name ?? email), tenant: tid, mfa: amr.includes('mfa') };
  }
}
