import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  defaultAlertWorkspace,
  type AlertDeliveryPage,
  type AlertDeliveryState,
  type AlertDryRun,
  type AlertWorkspace,
} from '@atlas/shared';
import type { AlertDeliveryService } from '../src/services/alerting/delivery.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const BASE = '/api/settings/alerting';
const TEMP = 'temporary pass 1234';
const SMTP = {
  enabled: true,
  preset: 'custom',
  host: 'smtp.example.test',
  port: 587,
  security: 'starttls',
  username: 'atlas',
  password: 'smtp-secret-4471',
  fromAddress: 'atlas@example.test',
  fromName: 'Atlas',
};

describe('alerting center delivery', () => {
  let t: TestApp, owner: Browser, ownerId: string, clientId: string, workspace: AlertWorkspace;
  const worker = () => t.app.getDecorator<AlertDeliveryService>('alertDelivery');
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const sent = () => t.outbox.filter((m) => !m.subject.includes('test email'));

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    ownerId = (await owner.call('GET', '/api/session')).data.actor.id;
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    expect((await owner.call('PUT', '/api/settings/email', SMTP)).status).toBe(200);
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    await owner.call('POST', `/api/clients/${clientId}/assets`, {
      layoutId: layouts.find((l) => l.key === 'ssl_certificate')!.id,
      name: 'portal.harbordental.test',
      fields: { common_name: 'portal.harbordental.test', expires: inDays(10) },
    });
    workspace = defaultAlertWorkspace();
    workspace.rules.push({
      id: randomUUID(),
      name: 'Certificates',
      kind: 'expiration',
      templateId: workspace.templates[0]!.id,
      clientIds: [],
      itemKinds: ['asset'],
      daysBefore: [30, 14],
      includeOverdue: true,
      severities: ['info', 'warning', 'critical'],
      emailUserIds: [ownerId],
      teams: false,
    });
    expect((await owner.call('PUT', BASE, workspace)).status).toBe(200);
  });
  afterEach(async () => {
    await t?.close();
  });
  const publish = () => owner.call('POST', BASE + '/publish', { revision: 1, lastVersion: 0, note: 'Go' });
  const state = async () => (await owner.call('GET', BASE + '/delivery')).data as AlertDeliveryState;
  const history = async () => (await owner.call('GET', BASE + '/deliveries')).data as AlertDeliveryPage;

  it('stays on the classic alerts until published rules go live, with a preview of what would send', async () => {
    expect(await state()).toMatchObject({ mode: 'classic', publishedVersion: null, email: true, teams: false });
    // Nothing published: going live is refused.
    expect((await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true })).status).toBe(409);
    expect((await publish()).status).toBe(200);
    expect((await owner.call('PUT', BASE + '/delivery', { mode: 'center' })).status).toBe(400);

    const preview = (await owner.call('GET', BASE + '/delivery/preview')).data as AlertDryRun;
    expect(preview.version).toBe(1);
    expect(preview.matches).toEqual([
      expect.objectContaining({
        ruleName: 'Certificates',
        clientName: 'Harbor Dental',
        itemName: 'portal.harbordental.test',
        reason: '14-day reminder',
        destinations: [expect.objectContaining({ channel: 'email', ready: true, existing: null })],
      }),
    ]);
    // Classic mode: the worker doesn't send anything from the center.
    await worker().tick();
    expect(sent()).toEqual([]);
  });

  it('going live records what is already due instead of repeating it, then sends new reminders once', async () => {
    await publish();
    const live = await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true });
    expect(live.data).toMatchObject({ mode: 'center', publishedVersion: 1 });
    await worker().tick();
    expect(sent()).toEqual([]);
    expect((await history()).deliveries).toEqual([
      expect.objectContaining({ status: 'skipped', error: 'Already due when the alerting center went live.' }),
    ]);

    // The certificate reaches the next reminder: that one is sent, once.
    await t.handle.db.execute(
      sql`update assets set fields = jsonb_set(fields, '{expires}', to_jsonb(${inDays(-1)}::text)) where name = 'portal.harbordental.test'`,
    );
    await worker().tick();
    await worker().tick();
    expect(sent().map((m) => [m.to, m.subject])).toEqual([['owner@atlas.test', 'Harbor Dental: Expirations']]);
    const rows = (await history()).deliveries;
    expect(rows[0]).toMatchObject({ status: 'sent', reason: 'Overdue', ruleName: 'Certificates', version: 1 });
    expect((await state()).counts).toMatchObject({ sent: 1, skipped: 1 });
  });

  it('can send what is already due on going live, and switches back without sending again', async () => {
    await publish();
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    expect(sent()).toHaveLength(1);
    expect((await owner.call('GET', BASE + '/delivery/preview')).data.matches[0].destinations[0].existing).toBe('sent');
    expect((await owner.call('PUT', BASE + '/delivery', { mode: 'classic' })).data.mode).toBe('classic');
    await worker().tick();
    expect(sent()).toHaveLength(1);
    const events = (await owner.call('GET', '/api/security-events')).data as { action: string }[];
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['Alerting center went live', 'Alerting center switched back to classic alerts']),
    );
  });

  it('retries failures, asks before resending an uncertain one, and sends tests to the person asking', async () => {
    await publish();
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    const [row] = (await history()).deliveries;
    const retry = (body = {}) => owner.call('POST', `${BASE}/deliveries/${row!.id}/retry`, body);
    expect((await retry()).status).toBe(409);
    await t.handle.db
      .update(schema.alertDeliveries)
      .set({ status: 'uncertain' })
      .where(eq(schema.alertDeliveries.id, row!.id));
    const ask = await retry();
    expect([ask.status, ask.data.code]).toEqual([409, 'uncertain']);
    expect((await retry({ confirmUncertain: true })).status).toBe(200);
    await worker().tick();
    expect(sent()).toHaveLength(2);

    const test = await owner.call('POST', BASE + '/test', { templateId: workspace.templates[0]!.id, channel: 'email' });
    expect(test.data).toMatchObject({ test: true, status: 'sent' });
    expect(sent().at(-1)!.subject).toBe('[Test] Example client: Expirations');
    const teams = await owner.call('POST', BASE + '/test', {
      templateId: workspace.templates[0]!.id,
      channel: 'teams',
      clientId,
    });
    expect(teams.status).toBe(409);
  });

  it('skips recipients who can no longer open the client, and is for administrators only', async () => {
    const created = await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tess',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId, level: 'edit' }],
    });
    const techId = created.data.id as string;
    workspace.rules[0]!.emailUserIds = [techId];
    expect((await owner.call('PUT', BASE, { ...workspace, revision: 1 })).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 2, lastVersion: 0, note: 'Tess' });
    await t.handle.db.delete(schema.clientAccess).where(eq(schema.clientAccess.userId, techId));
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    expect(sent()).toEqual([]);
    expect((await history()).deliveries[0]).toMatchObject({ status: 'skipped', error: 'Can’t open this client.' });
    // The preview doesn't call a skipped alert sent.
    expect((await owner.call('GET', BASE + '/delivery/preview')).data.matches[0].destinations[0].existing).toBe(
      'skipped',
    );

    const { b } = await signIn(t.app, 'tech@atlas.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'copper lantern field 9' });
    await enroll(b);
    for (const [method, path] of [
      ['GET', BASE + '/delivery'],
      ['GET', BASE + '/deliveries'],
      ['GET', BASE + '/delivery/preview'],
    ] as const)
      expect((await b.call(method, path)).status).toBe(403);
  });
  it('emails staff groups, holds routine reminders in quiet hours, and sends daily summaries as one message', async () => {
    const created = await owner.call('POST', '/api/users', {
      email: 'grouped@atlas.test',
      name: 'Gale',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId, level: 'read' }],
    });
    const group = await owner.call('POST', '/api/groups', { name: 'Service desk', memberIds: [created.data.id] });
    expect(group.status, JSON.stringify(group.data)).toBe(201);
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    await owner.call('POST', `/api/clients/${clientId}/assets`, {
      layoutId: layouts.find((l) => l.key === 'ssl_certificate')!.id,
      name: 'mail.harbordental.test',
      fields: { common_name: 'mail.harbordental.test', expires: inDays(12) },
    });
    const hour = new Date().getUTCHours();
    const rule = { ...workspace.rules[0]!, emailUserIds: [], emailGroupIds: [group.data.id], delivery: 'daily' };
    // Quiet hours cover now, but a daily summary rule waits for the summary hour, which is now.
    const schedule = { timeZone: 'UTC', quietStart: hour, quietEnd: (hour + 2) % 24, summaryHour: hour };
    expect((await owner.call('PUT', BASE, { ...workspace, revision: 1, rules: [rule], schedule })).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 2, lastVersion: 0, note: 'Summaries' });
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    expect(sent().map((m) => [m.to, m.subject])).toEqual([['grouped@atlas.test', 'Alert summary: 2 items']]);
    expect((await history()).deliveries.map((d) => d.status)).toEqual(['sent', 'sent']);

    // Each alert as it happens, in quiet hours: it waits.
    const each = { ...rule, id: randomUUID(), name: 'Each', delivery: 'each' };
    expect((await owner.call('PUT', BASE, { ...workspace, revision: 2, rules: [each], schedule })).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 3, lastVersion: 1, note: 'Each' });
    await worker().tick();
    expect(sent()).toHaveLength(1);
    expect((await history()).deliveries.filter((d) => d.ruleName === 'Each').map((d) => d.status)).toEqual([
      'pending',
      'pending',
    ]);
  });
});
