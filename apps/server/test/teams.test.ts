import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '@atlas/db';
import { eq } from 'drizzle-orm';
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
  let mode: 'ok' | 'rate' | 'lost' | 'expired' | 'no-id' | 'denied' = 'ok';
  let sequence = 0;
  const keys = staticKeyProvider([randomBytes(32)]);
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = String(init?.body ?? '');
    calls.push({ url, method, body });
    if (url.startsWith('https://login.microsoftonline.com/'))
      return mode === 'expired'
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : Response.json({ access_token: 'synthetic-access', refresh_token: REFRESH + '-rotated' });
    if (url.startsWith('https://graph.microsoft.com/')) {
      if (method === 'PATCH') return new Response(null, { status: 204 });
      if (method === 'POST') {
        if (mode === 'rate') return Response.json({}, { status: 429, headers: { 'retry-after': '30' } });
        if (mode === 'lost') throw new Error('private transport details');
        if (mode === 'denied') return Response.json({}, { status: 403 });
        return Response.json(mode === 'no-id' ? {} : { id: `post-${++sequence}` }, { status: 201 });
      }
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
    expect(calls.some((c) => c.url.includes('botframework.com') || c.url.includes('smba.trafficmanager.net'))).toBe(
      false,
    );
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
    expect(rows[0]!.graphMessageId).toBe('post-1');
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://graph.microsoft.com/'))).toHaveLength(
      2,
    );
    await owner.call('POST', feed, { ...event, status: 'resolved' });
    await worker.tick(later);
    expect(calls.some((c) => c.url.endsWith('/messages/post-1/replies') && c.body.includes('Infection resolved'))).toBe(
      true,
    );
  });
  it('sends a channel test using the same delegated account and removes the obsolete app-package endpoint', async () => {
    const response = await owner.call('POST', `/api/integrations/teams/test/${clientId}`, {});
    expect(response.status).toBe(200);
    const token = calls.find((c) => c.url.includes('/oauth2/v2.0/token'))!;
    const grant = new URLSearchParams(token.body);
    expect(grant.get('grant_type')).toBe('refresh_token');
    expect(grant.get('scope')).toBe('https://graph.microsoft.com/.default');
    expect(
      calls.some(
        (c) =>
          c.method === 'POST' &&
          c.url.endsWith(`/channels/${encodeURIComponent(CHANNEL)}/messages`) &&
          c.body.includes('Atlas test notification'),
      ),
    ).toBe(true);
    expect((await owner.call('GET', '/api/integrations/teams/app-package')).status).toBe(404);
  });
  it('keeps breach alerts immediate and combines expiry and document-review reminders after the digest hour', async () => {
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const password = await owner.call('POST', `/api/clients/${clientId}/passwords`, {
      name: 'private-vault-name',
      secret: 'synthetic-vault-secret-123!',
      expiresOn: date,
    });
    expect(password.status).toBe(201);
    await t.handle.db
      .update(schema.passwords)
      .set({ breachCount: 7, breachCheckedAt: new Date() })
      .where(eq(schema.passwords.id, password.data.id));
    await t.handle.db.insert(schema.documents).values({
      orgId,
      clientId,
      title: 'Client review agenda',
      content: { type: 'doc', content: [] },
      reviewDate: date,
    });
    await store.save(orgId, (await owner.call('GET', '/api/session')).data.actor.id, {
      ...(await store.view(orgId)),
      digestHour: 8,
      timeZone: 'UTC',
    });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    await worker.tick(new Date(tomorrow + 'T07:00:00Z'));
    let rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows.map((r) => r.kind).sort()).toEqual(['breach', 'expiration', 'review']);
    expect(rows.filter((r) => r.status === 'sent').map((r) => r.kind)).toEqual(['breach']);
    await worker.tick(new Date(tomorrow + 'T08:00:00Z'));
    rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    const sends = calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://graph.microsoft.com/'));
    expect(sends).toHaveLength(2);
    expect(sends[0]!.body).toContain('found in a breach');
    expect(sends[1]!.body).toContain('Client review agenda');
    expect(sends[1]!.body).toContain('A password needs attention');
    expect(JSON.stringify(sends)).not.toContain('private-vault-name');
    expect(JSON.stringify(sends)).not.toContain('synthetic-vault-secret');
    await worker.tick(new Date(tomorrow + 'T09:00:00Z'));
    expect(calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://graph.microsoft.com/'))).toHaveLength(
      2,
    );
  });
  it('keeps pending notifications while disconnected and resumes after Microsoft is connected', async () => {
    await store.disconnect(orgId);
    await store.save(orgId, (await owner.call('GET', '/api/session')).data.actor.id, {
      ...(await store.view(orgId)),
      enabled: true,
    });
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, {
      eventId: 'queued',
      assetId,
      status: 'active',
      source: 'Synthetic monitoring',
    });
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    await worker.tick();
    let [row] = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await owner.call('POST', `/api/integrations/teams/test/${clientId}`, {})).status).toBe(409);
    await store.connect(
      orgId,
      (await store.load(orgId))!.generation,
      { oid: TENANT, name: 'Teams account', connectedAt: new Date().toISOString() },
      REFRESH,
    );
    await worker.tick();
    [row] = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(row!.status).toBe('sent');
  });
  it('holds all claimed deliveries without consuming retries when Microsoft requires reconnection', async () => {
    for (const eventId of ['expired-1', 'expired-2'])
      await owner.call('POST', `/api/clients/${clientId}/teams/infections`, {
        eventId,
        assetId,
        status: 'active',
        source: 'Synthetic monitoring',
      });
    mode = 'expired';
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    await worker.tick();
    let rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows.every((r) => r.status === 'pending' && r.attempts === 0 && r.error.includes('Reconnect'))).toBe(true);
    expect(calls).toHaveLength(1);
    mode = 'ok';
    await store.connect(
      orgId,
      (await store.load(orgId))!.generation,
      { oid: TENANT, name: 'Reconnected', connectedAt: new Date().toISOString() },
      REFRESH,
    );
    await worker.tick(new Date(Date.now() + 120_000));
    rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);
  });
  it('uses the configured security channel and starts a new Graph thread for legacy bot notifications', async () => {
    const saved = await store.view(orgId);
    await store.save(orgId, (await owner.call('GET', '/api/session')).data.actor.id, {
      ...saved,
      mappings: saved.mappings.map((m) => ({ ...m, securityChannelId: '19:security@thread.tacv2' })),
    });
    const event = { eventId: 'legacy', assetId, status: 'active', source: 'Synthetic monitoring' };
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, event);
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    await worker.tick();
    const [root] = await t.handle.db.select().from(schema.teamsDeliveries);
    await t.handle.db
      .update(schema.teamsDeliveries)
      .set({ graphMessageId: null, conversationId: 'legacy-conversation', activityId: 'legacy-activity' })
      .where(eq(schema.teamsDeliveries.id, root!.id));
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, { ...event, status: 'resolved' });
    await worker.tick();
    const sends = calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://graph.microsoft.com/'));
    expect(sends).toHaveLength(2);
    expect(sends.every((c) => c.url.endsWith('/channels/19%3Asecurity%40thread.tacv2/messages'))).toBe(true);
    expect(sends.at(-1)!.body).toContain('Infection resolved');
    expect((await t.handle.db.select().from(schema.teamsDeliveries)).every((r) => r.status === 'sent')).toBe(true);
  });
  it('does not send a resolution as a new post while its original notification is throttled', async () => {
    const event = { eventId: 'waiting-root', assetId, status: 'active', source: 'Synthetic monitoring' };
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, event);
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, { ...event, status: 'resolved' });
    mode = 'rate';
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    await worker.tick();
    expect(calls.filter((c) => c.url.startsWith('https://graph.microsoft.com/'))).toHaveLength(1);
    mode = 'ok';
    await worker.tick(new Date(Date.now() + 120_000));
    expect(calls.some((c) => c.url.endsWith('/messages/post-1/replies') && c.body.includes('Infection resolved'))).toBe(
      true,
    );
  });
  it('holds a successful response without a message ID as uncertain and fails known permission refusals', async () => {
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, {
      eventId: 'no-id',
      assetId,
      status: 'active',
      source: 'Synthetic monitoring',
    });
    mode = 'no-id';
    const worker = t.app.getDecorator<TeamsAlerts>('teamsAlerts');
    await worker.tick();
    let rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows[0]!.status).toBe('uncertain');
    await owner.call('POST', `/api/clients/${clientId}/teams/infections`, {
      eventId: 'forbidden',
      assetId,
      status: 'active',
      source: 'Synthetic monitoring',
    });
    mode = 'denied';
    await worker.tick();
    rows = await t.handle.db.select().from(schema.teamsDeliveries);
    expect(rows.some((r) => r.status === 'failed' && r.error.includes('permissions'))).toBe(true);
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
