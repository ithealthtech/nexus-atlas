import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { defaultAlertWorkspace, type AlertRule, type AlertWorkspace } from '@atlas/shared';
import { browser, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const BASE = '/api/settings/alerting';
describe('alerting draft API', () => {
  let t: TestApp, owner: Browser, workspace: AlertWorkspace, clientId: string, ownerId: string, orgId: string;
  const calls: string[] = [];
  const blockedFetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    throw new Error('Previews must never contact Microsoft.');
  }) as typeof fetch;
  beforeEach(async () => {
    calls.length = 0;
    t = await startApp({}, { teamsFetch: blockedFetch });
    owner = (await setupOwner(t.app)).b;
    const actor = (await owner.call('GET', '/api/session')).data.actor;
    ownerId = actor.id;
    orgId = actor.orgId;
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    workspace = defaultAlertWorkspace();
  });
  afterEach(async () => {
    await t?.close();
  });
  const draftRule = (): AlertRule => ({
    id: randomUUID(),
    name: 'Harbor certificate',
    kind: 'expiration',
    templateId: workspace.templates[0]!.id,
    clientIds: [clientId],
    itemKinds: ['asset'],
    daysBefore: [14, 0],
    includeOverdue: false,
    severities: ['warning'],
    emailUserIds: [ownerId],
    teams: true,
  });
  it('stores drafts atomically, preserves existing settings and rejects stale simultaneous saves', async () => {
    await owner.call('PUT', '/api/settings/notifications', {
      alertDays: [7],
      weeklyDigest: false,
      auditRetentionDays: 365,
    });
    const initial = await owner.call('GET', BASE);
    expect(initial.data.revision).toBe(0);
    workspace.rules.push(draftRule());
    const responses = await Promise.all([owner.call('PUT', BASE, workspace), owner.call('PUT', BASE, workspace)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await owner.call('GET', BASE)).data.revision).toBe(1);
    expect((await owner.call('GET', '/api/settings/notifications')).data.alertDays).toEqual([7]);
    const logs = await t.handle.db
      .select()
      .from(schema.securityEvents)
      .where(and(eq(schema.securityEvents.orgId, orgId), eq(schema.securityEvents.action, 'Alert drafts saved')));
    expect(logs).toHaveLength(1);
    expect(await t.handle.db.select().from(schema.teamsDeliveries)).toEqual([]);
    expect(t.outbox).toEqual([]);
  });
  it('previews synthetic data, explains non-matches and reports missing connections without sending', async () => {
    const rule = draftRule();
    const response = await owner.call('POST', BASE + '/preview', {
      template: workspace.templates[0],
      rule,
      sample: { kind: 'expiration', clientId, itemKind: 'asset', daysRemaining: 13, severity: 'warning' },
    });
    expect(response.status, JSON.stringify(response.data)).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.data.emailSubject).toContain('Harbor Dental');
    expect(response.data.matched).toBe(false);
    expect(response.data.reasons).toContain('This is not a selected reminder day');
    expect(response.data.destinations).toHaveLength(2);
    expect(response.data.destinations.every((d: { ready: boolean }) => !d.ready)).toBe(true);
    expect(t.outbox).toEqual([]);
    expect(calls).toEqual([]);
    expect(await t.handle.db.select().from(schema.teamsDeliveries)).toEqual([]);
  });
  it('rejects unknown fields, invalid templates and foreign client or recipient references', async () => {
    const template = workspace.templates[0]!;
    expect(
      (await owner.call('PUT', BASE, { ...workspace, templates: [{ ...template, emailBody: '{{secret}}' }] })).status,
    ).toBe(400);
    const rule = draftRule();
    const [foreignOrg] = await t.handle.db.insert(schema.orgs).values({ name: 'Other organization' }).returning();
    const [foreignClient] = await t.handle.db
      .insert(schema.clients)
      .values({ orgId: foreignOrg!.id, name: 'Foreign client' })
      .returning();
    const [foreignUser] = await t.handle.db
      .insert(schema.users)
      .values({
        orgId: foreignOrg!.id,
        name: 'Foreign owner',
        email: 'foreign@example.test',
        role: 'owner',
        passwordHash: 'unused synthetic hash',
      })
      .returning();
    expect(
      (await owner.call('PUT', BASE, { ...workspace, rules: [{ ...rule, clientIds: [foreignClient!.id] }] })).status,
    ).toBe(404);
    expect(
      (await owner.call('PUT', BASE, { ...workspace, rules: [{ ...rule, emailUserIds: [foreignUser!.id] }] })).status,
    ).toBe(400);
    expect(
      (
        await owner.call('POST', BASE + '/preview', {
          template,
          sample: {
            kind: 'expiration',
            clientId: randomUUID(),
            itemKind: 'asset',
            daysRemaining: 14,
            severity: 'warning',
          },
        })
      ).status,
    ).toBe(404);
    expect((await owner.call('GET', BASE)).data.revision).toBe(0);
  });
  it('rejects disabled recipients and checks real recipient access in a dry run', async () => {
    const password = 'temporary draft pass 1234';
    const otherId = (await owner.call('POST', '/api/clients', { name: 'Other client' })).data.id;
    const user = (
      await owner.call('POST', '/api/users', {
        email: 'tech@atlas.test',
        name: 'Limited technician',
        role: 'technician',
        password,
        allClients: 'none',
        grants: [{ clientId: otherId, level: 'read' }],
      })
    ).data;
    const rule = { ...draftRule(), emailUserIds: [user.id] };
    const response = await owner.call('POST', BASE + '/preview', {
      template: workspace.templates[0],
      rule,
      sample: { kind: 'expiration', clientId, itemKind: 'asset', daysRemaining: 14, severity: 'warning' },
    });
    expect(response.status, JSON.stringify(response.data)).toBe(200);
    expect(response.data.destinations[0].detail).toContain('cannot read');
    await t.handle.db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, user.id));
    expect((await owner.call('PUT', BASE, { ...workspace, rules: [rule] })).status).toBe(400);
  });
  it('requires administrator sessions, CSRF, recent authentication and disallows API keys', async () => {
    expect((await browser(t.app).call('GET', BASE)).status).toBe(401);
    const password = 'temporary draft pass 1234';
    await owner.call('POST', '/api/users', {
      email: 'reader@atlas.test',
      name: 'Reader',
      role: 'readonly_technician',
      password,
      allClients: 'none',
      grants: [{ clientId, level: 'read' }],
    });
    const { b } = await signIn(t.app, 'reader@atlas.test', password);
    await b.call('POST', '/api/account/password', { current: password, next: 'replacement draft pass 4321' });
    await enroll(b);
    for (const [method, path, body] of [
      ['GET', BASE, undefined],
      ['PUT', BASE, workspace],
      ['POST', BASE + '/preview', {}],
    ] as const)
      expect((await b.call(method, path, body)).status).toBe(403);
    const csrf = owner.csrf;
    owner.csrf = 'invalid';
    expect((await owner.call('PUT', BASE, workspace)).status).toBe(403);
    owner.csrf = csrf;
    const key = (await owner.call('POST', '/api/api-keys', { name: 'Draft access', scopes: ['read', 'write'] })).data
      .token;
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/v1/settings/alerting',
          headers: { authorization: `Bearer ${key}` },
        })
      ).statusCode,
    ).toBe(403);
    await t.handle.db.update(schema.sessions).set({ reauthAt: new Date(0) });
    const stale = await owner.call('PUT', BASE, workspace);
    expect([stale.status, stale.data.code]).toEqual([403, 'reauth']);
  });
});
