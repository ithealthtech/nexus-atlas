import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { SiemEvent } from '@atlas/shared';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { EmergencyAccessService } from '../src/services/emergency.js';
import { MailService } from '../src/services/mail.js';
import { SettingsService, type SiemConfig } from '../src/services/settings.js';
import { defaultSender, signBody, syslogLine } from '../src/services/siem.js';
import { OWNER, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';
const NEXT = 'fresh long passphrase 9';
const SECRET = 'Tr0ub4dor&3-Harbor-Firewall!';
const SMTP = {
  enabled: true,
  preset: 'm365',
  host: 'smtp.office365.com',
  port: 587,
  security: 'starttls',
  username: 'atlas@itdonerightnc.test',
  password: 'smtp-app-secret-9981',
  fromAddress: 'atlas@itdonerightnc.test',
  fromName: 'IT Done Right',
};

describe('vault policies and emergency access', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  const sent: { config: SiemConfig; events: SiemEvent[] }[] = [];
  let failSiem = false;

  beforeEach(async () => {
    sent.length = 0;
    failSiem = false;
    t = await startApp(
      {},
      {
        siemSender: async (config, events) => {
          if (failSiem) throw new Error('connection refused');
          sent.push({ config, events });
        },
      },
    );
    owner = (await setupOwner(t.app)).b;
    await owner.call('PUT', '/api/settings/email', SMTP);
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  async function person(email: string, body: Record<string, unknown>, staff = true) {
    const created = await owner.call('POST', '/api/users', {
      email,
      name: email.split('@')[0],
      password: TEMP,
      ...body,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const { b } = await signIn(t.app, email, TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: NEXT });
    if (staff) await enroll(b);
    return { b, id: created.data.id as string };
  }
  const create = (b: Browser, body: Record<string, unknown> = {}) =>
    b.call('POST', `/api/clients/${harbor}/passwords`, { name: 'HDG-FW-01 admin', secret: SECRET, ...body });
  const events = async () =>
    (await t.handle.db.execute(sql`select action, detail from security_events order by id`)).rows as {
      action: string;
      detail: string;
    }[];

  it('lets only the owner change the policies, and shows who can reach passwords without MFA', async () => {
    const admin = await person('ada@atlas.test', { role: 'admin' });
    await person('viewer@atlas.test', { role: 'client_viewer', grants: [{ clientId: harbor, level: 'read' }] }, false);

    expect((await owner.call('GET', '/api/vault/policy')).data).toMatchObject({
      generator: { minLength: 12, requireDigits: false, requireSymbols: false, allowPins: true },
      requireRevealReason: false,
      blockReadOnlyReveal: false,
      restrictedListedOnly: false,
    });
    const view = (await admin.b.call('GET', '/api/settings/vault-policy')).data;
    expect(view.mfa.requiredForStaff).toBe(true);
    expect(view.mfa.withoutMfa.map((u: { email: string }) => u.email)).toEqual(['viewer@atlas.test']);

    const change = {
      generator: { minLength: 20, requireDigits: true, requireSymbols: true, allowPins: false },
      requireRevealReason: true,
      blockReadOnlyReveal: true,
      restrictedListedOnly: false,
    };
    expect((await admin.b.call('PUT', '/api/settings/vault-policy', change)).status).toBe(403);
    expect(
      (await owner.call('PUT', '/api/settings/vault-policy', { ...change, generator: { minLength: 8 } })).status,
    ).toBe(400);
    const saved = await owner.call('PUT', '/api/settings/vault-policy', change);
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    // Blocked client viewers can't reveal, so they no longer count as reaching passwords.
    expect(saved.data.mfa.withoutMfa).toEqual([]);
    expect((await admin.b.call('GET', '/api/vault/policy')).data.generator.minLength).toBe(20);
    expect((await events()).at(-1)).toMatchObject({ action: 'Vault policies changed' });
    expect((await events()).at(-1)!.detail).toContain('Generator 20+ characters, numbers, symbols, no PINs');
  });

  it('requires a reason for every reveal when the organization says so', async () => {
    const item = (await create(owner)).data;
    expect(item.requireReason).toBe(false);
    await owner.call('PUT', '/api/settings/vault-policy', { requireRevealReason: true });
    expect((await owner.call('GET', `/api/passwords/${item.id}`)).data.requireReason).toBe(true);
    expect((await owner.call('GET', '/api/passwords')).data[0].requireReason).toBe(true);
    const bare = await owner.call('POST', `/api/passwords/${item.id}/reveal`, {});
    expect(bare.status).toBe(400);
    expect(bare.data.code).toBe('reason_required');
    expect(
      (
        await owner.call('POST', `/api/passwords/${item.id}/shares`, {
          ciphertext: 'x'.repeat(40),
          maxViews: 1,
          expiresHours: 1,
        })
      ).status,
    ).toBe(400);
    const ok = await owner.call('POST', `/api/passwords/${item.id}/reveal`, { reason: 'Ticket 4411' });
    expect(ok.data.value).toBe(SECRET);
  });

  it('blocks reveals for read-only roles when the policy says so', async () => {
    const item = (await create(owner, { clientVisible: true })).data;
    const viewer = await person(
      'viewer@atlas.test',
      { role: 'client_viewer', grants: [{ clientId: harbor, level: 'read' }] },
      false,
    );
    expect((await viewer.b.call('POST', `/api/passwords/${item.id}/reveal`, {})).data.value).toBe(SECRET);
    await owner.call('PUT', '/api/settings/vault-policy', { blockReadOnlyReveal: true });
    const listed = (await viewer.b.call('GET', `/api/passwords?client=${harbor}`)).data;
    expect(listed).toHaveLength(1);
    expect(listed[0].canReveal).toBe(false);
    const blocked = await viewer.b.call('POST', `/api/passwords/${item.id}/reveal`, {});
    expect(blocked.status).toBe(403);
    expect(blocked.data.code).toBe('reveal_blocked');
    // Staff are unaffected.
    expect((await owner.call('GET', `/api/passwords/${item.id}`)).data.canReveal).toBe(true);
    expect((await owner.call('POST', `/api/passwords/${item.id}/reveal`, {})).data.value).toBe(SECRET);
  });

  it('keeps restricted passwords from administrators who are not listed, when restricted means listed only', async () => {
    const admin = await person('ada@atlas.test', { role: 'admin' });
    const item = (await create(owner, { restricted: true })).data;
    // By default administrators see every restricted password.
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(200);

    await owner.call('PUT', '/api/settings/vault-policy', { restrictedListedOnly: true });
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);
    expect((await admin.b.call('POST', `/api/passwords/${item.id}/reveal`, {})).status).toBe(404);
    expect((await admin.b.call('GET', '/api/passwords')).data).toEqual([]);
    expect((await admin.b.call('GET', '/api/search?q=HDG')).data.map((r: { type: string }) => r.type)).not.toContain(
      'password',
    );
    expect((await admin.b.call('GET', `/api/activity?client=${harbor}`)).data).toEqual([]);
    // The owner always sees everything.
    expect((await owner.call('GET', `/api/passwords/${item.id}`)).status).toBe(200);

    // Listing the administrator gives them the password again.
    await owner.call('PUT', `/api/passwords/${item.id}/access`, { userIds: [admin.id], groupIds: [] });
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(200);

    // An administrator who restricts a password is listed on it, so they keep it.
    const own = (await create(admin.b, { name: 'Ada’s break-glass', restricted: true })).data;
    expect(own.restricted).toBe(true);
    expect((await admin.b.call('GET', `/api/passwords/${own.id}/access`)).data.userIds).toEqual([admin.id]);
    const other = (await create(owner, { name: 'Switch admin' })).data;
    const restricted = await admin.b.call('PATCH', `/api/passwords/${other.id}`, { version: 1, restricted: true });
    expect(restricted.status, JSON.stringify(restricted.data)).toBe(200);
    expect((await admin.b.call('GET', `/api/passwords/${other.id}/access`)).data.userIds).toEqual([admin.id]);
  });

  it('runs emergency access: request, wait, owner notice, access, and an audit trail', async () => {
    const admin = await person('ada@atlas.test', { role: 'admin' });
    const other = await person('bo@atlas.test', { role: 'admin' });
    const tech = await person('tess@atlas.test', { role: 'technician', allClients: 'edit_passwords' });
    await owner.call('PUT', '/api/settings/vault-policy', { restrictedListedOnly: true });
    const item = (await create(owner, { restricted: true })).data;

    // Only the owner names trusted administrators, and only administrators can be named.
    expect((await admin.b.call('PUT', '/api/emergency-access/contacts', { userId: admin.id })).status).toBe(403);
    expect((await owner.call('PUT', '/api/emergency-access/contacts', { userId: tech.id })).status).toBe(400);
    const added = await owner.call('PUT', '/api/emergency-access/contacts', { userId: admin.id, waitHours: 24 });
    expect(added.status, JSON.stringify(added.data)).toBe(200);
    expect(added.data.contacts).toMatchObject([{ userId: admin.id, waitHours: 24 }]);
    expect(t.outbox.some((m) => m.to === 'ada@atlas.test' && /can request emergency access/.test(m.subject))).toBe(
      true,
    );

    // Someone not on the list can't ask.
    expect((await other.b.call('POST', '/api/emergency-access/requests', { reason: 'Owner away' })).status).toBe(403);
    expect((await tech.b.call('GET', '/api/emergency-access')).status).toBe(403);
    expect((await admin.b.call('POST', '/api/emergency-access/requests', {})).status).toBe(400);

    const asked = await admin.b.call('POST', '/api/emergency-access/requests', {
      reason: 'Owner in hospital, ISP outage',
    });
    expect(asked.status, JSON.stringify(asked.data)).toBe(200);
    const request = asked.data.requests[0];
    expect(request).toMatchObject({ status: 'pending', reason: 'Owner in hospital, ISP outage' });
    expect(Date.parse(request.availableAt) - Date.parse(request.requestedAt)).toBe(24 * 3_600_000);
    expect(t.outbox.some((m) => m.to === OWNER.email && /emergency access was requested/.test(m.subject))).toBe(true);
    expect((await admin.b.call('POST', '/api/emergency-access/requests', { reason: 'again' })).status).toBe(409);
    // Other administrators don't see someone else's request.
    expect((await other.b.call('GET', '/api/emergency-access')).data.requests).toEqual([]);
    expect((await other.b.call('POST', `/api/emergency-access/requests/${request.id}/end`, {})).status).toBe(404);

    // During the wait there is no access.
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);

    // The owner denies it; the administrator asks again, and this time the wait passes.
    expect((await admin.b.call('POST', `/api/emergency-access/requests/${request.id}/deny`, {})).status).toBe(403);
    const denied = await owner.call('POST', `/api/emergency-access/requests/${request.id}/deny`, {});
    expect(denied.data.requests[0].status).toBe('denied');
    expect(t.outbox.some((m) => m.to === 'ada@atlas.test' && /was denied/.test(m.subject))).toBe(true);
    const again = (await admin.b.call('POST', '/api/emergency-access/requests', { reason: 'Still out' })).data
      .requests[0];
    await t.handle.db.execute(
      sql`update emergency_requests set available_at = now() - interval '1 minute', ends_at = now() + interval '1 day' where id = ${again.id}`,
    );
    expect((await admin.b.call('GET', '/api/emergency-access')).data.requests[0].status).toBe('active');
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(200);
    expect((await admin.b.call('GET', '/api/passwords')).data.map((p: { id: string }) => p.id)).toEqual([item.id]);
    const revealed = await admin.b.call('POST', `/api/passwords/${item.id}/reveal`, { reason: 'Router reboot' });
    expect(revealed.data.value).toBe(SECRET);
    const audit = (await owner.call('GET', `/api/passwords/${item.id}/audit`)).data;
    expect(audit[0]).toMatchObject({
      actorName: 'ada',
      action: 'Revealed password',
      reason: 'Emergency access: Router reboot',
    });

    // The background notice goes out once, to the owner and the administrator.
    const keys = staticKeyProvider([randomBytes(32)]);
    const settings = new SettingsService(t.handle.db, keys);
    const orgId = (await t.handle.db.execute(sql`select id from orgs`)).rows[0]!.id as string;
    await settings.saveSmtp(orgId, SMTP);
    const notices: string[] = [];
    const service = new EmergencyAccessService(
      t.handle.db,
      new MailService(settings, async (_smtp, message) => void notices.push(`${message.to}|${message.subject}`)),
      'http://localhost',
    );
    expect(await service.announceStarts(orgId)).toBe(1);
    expect(await service.announceStarts(orgId)).toBe(0);
    expect(notices.sort()).toEqual([
      'ada@atlas.test|Atlas: emergency access has started',
      `${OWNER.email}|Atlas: emergency access has started`,
    ]);

    // The owner ends it early, and access stops.
    const ended = await owner.call('POST', `/api/emergency-access/requests/${again.id}/end`, {});
    expect(ended.data.requests[0].status).toBe('ended');
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);

    // Approval starts access at once; removing the administrator from the list ends it.
    const third = (await admin.b.call('POST', '/api/emergency-access/requests', { reason: 'Third time' })).data
      .requests[0];
    expect(
      (await owner.call('POST', `/api/emergency-access/requests/${third.id}/approve`, {})).data.requests[0].status,
    ).toBe('active');
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(200);
    await owner.call('DELETE', `/api/emergency-access/contacts/${admin.id}`);
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);
    expect((await owner.call('GET', '/api/emergency-access')).data.requests[0].status).toBe('ended');

    expect((await events()).map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'Emergency access contact added',
        'Emergency access requested',
        'Emergency access denied',
        'Emergency access started',
        'Emergency access ended',
        'Emergency access approved',
        'Emergency access contact removed',
      ]),
    );
  });

  it('expires emergency access after its window', async () => {
    const admin = await person('ada@atlas.test', { role: 'admin' });
    await owner.call('PUT', '/api/settings/vault-policy', { restrictedListedOnly: true });
    const item = (await create(owner, { restricted: true })).data;
    await owner.call('PUT', '/api/emergency-access/contacts', { userId: admin.id, waitHours: 1 });
    const request = (await admin.b.call('POST', '/api/emergency-access/requests', { reason: 'Owner away' })).data
      .requests[0];
    await t.handle.db.execute(
      sql`update emergency_requests set available_at = now() - interval '2 days', ends_at = now() - interval '1 day' where id = ${request.id}`,
    );
    expect((await admin.b.call('GET', '/api/emergency-access')).data.requests[0].status).toBe('expired');
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);
    // A demoted administrator loses access even while a request is running.
    await t.handle.db.execute(
      sql`update emergency_requests set ends_at = now() + interval '1 day' where id = ${request.id}`,
    );
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(200);
    await owner.call('PATCH', `/api/users/${admin.id}`, { role: 'technician', allClients: 'edit_passwords' });
    expect((await admin.b.call('GET', `/api/passwords/${item.id}`)).status).toBe(404);
  });
});

