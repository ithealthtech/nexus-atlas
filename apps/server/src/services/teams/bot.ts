import { TeamsSettingsStore } from './settings.js';

const CONNECTOR = 'https://smba.trafficmanager.net/teams/v3/conversations';
/** A rejected send can be retried safely; a lost response may already have delivered the message. */
export class TeamsSendError extends Error {
  constructor(
    public readonly outcome: 'failed' | 'retry' | 'uncertain',
    public readonly retrySeconds = 60,
  ) {
    super(
      outcome === 'uncertain'
        ? 'The Teams response was lost. Check the channel before retrying.'
        : outcome === 'retry'
          ? 'Teams rate-limited delivery.'
          : 'Teams refused delivery. Check the bot installation and configuration.',
    );
  }
}
export class TeamsBot {
  constructor(
    private readonly settings: Pick<TeamsSettingsStore, 'load' | 'secret'>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(
    orgId: string,
    channelId: string,
    text: string,
    thread?: { conversationId: string; activityId: string },
  ): Promise<{ conversationId: string; activityId: string }> {
    const saved = await this.settings.load(orgId);
    if (!saved?.enabled || !saved.appId || !saved.tenantId) throw new TeamsSendError('failed');
    let token: string;
    try {
      const response = await this.fetcher(`https://login.microsoftonline.com/${saved.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: saved.appId,
          client_secret: this.settings.secret(orgId, saved),
          scope: 'https://api.botframework.com/.default',
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as { access_token?: string };
      if (response.status === 429 || response.status >= 500) throw new TeamsSendError('retry');
      if (!response.ok || !body.access_token) throw new TeamsSendError('failed');
      token = body.access_token;
    } catch (error) {
      throw error instanceof TeamsSendError ? error : new TeamsSendError('retry');
    }
    const bot = { id: `28:${saved.appId}`, name: 'Atlas' };
    const activity = {
      type: 'message',
      textFormat: 'plain',
      text,
      from: bot,
      ...(thread ? { replyToId: thread.activityId } : {}),
    };
    let response: Response;
    try {
      response = await this.fetcher(
        thread
          ? `${CONNECTOR}/${encodeURIComponent(thread.conversationId)}/activities/${encodeURIComponent(thread.activityId)}`
          : CONNECTOR,
        {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(
            thread
              ? activity
              : {
                  isGroup: true,
                  bot,
                  tenantId: saved.tenantId,
                  channelData: {
                    tenant: { id: saved.tenantId },
                    channel: { id: channelId },
                  },
                  activity,
                },
          ),
          signal: AbortSignal.timeout(25_000),
        },
      );
    } catch {
      throw new TeamsSendError('uncertain');
    }
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after'));
      throw new TeamsSendError('retry', Number.isFinite(wait) ? Math.max(30, Math.min(wait, 3600)) : 60);
    }
    if (!response.ok) throw new TeamsSendError(response.status >= 500 ? 'uncertain' : 'failed');
    try {
      const result = (await response.json()) as { id?: string; activityId?: string };
      if (!result.id) throw new Error('Missing delivery ID');
      return {
        conversationId: thread?.conversationId ?? result.id,
        activityId: thread ? result.id : (result.activityId ?? ''),
      };
    } catch {
      throw new TeamsSendError('uncertain');
    }
  }
}
