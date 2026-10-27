import { HttpError } from '../../errors.js';
import type { TeamsSettingsStore } from './settings.js';

export class TeamsRequestError extends HttpError {
  constructor(
    readonly outcome: 'failed' | 'retry' | 'uncertain' | 'connection',
    message: string,
    readonly retrySeconds = 60,
    status = outcome === 'connection' ? 409 : 502,
  ) {
    super(status, message);
  }
}

/** Discussions and scheduled alerts use the same delegated Microsoft account. */
export class TeamsClient {
  constructor(
    private readonly settings: Pick<TeamsSettingsStore, 'delegatedToken'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request(orgId: string, path: string, method = 'GET', body?: unknown): Promise<unknown> {
    let token: string;
    try {
      token = await this.settings.delegatedToken(orgId, this.fetcher);
    } catch (error) {
      if (error instanceof HttpError)
        throw new TeamsRequestError(
          error.status === 409 ? 'connection' : error.status === 429 || error.status >= 500 ? 'retry' : 'failed',
          error.message,
          60,
          error.status,
        );
      throw new TeamsRequestError('failed', 'Check the Microsoft account connection in Teams settings.');
    }
    let response: Response;
    try {
      response = await this.fetcher('https://graph.microsoft.com/v1.0' + path, {
        method,
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25_000),
      });
    } catch {
      throw new TeamsRequestError(
        method === 'GET' ? 'retry' : 'uncertain',
        method === 'GET'
          ? 'Microsoft Teams could not be reached.'
          : 'Teams did not confirm the change. Check the channel before trying again.',
      );
    }
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after'));
      throw new TeamsRequestError(
        'retry',
        'Teams is busy. Try again shortly.',
        Number.isFinite(wait) ? Math.max(30, Math.min(wait, 3600)) : 60,
        429,
      );
    }
    if (response.status === 401)
      throw new TeamsRequestError('connection', 'Reconnect the Microsoft account in Teams settings.');
    if (!response.ok)
      throw new TeamsRequestError(
        response.status >= 500 ? (method === 'GET' ? 'retry' : 'uncertain') : 'failed',
        response.status >= 500
          ? 'Teams did not confirm the request. Check the channel before retrying a change.'
          : 'Microsoft refused the Teams request. Check the account and channel permissions.',
        60,
        response.status === 404 ? 404 : 502,
      );
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new TeamsRequestError(
        method === 'GET' ? 'retry' : 'uncertain',
        'Teams returned an unreadable response. Check the channel before retrying a change.',
      );
    }
  }
}
