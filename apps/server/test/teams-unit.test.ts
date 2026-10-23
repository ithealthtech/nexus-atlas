import { describe, expect, it } from 'vitest';
import { teamsSettingsSchema, teamsInfectionSchema } from '@atlas/shared';
import { teamsText, teamsMessageBody } from '../src/services/teams/graph.js';
import { teamsReminder, teamsLocalHour } from '../src/services/teams/alerts.js';
import { API_ROUTES } from '../src/services/api-keys.js';
import { isPrivatePath, isPrivateTeamsUrl } from '../src/services/request-log.js';
import { TeamsClient } from '../src/services/teams/client.js';
import { HttpError } from '../src/errors.js';

describe('Teams input and rendering', () => {
  it('sends opted-in formatting as escaped Graph HTML while preserving plain messages', () => {
    expect(teamsMessageBody('## Heading\n**Client:** <untrusted>', 'formatted')).toEqual({
      contentType: 'html',
      content: '<p><strong>Heading</strong></p><p><strong>Client:</strong> &lt;untrusted&gt;</p>',
    });
    expect(teamsMessageBody('## Heading')).toEqual({ contentType: 'text', content: '## Heading' });
  });
  it('defaults to a disabled connection, security alerts, daily digests and expiry milestones', () => {
    const result = teamsSettingsSchema.parse({});
    expect(result.enabled).toBe(false);
    expect(result.alerts).toEqual(['expiration', 'review', 'breach', 'infection']);
    expect(result.reminderDays).toEqual([30, 14, 7, 1, 0]);
    expect(result.digestHour).toBe(8);
  });
  it('rejects invalid identities, channel IDs, duplicate clients and time zones', () => {
    const mapping = {
      clientId: '11111111-2222-4333-8444-555555555555',
      teamId: '22222222-2222-4333-8444-555555555555',
      channelId: '19:sample@thread.tacv2',
      channelName: 'Harbor',
    };
    for (const body of [
      { enabled: true },
      { tenantId: 'common' },
      { mappings: [{ ...mapping, channelId: 'https://evil.test' }] },
      { mappings: [mapping, mapping] },
      { timeZone: 'Invalid/Zone' },
      { digestHour: 24 },
      { reminderDays: [-1] },
    ])
      expect(teamsSettingsSchema.safeParse(body).success).toBe(false);
    expect(
      teamsInfectionSchema.safeParse({
        eventId: 'event',
        assetId: mapping.clientId,
        status: 'missing_protection',
        source: 'test',
      }).success,
    ).toBe(false);
  });
  it('uses the latest reached reminder, including overdue, without requiring the exact day', () => {
    const days = [30, 14, 7, 1, 0];
    expect([31, 30, 29, 14, 9, 6, 1, 0, -10].map((n) => teamsReminder(n, days))).toEqual([
      undefined,
      30,
      30,
      14,
      14,
      7,
      1,
      0,
      0,
    ]);
    expect(teamsLocalHour(new Date('2026-10-22T12:00:00Z'), 'America/New_York')).toBe(8);
  });
  it('renders message markup as text and keeps Teams content out of request logs', () => {
    expect(
      teamsText({
        id: '1',
        body: { contentType: 'html', content: '<p>Hello &amp; goodbye<br>next</p><script>text</script>' },
      }),
    ).toBe('Hello & goodbye\nnext\ntext');
    expect(teamsText({ id: '1', body: { contentType: 'text', content: '<literal>' } })).toBe('<literal>');
    expect(isPrivatePath('/api/clients/client/teams/posts')).toBe(true);
    expect(isPrivatePath('/teams/v3/conversations')).toBe(true);
    expect(isPrivateTeamsUrl('https://graph.microsoft.com/v1.0/teams/team/channels/channel/messages')).toBe(true);
    expect(isPrivateTeamsUrl('https://smba.trafficmanager.net/teams/v3/conversations')).toBe(true);
    expect(isPrivateTeamsUrl('https://graph.microsoft.com/v1.0/subscribedSkus')).toBe(false);
  });
  it('exposes only the infection feed to API keys, keeping discussions and configuration browser-only', () => {
    const allowed = (path: string) => API_ROUTES.some((rule) => rule.test(path));
    expect(allowed('/api/clients/client/teams/infections')).toBe(true);
    for (const path of [
      '/api/clients/client/teams',
      '/api/clients/client/teams/posts',
      '/api/clients/client/teams/posts/id/replies',
      '/api/integrations/teams',
    ])
      expect(allowed(path)).toBe(false);
  });
  it('accepts saved settings from 2.1.0 without retaining obsolete bot package fields', () => {
    const settings = teamsSettingsSchema.parse({
      tenantId: '11111111-2222-4333-8444-555555555555',
      appId: '22222222-2222-4333-8444-555555555555',
      websiteUrl: 'https://atlas.example',
      privacyUrl: 'https://atlas.example/privacy',
      termsUrl: 'https://atlas.example/terms',
    });
    expect(settings.appId).toBe('22222222-2222-4333-8444-555555555555');
    expect(settings).not.toHaveProperty('websiteUrl');
    expect(settings).not.toHaveProperty('privacyUrl');
    expect(settings).not.toHaveProperty('termsUrl');
  });
});

