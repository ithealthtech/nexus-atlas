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
        destinations: [expect.objectContaining({ channel: 'email', ready: true, alreadySent: false })],
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
    expect((await owner.call('GET', BASE + '/delivery/preview')).data.matches[0].destinations[0].alreadySent).toBe(
      true,
    );
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
  it('escalates what nobody acknowledges in time, once, and acknowledging stops it for everyone', async () => {
    const created = await owner.call('POST', '/api/users', {
      email: 'oncall@atlas.test',
      name: 'Orla',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId, level: 'read' }],
    });
    const rule = { ...workspace.rules[0]!, escalation: { afterMinutes: 15, userIds: [created.data.id], groupIds: [] } };
    expect((await owner.call('PUT', BASE, { ...workspace, revision: 1, rules: [rule] })).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 2, lastVersion: 0, note: 'Escalate' });
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    const first = sent().at(-1)!;
    expect(first.to).toBe('owner@atlas.test');
    // The email opens the alert's own page, to acknowledge it.
    const [alert] = (await history()).deliveries;
    expect(JSON.stringify(first)).toContain(`/alerts/${alert!.id}`);

    // Not yet: 10 minutes on.
    await worker().tick(new Date(Date.now() + 10 * 60_000));
    expect(sent()).toHaveLength(1);
    // 16 minutes on, nobody has acknowledged it: it goes to the on-call technician, once.
    await worker().tick(new Date(Date.now() + 16 * 60_000));
    await worker().tick(new Date(Date.now() + 30 * 60_000));
    expect(sent().map((m) => [m.to, m.subject])).toEqual([
      ['owner@atlas.test', 'Harbor Dental: Expirations'],
      ['oncall@atlas.test', 'Escalated: Harbor Dental: Expirations'],
    ]);
    expect((await history()).deliveries[0]).toMatchObject({ escalation: true, status: 'sent' });

    // Anyone who can open the client can acknowledge it, from either copy; it's recorded on both.
    const { b } = await signIn(t.app, 'oncall@atlas.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'copper lantern field 9' });
    await enroll(b);
    const escalated = (await history()).deliveries[0]!;
    expect((await b.call('GET', `/api/alerts/${escalated.id}`)).data.acknowledgedAt).toBeNull();
    const acked = await b.call('POST', `/api/alerts/${escalated.id}/acknowledge`, {});
    expect(acked.data).toMatchObject({ acknowledgedBy: 'Orla' });
    expect((await owner.call('GET', `/api/alerts/${alert!.id}`)).data.acknowledgedBy).toBe('Orla');
    const events = (await owner.call('GET', '/api/security-events')).data as { action: string }[];
    expect(events.map((e) => e.action)).toContain('Alert acknowledged');
  });

  it('doesn’t escalate an alert someone acknowledged in time', async () => {
    const rule = { ...workspace.rules[0]!, escalation: { afterMinutes: 15, userIds: [ownerId], groupIds: [] } };
    expect((await owner.call('PUT', BASE, { ...workspace, revision: 1, rules: [rule] })).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 2, lastVersion: 0, note: 'Escalate' });
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    const [alert] = (await history()).deliveries;
    expect((await owner.call('POST', `/api/alerts/${alert!.id}/acknowledge`, {})).status).toBe(200);
    await worker().tick(new Date(Date.now() + 60 * 60_000));
    expect(sent()).toHaveLength(1);
    expect((await owner.call('GET', `/api/alerts/${randomUUID()}`)).status).toBe(404);
  });
  it('gives a client its own rule instead of the rules for all clients, and sends nothing for a paused client', async () => {
    const cedar = (await owner.call('POST', '/api/clients', { name: 'Cedar Clinic' })).data.id as string;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    await owner.call('POST', `/api/clients/${cedar}/assets`, {
      layoutId: layouts.find((l) => l.key === 'ssl_certificate')!.id,
      name: 'mail.cedarclinic.test',
      fields: { common_name: 'mail.cedarclinic.test', expires: inDays(12) },
    });
    const tech = await owner.call('POST', '/api/users', {
      email: 'cedar@atlas.test',
      name: 'Cass',
      password: TEMP,
      role: 'technician',
      grants: [{ clientId: cedar, level: 'read' }],
    });
    const own = {
      ...workspace.rules[0]!,
      id: randomUUID(),
      name: 'Cedar on call',
      clientIds: [cedar],
      emailUserIds: [tech.data.id],
    };
    // A replacing rule needs its clients, and each client is paused once.
    const bad = {
      ...workspace,
      revision: 1,
      rules: [...workspace.rules, { ...own, clientIds: [], replacesGeneral: true }],
    };
    expect((await owner.call('PUT', BASE, bad)).status).toBe(400);
    const twice = [
      { clientId, until: null, note: '' },
      { clientId, until: null, note: '' },
    ];
    expect((await owner.call('PUT', BASE, { ...workspace, revision: 1, pauses: twice })).status).toBe(400);

    const next = {
      ...workspace,
      revision: 1,
      rules: [...workspace.rules, { ...own, replacesGeneral: true }],
      pauses: [{ clientId, until: null, note: 'Offboarding' }],
    };
    expect((await owner.call('PUT', BASE, next)).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 2, lastVersion: 0, note: 'Overrides' });
    const preview = (await owner.call('GET', BASE + '/delivery/preview')).data as AlertDryRun;
    expect(preview.matches.map((m) => [m.ruleName, m.clientName])).toEqual([['Cedar on call', 'Cedar Clinic']]);
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    // Cedar's own rule replaces the rule for all clients; Harbor Dental is paused.
    expect(sent().map((m) => [m.to, m.subject])).toEqual([['cedar@atlas.test', 'Cedar Clinic: Expirations']]);

    // Resumed: what's still due for Harbor Dental sends then.
    const resumed = { ...next, revision: 2, pauses: [] };
    expect((await owner.call('PUT', BASE, resumed)).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 3, lastVersion: 1, note: 'Resume' });
    await worker().tick();
    expect(sent().map((m) => m.to)).toEqual(['cedar@atlas.test', 'owner@atlas.test']);
  });

  it('ends a pause after its last day', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const next = { ...workspace, revision: 1, pauses: [{ clientId, until: yesterday, note: '' }] };
    expect((await owner.call('PUT', BASE, next)).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 2, lastVersion: 0, note: 'Pause ended' });
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true, sendDue: true });
    await worker().tick();
    expect(sent()).toHaveLength(1);
  });
  it('alerts on infections a monitoring tool reports, once each, and a resolution acknowledges them', async () => {
    const report = (status: 'active' | 'resolved') =>
      owner.call('POST', `/api/clients/${clientId}/teams/infections`, {
        eventId: 'incident-4821',
        assetId,
        status,
        source: 'NinjaOne',
      });
    const [asset] = await t.handle.db.select().from(schema.assets).where(eq(schema.assets.clientId, clientId));
    const assetId = asset!.id;
    const template = workspace.templates.find((v) => v.kind === 'infection')!;
    const rule = {
      ...workspace.rules[0]!,
      id: randomUUID(),
      name: 'Infections',
      kind: 'infection' as const,
      templateId: template.id,
      daysBefore: [],
      includeOverdue: false,
      escalation: { afterMinutes: 15, userIds: [ownerId], groupIds: [] },
    };
    // Classic alerts, without Teams set up: the feed is refused, as before.
    expect((await report('active')).status).toBe(409);
    expect((await owner.call('PUT', BASE, { ...workspace, revision: 1, rules: [rule] })).status).toBe(200);
    await owner.call('POST', BASE + '/publish', { revision: 2, lastVersion: 0, note: 'Infections' });
    await owner.call('PUT', BASE + '/delivery', { mode: 'center', confirm: true });
    await worker().tick();
    // Reported before going live: recorded as already handled.
    expect(sent()).toEqual([]);

    // Live: a resolution alerts, then a new report of the same incident alerts once.
    expect((await report('resolved')).status).toBe(202);
    await worker().tick();
    expect((await report('active')).status).toBe(202);
    expect((await report('active')).status).toBe(202);
    await worker().tick();
    await worker().tick();
    const subjects = () => sent().map((m) => m.subject);
    expect(subjects()).toEqual(['Harbor Dental: Confirmed infections', 'Harbor Dental: Confirmed infections']);
    const rows = (await history()).deliveries.filter((d) => d.status === 'sent');
    expect(rows.map((d) => d.reason).sort()).toEqual(['Infection reported', 'Infection resolved']);
    // A resolution is information: there's nothing to acknowledge.
    expect(rows.find((d) => d.reason === 'Infection resolved')!.acknowledgedBy).toBe('Resolved by NinjaOne');

    // Resolved: the open alert is acknowledged by the tool, so it doesn't escalate, and the resolution alerts.
    const open = (await history()).deliveries.find((d) => d.reason === 'Infection reported' && d.status === 'sent')!;
    expect((await report('resolved')).status).toBe(202);
    expect((await owner.call('GET', `/api/alerts/${open.id}`)).data.acknowledgedBy).toBe('Resolved by NinjaOne');
    await worker().tick(new Date(Date.now() + 20 * 60_000));
    expect(subjects()).toHaveLength(3);
    expect(subjects().some((s) => s.startsWith('Escalated'))).toBe(false);
    const events = (await owner.call('GET', '/api/security-events')).data as { action: string }[];
    expect(events.map((e) => e.action)).toContain('Infection report received');
  });
});
