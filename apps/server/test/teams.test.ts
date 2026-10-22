import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { TeamsSettingsStore } from '../src/services/teams/settings.js';
import type { TeamsAlerts } from '../src/services/teams/alerts.js';
import { setupOwner, enroll, signIn, startApp, type TestApp, type Browser } from './helpers.js';

const TENANT = '11111111-2222-4333-8444-555555555555';
const APP = '22222222-2222-4333-8444-555555555555';
const CHANNEL = '19:harbor@thread.tacv2';
const SECRET = 'synthetic-teams-client-secret';
const REFRESH = 'synthetic-teams-refresh';
describe('Teams integration', () => {
  let t: TestApp,
    owner: Browser,
    orgId: string,
    clientId: string,
    otherId: string,
    assetId: string,
    store: TeamsSettingsStore;
  const calls: { url: string; method: string; body: string }[] = [];
  let mode: 'ok' | 'rate' | 'lost' = 'ok';
  let sequence = 0;
  const keys = staticKeyProvider([randomBytes(32)]);
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    calls.push({ url, method, body });
    if (url.startsWith('https://login.microsoftonline.com/'))
      return Response.json({ access_token: 'synthetic-access', refresh_token: REFRESH + '-rotated' });
    if (url.startsWith('https://smba.trafficmanager.net/')) {
      if (mode === 'rate') return Response.json({}, { status: 429, headers: { 'retry-after': '30' } });
      if (mode === 'lost') throw new Error('private transport details');
      return Response.json(
        url.endsWith('/activities') ? { id: 'reply-activity' } : { id: 'conversation-1', activityId: 'activity-1' },
      );
    }
    if (url.startsWith('https://graph.microsoft.com/')) {
      if (method === 'PATCH') return new Response(null, { status: 204 });
      if (method === 'POST') return Response.json({ id: `post-${++sequence}` }, { status: 201 });
      return Response.json({
        value: [
          {
            id: 'external-post',
            from: { user: { displayName: 'Avery Example' } },
            body: { contentType: 'html', content: '<p>Client discussion</p>' },
          },
        ],
      });
    }
    throw new Error('Unexpected URL');
  }) as typeof fetch;
  beforeEach(async () => {
    calls.length = 0;
    mode = 'ok';
    sequence = 0;
    t = await startApp({}, { keys, teamsFetch: fake });
    owner = (await setupOwner(t.app)).b;
    orgId = (await owner.call('GET', '/api/session')).data.actor.orgId;
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    otherId = (await owner.call('POST', '/api/clients', { name: 'Other Client' })).data.id;
    const [layout] = await t.handle.db
      .insert(schema.assetLayouts)
      .values({ orgId, key: 'teams-device', name: 'Test devices', fields: [] })
      .returning();
    const [asset] = await t.handle.db
      .insert(schema.assets)
      .values({ orgId, clientId, layoutId: layout!.id, name: 'Harbor workstation' })
      .returning();
    assetId = asset!.id;
    store = new TeamsSettingsStore(t.handle.db, keys);
    const response = await owner.call('PUT', '/api/integrations/teams', {
      enabled: true,
      tenantId: TENANT,
      appId: APP,
      clientSecret: SECRET,
      digestHour: 0,
      mappings: [{ clientId, teamId: APP, channelId: CHANNEL, channelName: 'Harbor' }],
    });
    expect(response.status, JSON.stringify(response.data)).toBe(200);
    await store.connect(
      orgId,
      (await store.load(orgId))!.generation,
      { oid: TENANT, name: 'Teams account', connectedAt: new Date().toISOString() },
      REFRESH,
    );
  });
  afterEach(async () => {
    await t.close();
  });
  it('seals credentials, hides them from settings, rotates tokens and cancels stale connection attempts', async () => {
    const view = await owner.call('GET', '/api/integrations/teams');
    expect(view.data.hasClientSecret).toBe(true);
    expect(JSON.stringify(view.data)).not.toContain(SECRET);
    expect(JSON.stringify(view.data)).not.toContain(REFRESH);
    const before = (await store.load(orgId))!;
    expect(JSON.stringify(before)).not.toContain(SECRET);
    expect(JSON.stringify(before)).not.toContain(REFRESH);
    expect(() => store.secret(randomUUID(), before)).toThrow();
    expect((await owner.call('GET', `/api/clients/${clientId}/teams/posts`)).status).toBe(200);
    expect((await store.load(orgId))!.connection!.refreshSealed).not.toBe(before.connection!.refreshSealed);
    expect(await store.rewrap(orgId)).toBe(2);
    await owner.call('DELETE', '/api/integrations/teams');
    await expect(
      store.connect(
        orgId,
        before.generation,
        { oid: TENANT, name: 'Late', connectedAt: new Date().toISOString() },
        REFRESH,
      ),
    ).rejects.toThrow('configuration changed');
    expect((await store.load(orgId))!.connection).toBeNull();
  });
  it('reads, creates, edits and replies only in the mapped client channel', async () => {
    const base = `/api/clients/${clientId}/teams/posts`;
    const read = await owner.call('GET', base);
    expect(read.data.posts[0].content).toBe('Client discussion\n');
    expect(read.data.posts[0].canEdit).toBe(false);
    const post = await owner.call('POST', base, { content: 'Synthetic discussion' });
    expect(post.status).toBe(201);
    expect((await owner.call('PATCH', base + '/' + post.data.id, { content: 'Updated discussion' })).status).toBe(200);
    const reply = await owner.call('POST', base + '/' + post.data.id + '/replies', { content: 'A reply' });
    expect(reply.status).toBe(201);
    expect(
      (await owner.call('PATCH', base + '/' + post.data.id + '/replies/' + reply.data.id, { content: 'Updated reply' }))
        .status,
    ).toBe(200);
    expect((await owner.call('PATCH', base + '/external-post', { content: 'Hijack' })).status).toBe(404);
    expect((await owner.call('GET', `/api/clients/${otherId}/teams/posts`)).status).toBe(404);
    const before = calls.length;
    const cursor = Buffer.from('https://evil.example/steal').toString('base64url');
    expect((await owner.call('GET', base + '?cursor=' + cursor)).status).toBe(400);
    expect(calls.length).toBe(before);
    const [foreign] = await t.handle.db.insert(schema.orgs).values({ name: 'Foreign org' }).returning();
    const [client] = await t.handle.db
      .insert(schema.clients)
      .values({ orgId: foreign!.id, name: 'Foreign client' })
      .returning();
    expect((await owner.call('GET', `/api/clients/${client!.id}/teams/posts`)).status).toBe(404);
  });
  it('omits Teams message bodies from incoming and outgoing verbose request logs', async () => {
    await owner.call('PUT', '/api/request-log/settings', { enabled: true, incoming: true, retentionDays: 1 });
    await owner.call('POST', `/api/clients/${clientId}/teams/posts`, { content: 'private Teams discussion body' });
    await owner.call('GET', `/api/clients/${clientId}/teams/posts`);
    const log = await owner.call('GET', '/api/request-log');
    const details = await Promise.all(
      log.data.entries.map(
        async (entry: { id: number }) => (await owner.call('GET', `/api/request-log/${entry.id}`)).data,
      ),
    );
    const serialized = JSON.stringify(details);
    expect(serialized).not.toContain('private Teams discussion body');
    expect(serialized).not.toContain('Client discussion');
    expect(serialized).toContain('Teams conversation');
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(REFRESH);
  });
  it('enforces staff, client access, read-only grants and API key boundaries before contacting Microsoft', async () => {
    const password = 'temporary Teams pass 1234';
    for (const [role, email] of [
      ['client_viewer', 'client@harbor.test'],
      ['readonly_technician', 'reader@atlas.test'],
    ] as const) {
      await owner.call('POST', '/api/users', {
        email,
        name: role,
        role,
        password,
        grants: [{ clientId, level: 'read' }],
      });
      const { b } = await signIn(t.app, email, password);
      await b.call('POST', '/api/account/password', { current: password, next: 'replacement Teams pass 4321' });
      if (role === 'readonly_technician') await enroll(b);
      expect((await b.call('GET', '/api/integrations/teams')).status).toBe(403);
      expect((await b.call('GET', `/api/clients/${clientId}/teams/posts`)).status).toBe(
        role === 'client_viewer' ? 404 : 200,
      );
      const before = calls.length;
      expect((await b.call('POST', `/api/clients/${clientId}/teams/posts`, { content: 'Not allowed' })).status).toBe(
        role === 'client_viewer' ? 404 : 403,
      );
      expect((await b.call('GET', `/api/clients/${otherId}/teams/posts`)).status).toBe(404);
      expect(calls.length).toBe(before);
    }
    const key = (await owner.call('POST', '/api/api-keys', { name: 'Teams feed', scopes: ['read', 'write'] })).data
      .token;
    const response = await t.app.inject({
      method: 'GET',
      url: `/api/v1/clients/${clientId}/teams/posts`,
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.statusCode).toBe(403);
  });
  it('deduplicates alerts, honors Teams rate limits and replies to the original infection thread', async () => {
    const feed = `/api/clients/${clientId}/teams/infections`;
    const event = { eventId: 'event-1', assetId, status: 'active', source: 'Synthetic monitoring' };
    await owner.call('POST', feed, event);
    await owner.call('POST', feed, event);
    let rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows).toHaveLength(1);
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    mode = 'rate';
    await worker.tick();
    rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.attempts).toBe(1);
    mode = 'ok';
    const later = new Date(Date.now() + 3600_000);
    await Promise.all([worker.tick(later), worker.tick(later)]);
    rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows[0]!.status).toBe('sent');
    expect(calls.filter((c) => c.url === 'https://smba.trafficmanager.net/teams/v3/conversations')).toHaveLength(2);
    await owner.call('POST', feed, { ...event, status: 'resolved' });
    await worker.tick(later);
    expect(
      calls.some((c) => c.url.endsWith('/conversation-1/activities') && c.body.includes('Infection resolved')),
    ).toBe(true);
  });
  it('holds ambiguous delivery without retrying and requires explicit acknowledgment for a manual retry', async () => {
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, {
      eventId: randomUUID(),
      assetId,
      status: 'active',
      source: 'Synthetic monitoring',
    });
    mode = 'lost';
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    await worker.tick();
    const [row] = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(row!.status).toBe('uncertain');
    expect(row!.error).not.toContain('private');
    const count = calls.length;
    await worker.tick(new Date(Date.now() + 3600_000));
    expect(calls.length).toBe(count);
    expect((await owner.call('POST', `/api/integrations/teams/deliveries/${row!.id}/retry`, {})).status).toBe(409);
    expect(
      (await owner.call('POST', `/api/integrations/teams/deliveries/${row!.id}/retry`, { confirmUncertain: true }))
        .status,
    ).toBe(200);
  });
  it('rejects foreign client mappings and wrong-asset infection events, and binds OAuth callbacks to their browser', async () => {
    expect(
      (
        await owner.call('POST', `/api/clients/${otherId}/teams/infections`, {
          eventId: 'bad',
          assetId,
          status: 'active',
          source: 'test',
        })
      ).status,
    ).toBe(404);
    const before = calls.length;
    const response = await t.app.inject({
      method: 'GET',
      url: '/api/integrations/teams/callback?code=stolen&state=wrong',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('expired');
    expect(calls.length).toBe(before);
    expect((await owner.call('POST', '/api/integrations/teams/connect', {})).status).toBe(200);
  });
});
