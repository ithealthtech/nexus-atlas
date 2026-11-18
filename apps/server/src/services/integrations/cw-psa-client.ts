import { psaSiteUrl } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { UPSTREAM } from './cw-rmm-client.js';

type Json = Record<string, unknown>;

/** The code on errors that mean PSA refused the keys or the API member's permissions: retrying won't help. */
export const PSA_DENIED = 'cw_psa_denied';
/** PSA's REST API version this client is written against. */
const ACCEPT = 'application/vnd.connectwise.com+json; version=2022.1';
const PAGE = 1000;
/** Reads stay quick; creating a ticket can run board workflows and notifications first. */
const READ_MS = 30_000;
const WRITE_MS = 120_000;

export interface PsaCredentials {
  site: string;
  companyId: string;
  publicKey: string;
  privateKey: string;
  clientId: string;
}

/** PSA's own message from an error body ({ message, errors: [{ message }] }), short and on one line. */
async function detail(res: Response): Promise<string> {
  let text = '';
  try {
    text = await res.text();
    const body = JSON.parse(text) as { message?: unknown; errors?: { message?: unknown }[] };
    const parts = [body.message, ...(body.errors ?? []).map((e) => e.message)].filter(
      (m): m is string => typeof m === 'string' && !!m.trim(),
    );
    if (parts.length) text = parts.join(' ');
  } catch {
    // Not JSON: the raw text, if any, is the detail.
  }
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  return clean ? ` PSA said: ${clean}` : '';
}

/**
 * ConnectWise PSA's REST API (/v4_6_release/apis/3.0), signed in with an API member's keys and the integration's
 * clientId, as CallBridge does.
 */
export class CwPsaClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(
    private readonly creds: PsaCredentials,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const site = psaSiteUrl(creds.site);
    if (!site) throw new HttpError(400, 'The ConnectWise PSA site address is not valid.');
    this.base = `${site}/v4_6_release/apis/3.0`;
    this.auth = `Basic ${Buffer.from(`${creds.companyId}+${creds.publicKey}:${creds.privateKey}`).toString('base64')}`;
  }

  get(path: string): Promise<unknown> {
    return this.call('GET', path, undefined, READ_MS);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.call('POST', path, body, WRITE_MS);
  }

  /** Every record a list returns, a page at a time, up to `maxPages` pages; `partial` says whether more were left. */
  async list(path: string, query: Record<string, string>, maxPages = 10): Promise<{ items: Json[]; partial: boolean }> {
    const items: Json[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const params = new URLSearchParams({ ...query, pageSize: String(PAGE), page: String(page) });
      const body = await this.get(`${path}?${params}`);
      if (!Array.isArray(body)) throw new HttpError(UPSTREAM, `ConnectWise PSA answered ${path} with something other than a list.`);
      items.push(...body.filter((x): x is Json => !!x && typeof x === 'object'));
      if (body.length < PAGE) return { items, partial: false };
    }
    return { items, partial: true };
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, ms: number): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: this.auth,
          clientId: this.creds.clientId,
          Accept: ACCEPT,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(ms),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError')
        throw new HttpError(UPSTREAM, 'ConnectWise PSA did not answer in time.', 'cw_psa_timeout');
      throw new HttpError(UPSTREAM, 'ConnectWise PSA could not be reached. Check the site address and this server’s internet access.');
    }
    const where = path.split('?')[0];
    if (res.status === 401)
      throw new HttpError(
        400,
        `ConnectWise PSA refused the sign-in. Check the company ID, the API member's keys and the clientId.${await detail(res)}`,
        PSA_DENIED,
      );
    if (res.status === 403)
      throw new HttpError(
        400,
        `ConnectWise PSA refused ${where}: the API member's security role doesn't allow it.${await detail(res)}`,
        PSA_DENIED,
      );
    if (!res.ok)
      throw new HttpError(
        res.status === 400 || res.status === 404 ? res.status : UPSTREAM,
        `ConnectWise PSA returned ${res.status} for ${where}.${await detail(res)}`,
      );
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(UPSTREAM, `ConnectWise PSA answered ${where} with something other than JSON.`);
    }
  }
}
