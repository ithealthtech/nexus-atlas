import type { SmtpConfig } from './settings.js';
import type { SendArgs } from './mail.js';

/**
 * Microsoft 365 delivery through Microsoft Graph, authenticated as an Entra app registration with the OAuth2
 * client-credentials flow. The app needs the application permission Mail.Send (admin consent); scope it to
 * the sending mailbox with an Exchange application access policy or RBAC for Applications.
 */
export class GraphMailer {
  // Tokens last about an hour; reuse one per app registration until shortly before it expires.
  private tokens = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async token(config: SmtpConfig) {
    const key = `${config.tenantId}|${config.clientId}`;
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
    if (!res.ok || !body.access_token)
      // "AADSTS7000215: Invalid client secret provided. ..." — the first line is the useful part.
      throw new Error(
        `Sign-in to Microsoft failed: ${(body.error_description ?? body.error ?? `HTTP ${res.status}`).split(/\r?\n/)[0]}`,
      );
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
    if (res.status === 401) this.tokens.delete(`${config.tenantId}|${config.clientId}`);
    const hint =
      res.status === 403
        ? ' Check the app has the Mail.Send application permission with admin consent, and may send as this mailbox.'
        : res.status === 404
          ? ' Check the From address is a mailbox in this tenant.'
          : '';
    throw new Error(
      `${body.error?.code ?? `HTTP ${res.status}`}: ${body.error?.message ?? 'Graph refused the message.'}${hint}`,
    );
  }
}
