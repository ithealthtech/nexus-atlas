import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { MailService, type SendArgs } from '../src/services/mail.js';
import { ReportScheduleService } from '../src/services/report-schedules.js';
import { ReportShareService } from '../src/services/report-shares.js';
import { ReportService } from '../src/services/reports.js';
import { SettingsService } from '../src/services/settings.js';
import type { ReportDeliveryView } from '@atlas/shared';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

describe('scheduled reports', () => {
  let t: TestApp, owner: Browser, orgId: string, clientId: string, otherId: string;
  let sent: SendArgs[];
  let service: ReportScheduleService;

  beforeEach(async () => {
    const keys = staticKeyProvider([randomBytes(32)]);
    t = await startApp({}, { keys });
    owner = (await setupOwner(t.app)).b;
    orgId = (await owner.call('GET', '/api/session')).data.actor.orgId;
    await owner.call('PUT', '/api/settings/email', {
      enabled: true,
      preset: 'm365',
      host: 'smtp.office365.com',
      port: 587,
      security: 'starttls',
      username: 'atlas@itdonerightnc.test',
      password: 'smtp-app-secret-9981',
      fromAddress: 'atlas@itdonerightnc.test',
      fromName: 'IT Done Right',
    });
    clientId = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    otherId = (await owner.call('POST', '/api/clients', { name: 'Other Client' })).data.id;
    await owner.call('POST', `/api/clients/${clientId}/licenses`, {
      name: 'Design Suite',
      seats: 10,
      unitCostCents: 1500,
    });
    // The background pass, with a mailbox that refuses one address.
    sent = [];
    const settings = new SettingsService(t.handle.db, keys);
    const mail = new MailService(settings, async (_smtp, message) => {
      if (message.to === 'bounce@harbor.example') throw new Error('550 no such user');
      sent.push(message);
    });
    service = new ReportScheduleService(t.handle.db, {
      reports: new ReportService(settings),
      shares: new ReportShareService(t.handle.db, 'http://localhost'),
      mail,
      settings,
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const schedule = (extra: Record<string, unknown> = {}) => ({
    name: 'Monthly licenses',
    definition: { kind: 'licenses', title: 'License utilization', clientIds: [clientId], includeMicrosoft: false },
    cadence: 'monthly',
    day: 1,
    hour: 7,
    recipients: ['office@harbor.example', 'owner@harbor.example'],
    clientLink: true,
    ...extra,
  });
  const row = async (id: string) =>
    (await t.handle.db.select().from(schema.reportSchedules).where(eq(schema.reportSchedules.id, id)))[0]!;
  const makeDue = (id: string) =>
    t.handle.db
      .update(schema.reportSchedules)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.reportSchedules.id, id));

  it('sends a due schedule once, with the whole report attached and a client link, then moves it on', async () => {
    const made = await owner.call('POST', '/api/reports/schedules', schedule());
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    expect(Date.parse(made.data.nextRunAt)).toBeGreaterThan(Date.now());
    // Not due yet: nothing goes out.
    await service.runDue(orgId);
    expect(sent).toHaveLength(0);

    await makeDue(made.data.id);
    const now = new Date();
    await service.runDue(orgId, now);
    expect(sent.map((m) => m.to)).toEqual(['office@harbor.example', 'owner@harbor.example']);
    const [first] = sent;
    expect(first!.subject).toBe('Monthly licenses: Harbor Dental');
    expect(first!.attachments?.[0]?.filename).toMatch(/^Monthly licenses \d{4}-\d{2}-\d{2}\.pdf$/);
    expect(first!.attachments?.[0]?.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(first!.html).toContain('/report/');
    const after = await row(made.data.id);
    expect(after.lastStatus).toBe('sent');
    expect(after.nextRunAt.getTime()).toBeGreaterThan(now.getTime());
    // The snapshot is in the owner's history, so Compare works on it.
    const history = (await owner.call('GET', '/api/reports/runs')).data as { id: string }[];
    expect(history.map((h) => h.id)).toContain(after.lastRunId);
    // Claimed and moved on: a second pass (or a second server) sends nothing more.
    await service.runDue(orgId, now);
    expect(sent).toHaveLength(2);
  });

  it('logs every delivery, and resends one snapshot to its recipient without running the report again', async () => {
    const made = (
      await owner.call(
        'POST',
        '/api/reports/schedules',
        schedule({ recipients: ['office@harbor.example', 'bounce@harbor.example'] }),
      )
    ).data;
    await makeDue(made.id);
    await service.runDue(orgId);
    const log = (await owner.call('GET', `/api/reports/schedules/${made.id}/deliveries`)).data as ReportDeliveryView[];
    expect(log.map((d) => [d.recipient, d.status, d.trigger]).sort()).toEqual([
      ['bounce@harbor.example', 'failed', 'schedule'],
      ['office@harbor.example', 'sent', 'schedule'],
    ]);
    const refused = log.find((d) => d.status === 'failed')!;
    expect(refused.error).toContain('550');
    expect(refused.canResend).toBe(true);

    // Resent through Atlas's own mail, which accepts it: the same snapshot, not a new run.
    const runs = async () => (await t.handle.db.select().from(schema.reportRuns)).length;
    const before = await runs();
    const resent = await owner.call('POST', `/api/reports/deliveries/${refused.id}/resend`);
    expect(resent.status, JSON.stringify(resent.data)).toBe(200);
    expect(resent.data[0]).toMatchObject({ recipient: 'bounce@harbor.example', status: 'sent', trigger: 'resend' });
    expect(t.outbox.some((m) => m.to === 'bounce@harbor.example' && m.attachments?.length === 1)).toBe(true);
    expect(await runs()).toBe(before);

    // Once the snapshot leaves the owner's history there is nothing to resend.
    const { lastRunId } = await row(made.id);
    expect((await owner.call('DELETE', `/api/reports/runs/${lastRunId}`)).status).toBe(200);
    const after = (await owner.call('GET', `/api/reports/schedules/${made.id}/deliveries`))
      .data as ReportDeliveryView[];
    expect(after.every((d) => !d.canResend)).toBe(true);
    expect((await owner.call('POST', `/api/reports/deliveries/${refused.id}/resend`)).status).toBe(409);
    // Deleting the schedule deletes its log.
    expect((await owner.call('DELETE', `/api/reports/schedules/${made.id}`, { version: made.version })).status).toBe(
      200,
    );
    expect(await t.handle.db.select().from(schema.reportDeliveries)).toEqual([]);
  });

  it('records a refused recipient and a disabled owner instead of failing the pass', async () => {
    const made = (
      await owner.call(
        'POST',
        '/api/reports/schedules',
        schedule({ recipients: ['office@harbor.example', 'bounce@harbor.example'] }),
      )
    ).data;
    await makeDue(made.id);
    await service.runDue(orgId);
    expect(sent.map((m) => m.to)).toEqual(['office@harbor.example']);
    let saved = await row(made.id);
    expect(saved.lastStatus).toBe('failed');
    expect(saved.lastError).toContain('bounce@harbor.example');

    await t.handle.db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, saved.ownerId));
    await makeDue(made.id);
    await service.runDue(orgId);
    saved = await row(made.id);
    expect(saved.lastError).toContain('can no longer sign in');
    expect(sent).toHaveLength(1);
  });

  it('sends now through the API, keeps schedules private, and checks access and versions', async () => {
    const made = (await owner.call('POST', '/api/reports/schedules', schedule({ clientLink: false }))).data;
    const now = await owner.call('POST', `/api/reports/schedules/${made.id}/send`);
    expect(now.status, JSON.stringify(now.data)).toBe(200);
    expect(now.data).toMatchObject({ lastStatus: 'sent', nextRunAt: made.nextRunAt });
    expect(t.outbox.filter((m) => m.subject === 'Monthly licenses: Harbor Dental')).toHaveLength(2);

    // A client link only for one client.
    expect(
      (
        await owner.call(
          'POST',
          '/api/reports/schedules',
          schedule({ definition: { kind: 'licenses', title: 'Both', clientIds: [clientId, otherId] } }),
        )
      ).status,
    ).toBe(400);
    // Stale edits are refused; current ones bump the version.
    const edited = await owner.call('PUT', `/api/reports/schedules/${made.id}`, {
      ...schedule(),
      version: made.version,
    });
    expect(edited.status, JSON.stringify(edited.data)).toBe(200);
    expect(
      (await owner.call('PUT', `/api/reports/schedules/${made.id}`, { ...schedule(), version: made.version })).status,
    ).toBe(409);

    // Someone else sees none of it.
    const temporary = 'temporary schedule pass 1234';
    await owner.call('POST', '/api/users', {
      email: 'schedule-viewer@atlas.test',
      name: 'Schedule Viewer',
      role: 'client_viewer',
      password: temporary,
      grants: [{ clientId, level: 'read' }],
    });
    const { b } = await signIn(t.app, 'schedule-viewer@atlas.test', temporary);
    await b.call('POST', '/api/account/password', { current: temporary, next: 'replaced schedule pass 4321' });
    expect((await b.call('GET', '/api/reports/schedules')).data).toEqual([]);
    expect((await b.call('POST', `/api/reports/schedules/${made.id}/send`)).status).toBe(404);
    expect((await b.call('DELETE', `/api/reports/schedules/${made.id}`, { version: 2 })).status).toBe(404);
    // Nor can they schedule a client link, which needs edit access.
    expect((await b.call('POST', '/api/reports/schedules', schedule())).status).toBe(403);

    // Deleting the client removes its schedules.
    expect(
      (await owner.call('DELETE', `/api/clients/${clientId}`, { confirmName: 'Harbor Dental' })).status,
    ).toBeLessThan(300);
    expect(await t.handle.db.select().from(schema.reportSchedules)).toEqual([]);
  });
});
