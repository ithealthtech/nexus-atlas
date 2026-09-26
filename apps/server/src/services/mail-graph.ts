import { createHash } from 'node:crypto';
import type { SmtpConfig } from './settings.js';
import type { SendArgs } from './mail.js';

/** What to change for the Entra sign-in errors people hit most when setting this up. */
const SIGN_IN_HINTS: [RegExp, string][] = [
  [/AADSTS7000215/, 'Paste the secret’s Value from Certificates & secrets, not its Secret ID.'],
  [/AADSTS7000222/, 'The client secret has expired. Create a new one and paste its Value.'],
  [
    /AADSTS700016/,
    'No app with this Application (client) ID exists in this tenant. Check both IDs on the app’s Overview page.',
  ],
  [/AADSTS90002|AADSTS900023/, 'Check the Directory (tenant) ID on the app’s Overview page.'],
  [/AADSTS500011|AADSTS65001/, 'Grant admin consent for the app’s API permissions.'],
];

/** The application permissions ("roles") in an access token. Only the payload is read; it isn't verified. */
function rolesOf(token: string): string[] {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      roles?: unknown;
    };
    return Array.isArray(payload.roles) ? payload.roles.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Microsoft 365 delivery through Microsoft Graph, authenticated as an Entra app registration with the OAuth2
 * client-credentials flow. The app needs the application permission Mail.Send (admin consent); scope it to
 * the sending mailbox with an Exchange application access policy or RBAC for Applications.
 */
export class GraphMailer {
  // Tokens last about an hour; reuse one per app registration *and secret* until shortly before it expires,
  // so saving a new secret (or a mistyped one) is tried at once rather than an hour later.
  private tokens = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private cacheKey(config: SmtpConfig) {
    const secret = createHash('sha256').update(config.clientSecret).digest('hex').slice(0, 16);
    return `${config.tenantId}|${config.clientId}|${secret}`;
  }

  private async token(config: SmtpConfig) {
    const key = this.cacheKey(config);
    const cached = this.tokens.get(key);
    if (cached && cached.expires > this.now() + 60_000) return cached.token;
    const res = await this.fetcher(
      `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      // "AADSTS7000215: Invalid client secret provided. ..." — the first line is the useful part.
      const reason = (body.error_description ?? body.error ?? `HTTP ${res.status}`).split(/\r?\n/)[0]!;
      const hint = SIGN_IN_HINTS.find(([pattern]) => pattern.test(reason))?.[1];
      throw new Error(`Sign-in to Microsoft failed: ${reason}${hint ? ` ${hint}` : ''}`);
    }
    this.tokens.set(key, { token: body.access_token, expires: this.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  async send(config: SmtpConfig, message: SendArgs) {
    const token = await this.token(config);
    const res = await this.fetcher(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.fromAddress)}/sendMail`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: message.subject,
            body: { contentType: 'HTML', content: message.html },
            from: { emailAddress: { address: config.fromAddress, name: config.fromName || undefined } },
            toRecipients: [{ emailAddress: { address: message.to } }],
          },
          saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (res.status === 202) return;
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    // A refused token is dropped, so a permission fixed in Entra is picked up by the next try, not an hour later.
    if (res.status === 401 || res.status === 403) this.tokens.delete(this.cacheKey(config));
    const hint =
      res.status === 403
        ? rolesOf(token).includes('Mail.Send')
          ? ' The app has Mail.Send, so an Exchange application access policy or RBAC for Applications is likely keeping it from sending as this mailbox.'
          : ' The app’s token has no Mail.Send application permission. In Entra → App registrations → API permissions, add Microsoft Graph → Application permissions → Mail.Send (Delegated doesn’t work for Atlas), then grant admin consent.'
        : res.status === 404
          ? ' Check the From address is a licensed or shared mailbox in this tenant, not a group or an alias.'
          : '';
    throw new Error(
      `${body.error?.code ?? `HTTP ${res.status}`}: ${body.error?.message ?? 'Graph refused the message.'}${hint}`,
    );
  }
}