describe('SIEM streaming', () => {
  let t: TestApp;
  let owner: Browser;
  const sent: { config: SiemConfig; events: SiemEvent[] }[] = [];
  let failSiem = false;

  beforeEach(async () => {
    sent.length = 0;
    failSiem = false;
    t = await startApp(
      {},
      {
        siemSender: async (config, events) => {
          if (failSiem) throw new Error('connection refused');
          sent.push({ config, events: structuredClone(events) });
        },
      },
    );
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('streams new security and vault events from where it left off, and retries after a failure', async () => {
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Firewall', secret: SECRET });
    expect((await owner.call('GET', '/api/settings/siem')).data).toMatchObject({ enabled: false, pending: 0 });
    expect((await owner.call('PUT', '/api/settings/siem', { enabled: true, method: 'webhook' })).status).toBe(400);
    expect(
      (await owner.call('PUT', '/api/settings/siem', { enabled: true, method: 'webhook', url: 'http://siem.example' }))
        .status,
    ).toBe(400);
    const saved = await owner.call('PUT', '/api/settings/siem', {
      enabled: true,
      method: 'webhook',
      url: 'https://siem.example/hooks/atlas',
      secret: 'signing-secret-7731',
    });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data).toMatchObject({ enabled: true, hasSecret: true, url: 'https://siem.example/hooks/atlas' });
    expect(JSON.stringify(saved.data)).not.toContain('signing-secret-7731');
    const stored = JSON.stringify((await t.handle.db.execute(sql`select settings from orgs`)).rows);
    expect(stored).not.toContain('signing-secret-7731');

    // History before streaming started isn't sent; the save itself is the first event.
    expect(saved.data.pending).toBe(1);
    const first = await owner.call('POST', '/api/settings/siem/send', {});
    expect(first.data.sent).toBe(1);
    expect(sent[0]!.config.secret).toBe('signing-secret-7731');
    expect(sent[0]!.events).toMatchObject([
      { log: 'security', action: 'SIEM streaming changed', organization: OWNER.organization },
    ]);

    const item = (await owner.call('GET', '/api/passwords')).data[0];
    await owner.call('POST', `/api/passwords/${item.id}/reveal`, { reason: 'Ticket 7' });
    failSiem = true;
    const failed = await owner.call('POST', '/api/settings/siem/send', {});
    expect(failed.status).toBe(502);
    expect((await owner.call('GET', '/api/settings/siem')).data).toMatchObject({
      lastError: 'Sending the vault log failed: connection refused',
      pending: 1,
    });
    failSiem = false;
    const retried = await owner.call('POST', '/api/settings/siem/send', {});
    expect(retried.data).toMatchObject({ sent: 1, lastError: null, pending: 0 });
    expect(sent.at(-1)!.events).toMatchObject([
      {
        log: 'vault',
        action: 'Revealed password',
        password: 'Firewall',
        client: 'Harbor Dental Group',
        reason: 'Ticket 7',
      },
    ]);
    expect((await owner.call('POST', '/api/settings/siem/send', {})).data.sent).toBe(0);

    // Turning off a log stops it; the test event moves no cursor.
    await owner.call('PUT', '/api/settings/siem', {
      enabled: true,
      method: 'webhook',
      url: 'https://siem.example/hooks/atlas',
      security: true,
      vault: false,
    });
    await owner.call('POST', `/api/passwords/${item.id}/reveal`, { reason: 'Ticket 8' });
    expect((await owner.call('POST', '/api/settings/siem/test', {})).status).toBe(200);
    expect(sent.at(-1)!.events[0]).toMatchObject({ action: 'SIEM test event', id: '0' });
    const logs = (await owner.call('POST', '/api/settings/siem/send', {})).data;
    expect(sent.at(-1)!.events.every((e) => e.log === 'security')).toBe(true);
    expect(logs.pending).toBe(0);
  });

  it('is for administrators only', async () => {
    const created = await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess',
      password: TEMP,
      role: 'technician',
      allClients: 'read',
    });
    const { b } = await signIn(t.app, 'tess@atlas.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: NEXT });
    await enroll(b);
    expect(created.status).toBe(201);
    expect((await b.call('GET', '/api/settings/siem')).status).toBe(403);
    expect((await b.call('PUT', '/api/settings/siem', { enabled: false })).status).toBe(403);
    expect((await b.call('GET', '/api/settings/vault-policy')).status).toBe(403);
    expect((await b.call('GET', '/api/vault/policy')).status).toBe(200);
  });
});

