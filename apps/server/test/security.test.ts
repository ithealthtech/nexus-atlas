import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { totp } from '../src/identity/totp.js';
import { AuditService, toCsv } from '../src/services/audit.js';
import { ExpirationService } from '../src/services/expirations.js';
import { MailService } from '../src/services/mail.js';
import { Notifier } from '../src/services/notifier.js';
import { SettingsService } from '../src/services/settings.js';
import { VaultService } from '../src/services/vault.js';
import { VaultKeys } from '../src/crypto/vault-keys.js';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { randomBytes } from 'node:crypto';
import { OWNER, browser, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';
import { SoftAuthenticator } from './webauthn.js';

const TEMP = 'temporary pass 1234';
const M365 = {
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

describe('account security', () => {
  let t: TestApp;
  let owner: Browser;
  let secret: string;
  beforeEach(async () => {
    t = await startApp();
    ({ b: owner, secret } = await setupOwner(t.app));
  });
  afterEach(async () => {
    await t.close();
  });

  const expireReauth = () => t.handle.db.execute(sql`update sessions set reauth_at = now() - interval '1 hour'`);
  // Waits for the next TOTP step so a fresh code isn't rejected as a replay.
  const nextCode = async (key: string) => {
    const code = totp(key);
    for (let i = 0; i < 40 && totp(key) === code; i++) await new Promise((r) => setTimeout(r, 1000));
    return totp(key);
  };

  it('issues recovery codes once, accepts each code once, and replaces them after reauthentication', async () => {
    // Codes came back when MFA was confirmed; regenerate to capture them here.
    const regen = await owner.call('POST', '/api/account/recovery-codes', {});
    expect(regen.status).toBe(200);
    const codes: string[] = regen.data.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const stored = await t.handle.db.execute(sql`select recovery_codes::text as c from users`);
    expect((stored.rows[0] as { c: string }).c).not.toContain(codes[0]!.replace('-', ''));

    const { b, r } = await signIn(t.app, OWNER.email, OWNER.password);
    expect(r.data.stage).toBe('mfa');
    expect((await b.call('GET', '/api/clients')).status).toBe(403);
    expect((await b.call('POST', '/api/session/recovery', { code: 'aaaaa-bbbbb' })).status).toBe(400);
    const used = await b.call('POST', '/api/session/recovery', { code: codes[0]!.toUpperCase() });
    expect(used.status).toBe(200);
    expect(used.data.stage).toBe('active');
    expect((await b.call('GET', '/api/account/security')).data.recoveryCodesLeft).toBe(9);

    const again = await signIn(t.app, OWNER.email, OWNER.password);
    expect((await again.b.call('POST', '/api/session/recovery', { code: codes[0] })).status).toBe(400);

    await expireReauth();
    const stale = await owner.call('POST', '/api/account/recovery-codes', {});
    expect(stale.status).toBe(403);
    expect(stale.data.code).toBe('reauth');
    expect((await owner.call('POST', '/api/session/reauth', { password: 'wrong password here' })).status).toBe(400);
    expect((await owner.call('POST', '/api/session/reauth', { password: OWNER.password })).status).toBe(200);
    const replaced = await owner.call('POST', '/api/account/recovery-codes', {});
    expect(replaced.status).toBe(200);
    const old = await signIn(t.app, OWNER.email, OWNER.password);
    expect((await old.b.call('POST', '/api/session/recovery', { code: codes[1] })).status).toBe(400);
  });

  it('remembers a device for the second step, lists sessions, and ends them remotely', async () => {
    const first = await signIn(t.app, OWNER.email, OWNER.password);
    const done = await first.b.call('POST', '/api/session/mfa', { code: await nextCode(secret), remember: true });
    expect(done.data.stage).toBe('active');
    const device = [...first.b.jar].find(([k]) => k === 'atlas_device');
    expect(device).toBeTruthy();

    // Same browser, new sign-in: no code needed.
    const again = await first.b.call('POST', '/api/session', { email: OWNER.email, password: OWNER.password });
    expect(again.data.stage).toBe('active');
    // A device cookie for someone else doesn't help.
    const other = browser(t.app);
    other.jar.set('atlas_device', 'x'.repeat(43));
    expect(
      (await other.call('POST', '/api/session', { email: OWNER.email, password: OWNER.password })).data.stage,
    ).toBe('mfa');

    const security = (await owner.call('GET', '/api/account/security')).data;
    expect(security.devices).toHaveLength(1);
    expect(security.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    const target = security.sessions.find((s: { current: boolean }) => !s.current);
    expect(JSON.stringify(security)).not.toMatch(/tokenHash|token_hash/);

    expect((await owner.call('DELETE', `/api/account/sessions/${target.id}`)).status).toBe(200);
    const remaining = (await owner.call('GET', '/api/account/security')).data.sessions.length;
    expect(remaining).toBe(security.sessions.length - 1);
    const ended = await owner.call('POST', '/api/account/sessions/end-others', {});
    expect(ended.status).toBe(200);
    expect((await owner.call('GET', '/api/account/security')).data.sessions).toHaveLength(1);
    expect((await first.b.call('GET', '/api/session')).status).toBe(401);

    expect((await owner.call('DELETE', `/api/account/devices/${security.devices[0].id}`)).status).toBe(200);
    const after = await first.b.call('POST', '/api/session', { email: OWNER.email, password: OWNER.password });
    expect(after.data.stage).toBe('mfa');
  });

  it('registers passkeys, uses them as the second step or on their own, and counts them as MFA', async () => {
    const key = new SoftAuthenticator();
    const options = await owner.call('POST', '/api/account/passkeys/options', {});
    expect(options.status).toBe(200);
    expect(options.data.rp.id).toBe('localhost');
    // A response for a different challenge is rejected.
    const forged = await owner.call('POST', '/api/account/passkeys', {
      name: 'Forged',
      response: key.register({ challenge: 'not-the-challenge' }),
    });
    expect(forged.status).toBe(400);
    const again = await owner.call('POST', '/api/account/passkeys/options', {});
    const added = await owner.call('POST', '/api/account/passkeys', {
      name: 'YubiKey 5C',
      response: key.register(again.data),
    });
    expect(added.status, JSON.stringify(added.data)).toBe(200);
    expect((await owner.call('GET', '/api/account/security')).data.passkeys[0].name).toBe('YubiKey 5C');

    // Second step after the password.
    const { b } = await signIn(t.app, OWNER.email, OWNER.password);
    const challenge = await b.call('POST', '/api/session/passkey/options', {});
    expect(challenge.data.allowCredentials).toHaveLength(1);
    const wrongOrigin = await b.call('POST', '/api/session/passkey', {
      response: key.assert(challenge.data, { origin: 'https://evil.test' }),
    });
    expect(wrongOrigin.status).toBe(400);
    const retry = await b.call('POST', '/api/session/passkey/options', {});
    const ok = await b.call('POST', '/api/session/passkey', { response: key.assert(retry.data) });
    expect(ok.data.stage).toBe('active');

    // Passwordless needs user verification.
    const anon = browser(t.app);
    const start = await anon.call('POST', '/api/passkey/options', {});
    expect(
      (
        await anon.call('POST', '/api/passkey/sign-in', {
          challengeId: start.data.challengeId,
          response: key.assert(start.data.options, { verified: false }),
        })
      ).status,
    ).toBe(400);
    const start2 = await anon.call('POST', '/api/passkey/options', {});
    const signedIn = await anon.call('POST', '/api/passkey/sign-in', {
      challengeId: start2.data.challengeId,
      response: key.assert(start2.data.options),
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.data.stage).toBe('active');
    // The challenge is single-use.
    expect(
      (
        await anon.call('POST', '/api/passkey/sign-in', {
          challengeId: start2.data.challengeId,
          response: key.assert(start2.data.options),
        })
      ).status,
    ).toBe(400);

    // Removing it needs a recent password confirmation.
    await expireReauth();
    const id = (await owner.call('GET', '/api/account/security')).data.passkeys[0].id;
    expect((await owner.call('DELETE', `/api/account/passkeys/${encodeURIComponent(id)}`)).status).toBe(403);
    await owner.call('POST', '/api/session/reauth', { password: OWNER.password });
    expect((await owner.call('DELETE', `/api/account/passkeys/${encodeURIComponent(id)}`)).status).toBe(200);
  });

  it('a staff member can enroll a passkey instead of an authenticator app', async () => {
    await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tess Tech',
      role: 'technician',
      allClients: 'edit',
      password: TEMP,
    });
    const { b } = await signIn(t.app, 'tech@atlas.test', TEMP);
    const changed = await b.call('POST', '/api/account/password', { current: TEMP, next: 'a better pass 5678' });
    expect(changed.data.stage).toBe('mfa-setup');
    const key = new SoftAuthenticator();
    const options = await b.call('POST', '/api/account/passkeys/options', {});
    const added = await b.call('POST', '/api/account/passkeys', {
      name: 'Laptop',
      response: key.register(options.data),
    });
    expect(added.data.stage).toBe('active');
    expect(added.data.actor.mfa).toBe(true);
    expect(added.data.recoveryCodes).toHaveLength(10);
    const next = await signIn(t.app, 'tech@atlas.test', 'a better pass 5678');
    expect(next.r.data.stage).toBe('mfa');

    // An admin MFA reset removes passkeys too.
    const users = (await owner.call('GET', '/api/users')).data as { id: string; email: string }[];
    const tech = users.find((u) => u.email === 'tech@atlas.test')!;
    await owner.call('POST', `/api/users/${tech.id}/reset`, { password: TEMP, resetMfa: true });
    expect((await t.handle.db.execute(sql`select count(*)::int as n from passkeys`)).rows[0]).toEqual({ n: 0 });
  });

  it('administrators can sign a user out everywhere', async () => {
    await owner.call('POST', '/api/users', {
      email: 'viewer@atlas.test',
      name: 'Vic Viewer',
      role: 'readonly_technician',
      allClients: 'read',
      password: TEMP,
    });
    const { b } = await signIn(t.app, 'viewer@atlas.test', TEMP);
    const id = ((await owner.call('GET', '/api/users')).data as { id: string; email: string }[]).find(
      (u) => u.email === 'viewer@atlas.test',
    )!.id;
    expect((await b.call('POST', `/api/users/${id}/sign-out`, {})).status).toBe(403);
    expect((await owner.call('POST', `/api/users/${id}/sign-out`, {})).status).toBe(200);
    expect((await b.call('GET', '/api/session')).status).toBe(401);
  });
});

describe('email, password reset, and settings', () => {
  let t: TestApp;
  let owner: Browser;
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('stores SMTP settings with the password encrypted and sends a test email', async () => {
    expect((await owner.call('POST', '/api/settings/email/test', { to: 'me@atlas.test' })).status).toBe(409);
    const saved = await owner.call('PUT', '/api/settings/email', M365);
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data).toMatchObject({ enabled: true, host: 'smtp.office365.com', hasPassword: true });
    expect(saved.data.password).toBeUndefined();
    const raw = await t.handle.db.execute(sql`select settings::text as s from orgs`);
    expect((raw.rows[0] as { s: string }).s).not.toContain(M365.password);

    // Saving without a password keeps the stored one.
    const { password: _p, ...rest } = M365;
    expect((await owner.call('PUT', '/api/settings/email', { ...rest, port: 25 })).data.hasPassword).toBe(true);

    expect((await owner.call('POST', '/api/settings/email/test', { to: 'me@atlas.test' })).status).toBe(200);
    expect(t.outbox.at(-1)).toMatchObject({ to: 'me@atlas.test', subject: 'MSP Atlas test email' });
    expect(t.outbox.at(-1)!.from).toBe('"IT Done Right" <atlas@itdonerightnc.test>');

    await owner.call('PUT', '/api/settings/email', { ...rest, host: 'reject.invalid' });
    const rejected = await owner.call('POST', '/api/settings/email/test', { to: 'me@atlas.test' });
    expect(rejected.status).toBe(502);
    expect(rejected.data.error).toContain('550 relay denied');

    const events = (await owner.call('GET', '/api/security-events')).data.map((e: { action: string }) => e.action);
    expect(events).toContain('Email settings changed');
    expect(JSON.stringify(events)).not.toContain(M365.password);
  });

  it('only administrators with a recent password confirmation can change email settings', async () => {
    await owner.call('POST', '/api/users', {
      email: 'tech@atlas.test',
      name: 'Tess Tech',
      role: 'technician',
      allClients: 'edit',
      password: TEMP,
    });
    const { b } = await signIn(t.app, 'tech@atlas.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'a better pass 5678' });
    await enroll(b);
    expect((await b.call('GET', '/api/settings/email')).status).toBe(403);
    expect((await b.call('PUT', '/api/settings/email', M365)).status).toBe(403);
    await t.handle.db.execute(sql`update sessions set reauth_at = null`);
    const stale = await owner.call('PUT', '/api/settings/email', M365);
    expect(stale.data.code).toBe('reauth');
  });

  it('resets a forgotten password by emailed link, once, without skipping MFA', async () => {
    const anon = browser(t.app);
    // Email off: same response, nothing sent.
    expect((await anon.call('POST', '/api/password-reset', { email: OWNER.email })).status).toBe(200);
    expect(t.outbox).toHaveLength(0);
    await owner.call('PUT', '/api/settings/email', M365);
    expect((await anon.call('GET', '/api/setup')).data.passwordReset).toBe(true);

    expect((await anon.call('POST', '/api/password-reset', { email: 'nobody@atlas.test' })).status).toBe(200);
    expect(t.outbox).toHaveLength(0);
    expect((await anon.call('POST', '/api/password-reset', { email: OWNER.email })).status).toBe(200);
    expect(t.outbox).toHaveLength(1);
    const mail = t.outbox[0]!;
    const token = /reset-password#([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    expect(mail.html).toContain(`reset-password#${token}`);

    expect(
      (
        await anon.call('POST', '/api/password-reset/complete', {
          token: 'x'.repeat(43),
          password: 'new pass word 9876',
        })
      ).status,
    ).toBe(400);
    const weak = await anon.call('POST', '/api/password-reset/complete', { token, password: 'short' });
    expect(weak.status).toBe(400);
    const done = await anon.call('POST', '/api/password-reset/complete', { token, password: 'new pass word 9876' });
    expect(done.status, JSON.stringify(done.data)).toBe(200);
    expect(t.outbox.at(-1)!.subject).toContain('was changed');
    expect((await owner.call('GET', '/api/session')).status).toBe(401);
    expect(
      (await anon.call('POST', '/api/password-reset/complete', { token, password: 'another pass 1111' })).status,
    ).toBe(400);
    expect((await signIn(t.app, OWNER.email, OWNER.password)).r.status).toBe(401);
    const next = await signIn(t.app, OWNER.email, 'new pass word 9876');
    expect(next.r.data.stage).toBe('mfa');
  });
});

describe('groups, expirations, and the audit log', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let tech: Browser;
  let techId: string;
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('POST', '/api/clients', { name: 'Northline Architecture' });
    techId = (
      await owner.call('POST', '/api/users', {
        email: 'tech@atlas.test',
        name: 'Tess Tech',
        role: 'technician',
        grants: [{ clientId: harbor, level: 'read' }],
        password: TEMP,
      })
    ).data.id;
    tech = (await signIn(t.app, 'tech@atlas.test', TEMP)).b;
    await tech.call('POST', '/api/account/password', { current: TEMP, next: 'a better pass 5678' });
    await enroll(tech);
  });
  afterEach(async () => {
    await t.close();
  });

  it('grants client access and restricted passwords through groups', async () => {
    const password = await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      name: 'Domain admin',
      secret: 'S3cure!Harbor#2026',
      restricted: true,
    });
    expect(password.status).toBe(201);
    expect((await tech.call('GET', `/api/passwords/${password.data.id}`)).status).toBe(404);

    const group = await owner.call('POST', '/api/groups', {
      name: 'Harbor team',
      memberIds: [techId],
      grants: [{ clientId: harbor, level: 'edit_passwords' }],
    });
    expect(group.status, JSON.stringify(group.data)).toBe(201);
    expect((await owner.call('POST', '/api/groups', { name: 'harbor TEAM' })).status).toBe(409);
    const clients = (await tech.call('GET', '/api/clients')).data;
    expect(clients.find((c: { id: string }) => c.id === harbor).access).toBe('edit_passwords');
    // Still restricted: listed people or groups only.
    expect((await tech.call('GET', `/api/passwords/${password.data.id}`)).status).toBe(404);
    const access = await owner.call('PUT', `/api/passwords/${password.data.id}/access`, {
      userIds: [],
      groupIds: [group.data.id],
    });
    expect(access.data).toEqual({ userIds: [], groupIds: [group.data.id] });
    expect((await tech.call('GET', `/api/passwords/${password.data.id}`)).status).toBe(200);

    // Client accounts can't join groups; technicians can't manage them.
    const viewer = await owner.call('POST', '/api/users', {
      email: 'v@harbor.test',
      name: 'V',
      role: 'client_viewer',
      grants: [{ clientId: harbor, level: 'read' }],
      password: TEMP,
    });
    expect(
      (await owner.call('PUT', `/api/groups/${group.data.id}`, { name: 'Harbor team', memberIds: [viewer.data.id] }))
        .status,
    ).toBe(400);
    expect((await tech.call('GET', '/api/groups')).status).toBe(403);

    expect((await owner.call('DELETE', `/api/groups/${group.data.id}`)).status).toBe(200);
    expect((await tech.call('GET', `/api/passwords/${password.data.id}`)).status).toBe(404);
  });

  it('lists upcoming expirations the viewer can see and emails alerts once', async () => {
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const ssl = layouts.find((l) => l.key === 'ssl_certificate')!.id;
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: ssl,
      name: 'portal.harbordental.test',
      fields: { common_name: 'portal.harbordental.test', expires: inDays(14) },
    });
    await owner.call('POST', `/api/clients/${harbor}/assets`, {
      layoutId: ssl,
      name: 'far-future',
      fields: { common_name: 'far', expires: inDays(400) },
    });
    const list = (await owner.call('GET', '/api/expirations')).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'asset', title: 'portal.harbordental.test', daysLeft: 14 });
    expect((await tech.call('GET', '/api/expirations')).data).toHaveLength(1);

    await owner.call('PUT', '/api/settings/email', M365);
    const keys = staticKeyProvider([randomBytes(32)]);
    const settings = new SettingsService(t.handle.db, keys);
    // The notifier reads settings through its own key provider, so store SMTP again with that key.
    await settings.saveSmtp((await t.handle.db.execute(sql`select id from orgs`)).rows[0]!.id as string, M365);
    const sent: string[] = [];
    const mail = new MailService(settings, async (_smtp, message) => {
      sent.push(`${message.to}|${message.subject}`);
    });
    const vault = new VaultService(new VaultKeys(t.handle.db, keys));
    const notifier = new Notifier(t.handle.db, {
      mail,
      settings,
      expirations: new ExpirationService(vault),
      audit: new AuditService(t.handle.db, keys, settings),
      publicOrigin: 'http://localhost',
      sendHour: 0,
    });
    const tuesday = new Date('2026-09-22T12:00:00');
    await notifier.tick(tuesday);
    await notifier.tick(tuesday);
    expect(sent.filter((s) => s.startsWith(OWNER.email))).toEqual([`${OWNER.email}|Expiring soon: 1 item`]);
    await notifier.tick(new Date('2026-09-28T12:00:00')); // Monday: weekly digest
    expect(sent.some((s) => s === `${OWNER.email}|Weekly expirations digest: 1 item`)).toBe(true);
  });

  it('chains security events so edits and deletions are detected', async () => {
    const ok = await owner.call('POST', '/api/audit/verify', {});
    expect(ok.data).toMatchObject({ ok: true, brokenAt: null, checkpoint: 'missing' });
    expect(ok.data.checked).toBeGreaterThan(3);
    expect((await owner.call('POST', '/api/audit/verify', {})).data.checkpoint).toBe('ok');
    expect((await tech.call('POST', '/api/audit/verify', {})).status).toBe(403);

    // Rows can't be edited through normal SQL.
    await expect(t.handle.db.execute(sql`update security_events set detail = 'edited'`)).rejects.toThrow();

    // Someone with full database access disables the guard and edits a row.
    const target = (await t.handle.db.execute(sql`select id from security_events order by id limit 1 offset 1`))
      .rows[0] as { id: string };
    await t.handle.db.execute(sql`alter table security_events disable trigger security_events_immutable`);
    await t.handle.db.execute(sql`update security_events set detail = 'edited' where id = ${target.id}`);
    const broken = await owner.call('POST', '/api/audit/verify', {});
    expect(broken.data).toMatchObject({ ok: false, brokenAt: String(target.id) });
    await t.handle.db.execute(sql`alter table security_events enable trigger security_events_immutable`);

    const csv = await owner.call('GET', '/api/audit/export/security');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    // Spreadsheet formulas in cells are neutralised.
    expect(toCsv(['a', 'b'], [['=HYPERLINK("http://x")', 'plain']])).toBe(
      'a,b\r\n"\'=HYPERLINK(""http://x"")",plain\r\n',
    );
  });

  it('keeps the chain intact when many events are written at once', async () => {
    const orgId = (await t.handle.db.execute(sql`select id from orgs`)).rows[0]!.id as string;
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        t.handle.db.transaction(async (tx) => {
          await tx.execute(
            sql`insert into security_events (org_id, actor, action, detail) values (${orgId}, 'Load test', 'Concurrent', ${String(i)})`,
          );
          // Hold the transaction open briefly so inserts overlap.
          await tx.execute(sql`select pg_sleep(${(i % 5) / 200})`);
        }),
      ),
    );
    const result = await owner.call('POST', '/api/audit/verify', {});
    expect(result.data).toMatchObject({ ok: true, brokenAt: null });
    expect(result.data.checked).toBeGreaterThan(30);
  });

  it('detects rows deleted from the end of the log with the signed checkpoint', async () => {
    await owner.call('POST', '/api/audit/verify', {});
    await t.handle.db.execute(sql`delete from security_events where id = (select max(id) from security_events)`);
    const result = await owner.call('POST', '/api/audit/verify', {});
    expect(result.data).toMatchObject({ ok: false, checkpoint: 'mismatch' });
  });
});

describe('mail rendering', () => {
  it('escapes HTML in messages', async () => {
    const { render } = await import('../src/services/mail.js');
    const { html, text } = render({ to: 'a@b.c', subject: 's', paragraphs: ['<script>x</script>'] }, 'Org & Co');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Org &amp; Co');
    expect(text).toContain('<script>x</script>');
  });
});
