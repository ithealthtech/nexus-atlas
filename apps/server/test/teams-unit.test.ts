import { describe, expect, it } from 'vitest';
import { teamsSettingsSchema, teamsInfectionSchema } from '@atlas/shared';
import { teamsText } from '../src/services/teams/graph.js';
import { teamsReminder, teamsLocalHour } from '../src/services/teams/alerts.js';
import { API_ROUTES } from '../src/services/api-keys.js';
import { isPrivatePath, isPrivateTeamsUrl } from '../src/services/request-log.js';
import { teamsAppPackage } from '../src/services/teams/manifest.js';
import { unzipSync } from 'fflate';
import { TeamsBot } from '../src/services/teams/bot.js';

describe('Teams input and rendering', () => {
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
  it('builds an installable app package with correctly sized PNG icons and no credentials', () => {
    const settings = teamsSettingsSchema.parse({
      appId: '11111111-2222-4333-8444-555555555555',
      websiteUrl: 'https://atlas.example',
      privacyUrl: 'https://atlas.example/privacy',
      termsUrl: 'https://atlas.example/terms',
    });
    const files = unzipSync(teamsAppPackage(settings, 'https://atlas.example'));
    expect(Object.keys(files).sort()).toEqual(['color.png', 'manifest.json', 'outline.png']);
    const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString());
    expect(manifest.bots[0].botId).toBe(settings.appId);
    expect(manifest.bots[0].isNotificationOnly).toBe(true);
    expect(Buffer.from(files['color.png']!).readUInt32BE(16)).toBe(192);
    expect(Buffer.from(files['outline.png']!).readUInt32BE(16)).toBe(32);
    expect(() => teamsAppPackage(teamsSettingsSchema.parse({}), 'https://atlas.example')).toThrow('privacy');
  });
});

describe('Teams bot delivery', () => {
  const saved = {
    ...teamsSettingsSchema.parse({
      enabled: true,
      tenantId: '11111111-2222-4333-8444-555555555555',
      appId: '22222222-2222-4333-8444-555555555555',
    }),
    generation: 'synthetic',
    ownerId: '11111111-2222-4333-8444-555555555555',
    secretSealed: null,
    connection: null,
  };
  const settings = { load: async () => saved, secret: () => 'synthetic-secret' };
  it('uses the bot audience, sends to the selected channel, and replies in the existing thread', async () => {
    const calls: { url: string; body: string }[] = [];
    const bot = new TeamsBot(settings, (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body) });
      return url.includes('login.microsoftonline.com')
        ? Response.json({ access_token: 'bot-token' })
        : Response.json({ id: 'conversation', activityId: 'activity' });
    }) as typeof fetch);
    expect(await bot.send('org', '19:channel@thread.tacv2', 'Example alert')).toEqual({
      conversationId: 'conversation',
      activityId: 'activity',
    });
    expect(calls[0]!.body).toContain('api.botframework.com');
    expect(JSON.parse(calls[1]!.body).channelData.channel.id).toBe('19:channel@thread.tacv2');
    expect(JSON.parse(calls[1]!.body).activity.textFormat).toBe('plain');
    await bot.send('org', '19:channel@thread.tacv2', 'Resolved', 'conversation');
    expect(calls.at(-1)!.url).toBe('https://smba.trafficmanager.net/teams/v3/conversations/conversation/activities');
  });
  it('honors Retry-After without classifying a known throttle as an ambiguous send', async () => {
    const bot = new TeamsBot(settings, (async (input: string | URL | Request) =>
      String(input).includes('login.microsoftonline.com')
        ? Response.json({ access_token: 'bot-token' })
        : Response.json({}, { status: 429, headers: { 'retry-after': '120' } })) as typeof fetch);
    await expect(bot.send('org', '19:channel@thread.tacv2', 'Alert')).rejects.toMatchObject({
      outcome: 'retry',
      retrySeconds: 120,
    });
  });
  it('holds a lost response as uncertain and never exposes transport details', async () => {
    const bot = new TeamsBot(settings, (async (input: string | URL | Request) => {
      if (String(input).includes('login.microsoftonline.com')) return Response.json({ access_token: 'bot-token' });
      throw new Error('private transport details');
    }) as typeof fetch);
    await expect(bot.send('org', '19:channel@thread.tacv2', 'Alert')).rejects.toMatchObject({
      outcome: 'uncertain',
      message: 'The Teams response was lost. Check the channel before retrying.',
    });
  });
});