describe('Teams Graph delivery', () => {
  const settings = { delegatedToken: async () => 'delegated-teams-token' };
  it('sends plain-text messages and replies through the connected account', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new TeamsClient(settings, (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ id: 'graph-message' }, { status: 201 });
    }) as typeof fetch);
    const path = '/teams/team/channels/19%3Achannel%40thread.tacv2/messages';
    expect(await client.request('org', path, 'POST', { body: { contentType: 'text', content: 'Alert' } })).toEqual({
      id: 'graph-message',
    });
    await client.request('org', path + '/original-message/replies', 'POST', {
      body: { contentType: 'text', content: 'Resolved' },
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://graph.microsoft.com/v1.0' + path,
      'https://graph.microsoft.com/v1.0' + path + '/original-message/replies',
    ]);
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer delegated-teams-token');
    expect(JSON.parse(String(calls[0]!.init?.body)).body.contentType).toBe('text');
  });
  it('classifies a missing Microsoft connection before making any Graph request', async () => {
    let calls = 0;
    const client = new TeamsClient(
      {
        delegatedToken: async () => {
          throw new HttpError(409, 'Connect Microsoft.');
        },
      },
      (async () => {
        calls++;
        return Response.json({});
      }) as typeof fetch,
    );
    await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.toMatchObject({
      outcome: 'connection',
      status: 409,
    });
    expect(calls).toBe(0);
  });
  it('honors Retry-After without classifying a known throttle as an ambiguous send', async () => {
    const client = new TeamsClient(settings, (async () =>
      Response.json({}, { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch);
    await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.toMatchObject({
      outcome: 'retry',
      retrySeconds: 120,
    });
  });
  it('pauses authentication failures and keeps permission errors separate', async () => {
    for (const [status, outcome] of [
      [401, 'connection'],
      [403, 'failed'],
    ] as const) {
      const client = new TeamsClient(settings, (async () =>
        Response.json({ error: 'private Microsoft details' }, { status })) as typeof fetch);
      await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.toMatchObject({
        outcome,
      });
      await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.not.toThrow(
        'private',
      );
    }
  });
  it('retries reads but holds uncertain writes when Microsoft returns a server error', async () => {
    const client = new TeamsClient(settings, (async () => Response.json({}, { status: 503 })) as typeof fetch);
    await expect(client.request('org', '/teams/team/channels/channel/messages')).rejects.toMatchObject({
      outcome: 'retry',
    });
    await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.toMatchObject({
      outcome: 'uncertain',
    });
  });
  it('holds a lost write response and never exposes transport details', async () => {
    const client = new TeamsClient(settings, (async () => {
      throw new Error('private transport details');
    }) as typeof fetch);
    await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.toMatchObject({
      outcome: 'uncertain',
    });
    await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.not.toThrow(
      'private',
    );
  });
  it('holds an unreadable write response as uncertain instead of sending it again', async () => {
    const client = new TeamsClient(settings, (async () => new Response('not JSON', { status: 201 })) as typeof fetch);
    await expect(client.request('org', '/teams/team/channels/channel/messages', 'POST', {})).rejects.toMatchObject({
      outcome: 'uncertain',
    });
  });
});