describe('SIEM delivery', () => {
  const event: SiemEvent = {
    source: 'msp-atlas',
    log: 'security',
    id: '42',
    time: '2026-09-29T12:00:00.000Z',
    organization: 'IT Done Right',
    actor: 'Avery Owner',
    action: 'Sign-in failed',
    detail: 'Incorrect password\nsecond line',
    ip: '203.0.113.9',
  };
  const base: SiemConfig = {
    enabled: true,
    method: 'syslog',
    url: '',
    secret: '',
    host: '127.0.0.1',
    port: 0,
    transport: 'udp',
    security: true,
    vault: true,
    cursor: { security: 0, vault: 0 },
    lastSentAt: null,
    lastError: null,
  };

  it('formats RFC 5424 syslog lines with the event as JSON', () => {
    const line = syslogLine(event, 'atlas.itdonerightnc.test');
    expect(line.startsWith('<108>1 2026-09-29T12:00:00.000Z atlas.itdonerightnc.test msp-atlas - security - {')).toBe(
      true,
    );
    expect(JSON.parse(line.slice(line.indexOf('{')))).toEqual(event);
    expect(syslogLine({ ...event, action: 'Revealed password' }, 'h').startsWith('<110>1 ')).toBe(true);
  });

  it('sends syslog over UDP and TCP (octet counting)', async () => {
    const udp = dgram.createSocket('udp4');
    const got = new Promise<string>((resolve) => udp.once('message', (m) => resolve(m.toString())));
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    await defaultSender()({ ...base, port: udp.address().port }, [event], 'atlas.test');
    expect(await got).toBe(syslogLine(event, 'atlas.test'));
    udp.close();

    let received = '';
    const server = net.createServer((socket) => socket.on('data', (d) => (received += d.toString())));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    await defaultSender()({ ...base, transport: 'tcp', port }, [event, { ...event, id: '43' }], 'atlas.test');
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.close();
    const one = syslogLine(event, 'atlas.test');
    const two = syslogLine({ ...event, id: '43' }, 'atlas.test');
    expect(received).toBe(`${Buffer.byteLength(one)} ${one}${Buffer.byteLength(two)} ${two}`);
  });

  it('signs webhook bodies and treats redirects and errors as failures', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 204;
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const config = { ...base, method: 'webhook' as const, url: 'https://siem.example/in', secret: 'k' };
    await defaultSender(fake)(config, [event], 'atlas.test');
    const body = String(calls[0]!.init.body);
    expect(JSON.parse(body)).toEqual({ events: [event] });
    expect((calls[0]!.init.headers as Record<string, string>)['X-Atlas-Signature']).toBe(signBody('k', body));
    expect(calls[0]!.init.redirect).toBe('manual');
    status = 302;
    await expect(defaultSender(fake)(config, [event], 'atlas.test')).rejects.toThrow(/302/);
    status = 500;
    await expect(defaultSender(fake)(config, [event], 'atlas.test')).rejects.toThrow(/500/);
  });
});
