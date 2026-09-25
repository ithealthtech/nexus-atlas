import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { staticKeyProvider } from '../src/crypto/keys.js';
import { GraphMailer } from '../src/services/mail-graph.js';
import { SettingsService, type SmtpConfig } from '../src/services/settings.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'app~secret~value~9981';

const CONFIG = {
  enabled: true,
  method: 'graph',
  tenantId: TENANT,
  clientId: CLIENT,
  clientSecret: SECRET,
  fromAddress: 'atlas@itdonerightnc.test',
  fromName: 'IT Done Right',
} as SmtpConfig;
const MESSAGE = { from: '', to: 'me@atlas.test', subject: 'Hello', text: 'Hi', html: '<p>Hi</p>' };

function fakeMicrosoft(opts: { token?: Response; send?: () => Response } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('https://login.microsoftonline.com/'))
      return opts.token?.clone() ?? Response.json({ access_token: 'token-1', expires_in: 3599 });
    return opts.send?.() ?? new Response(null, { status: 202 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe('GraphMailer', () => {
  it('signs in with client credentials and sends as the From mailbox', async () => {
    const ms = fakeMicrosoft();
    await new GraphMailer(ms.fetcher).send(CONFIG, MESSAGE);
    const [token, send] = ms.calls;
    expect(token!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(Object.fromEntries(new URLSearchParams(String(token!.init.body)))).toEqual({
      grant_type: 'client_credentials',
      client_id: CLIENT,
      client_secret: SECRET,
      scope: 'https://graph.microsoft.com/.default',
    });
    expect(send!.url).toBe('https://graph.microsoft.com/v1.0/users/atlas%40itdonerightnc.test/sendMail');
    expect((send!.init.headers as Record<string, string>).authorization).toBe('Bearer token-1');
    expect(JSON.parse(String(send!.init.body))).toEqual({
      message: {
        subject: 'Hello',
        body: { contentType: 'HTML', content: '<p>Hi</p>' },
        from: { emailAddress: { address: 'atlas@itdonerightnc.test', name: 'IT Done Right' } },
        toRecipients: [{ emailAddress: { address: 'me@atlas.test' } }],
      },
      saveToSentItems: false,
    });
  });

  it('reuses a token until shortly before it expires', async () => {
    const ms = fakeMicrosoft();
    let now = 0;
    const mailer = new GraphMailer(ms.fetcher, () => now);
    await mailer.send(CONFIG, MESSAGE);
    now = 3_000_000; // 50 minutes later: still valid
    await mailer.send(CONFIG, MESSAGE);
    now = 3_550_000; // under a minute left: fetch a new one
    await mailer.send(CONFIG, MESSAGE);
    expect(ms.calls.filter((c) => c.url.includes('login.microsoftonline.com'))).toHaveLength(2);
  });

  it('signs in again as soon as the client secret changes', async () => {
    const ms = fakeMicrosoft();
    const mailer = new GraphMailer(ms.fetcher);
    await mailer.send(CONFIG, MESSAGE);
    await mailer.send({ ...CONFIG, clientSecret: 'replacement~secret' }, MESSAGE);
    const tokens = ms.calls.filter((c) => c.url.includes('login.microsoftonline.com'));
    expect(tokens.map((c) => new URLSearchParams(String(c.init.body)).get('client_secret'))).toEqual([
      SECRET,
      'replacement~secret',
    ]);
  });

  it('explains sign-in and permission failures', async () => {
    const badSecret = fakeMicrosoft({
      token: Response.json(
        { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x' },
        { status: 401 },
      ),
    });
    await expect(new GraphMailer(badSecret.fetcher).send(CONFIG, MESSAGE)).rejects.toThrow(
      /^Sign-in to Microsoft failed: AADSTS7000215: Invalid client secret provided\.$/,
    );
    const noPermission = fakeMicrosoft({
      send: () =>
        Response.json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, { status: 403 }),
    });
    await expect(new GraphMailer(noPermission.fetcher).send(CONFIG, MESSAGE)).rejects.toThrow(
      /ErrorAccessDenied: Access is denied\. Check the app has the Mail\.Send application permission/,
    );
  });

  it('forgets a token Graph rejects', async () => {
    let status = 401;
    const ms = fakeMicrosoft({ send: () => new Response('{}', { status }) });
    const mailer = new GraphMailer(ms.fetcher);
    await expect(mailer.send(CONFIG, MESSAGE)).rejects.toThrow();
    status = 202;
    await mailer.send(CONFIG, MESSAGE);
    expect(ms.calls.filter((c) => c.url.includes('login.microsoftonline.com'))).toHaveLength(2);
  });
});

describe('Microsoft 365 email settings', () => {
  let t: TestApp;
  let owner: Browser;
  const GRAPH = {
    enabled: true,
    method: 'graph',
    tenantId: TENANT,
    clientId: CLIENT,
    fromAddress: 'atlas@itdonerightnc.test',
    fromName: 'IT Done Right',
  };
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('needs the tenant, client ID, and a secret; stores the secret encrypted; sends with it', async () => {
    const missing = await owner.call('PUT', '/api/settings/email', { ...GRAPH, tenantId: '', clientId: 'nope' });
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.data.fields)).toEqual(expect.arrayContaining(['clientId']));

    const noSecret = await owner.call('PUT', '/api/settings/email', GRAPH);
    expect(noSecret.status).toBe(400);
    expect(noSecret.data.fields.clientSecret).toMatch(/client secret/);

    const saved = await owner.call('PUT', '/api/settings/email', { ...GRAPH, clientSecret: SECRET });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data).toMatchObject({ method: 'graph', tenantId: TENANT, clientId: CLIENT, hasClientSecret: true });
    expect(JSON.stringify(saved.data)).not.toContain(SECRET);
    const raw = await t.handle.db.execute(sql`select settings::text as s from orgs`);
    expect((raw.rows[0] as { s: string }).s).not.toContain(SECRET);

    // Saving without the secret keeps it.
    expect((await owner.call('PUT', '/api/settings/email', GRAPH)).data.hasClientSecret).toBe(true);

    expect((await owner.call('POST', '/api/settings/email/test', { to: 'me@atlas.test' })).status).toBe(200);
    expect(t.outbox.at(-1)).toMatchObject({ to: 'me@atlas.test', subject: 'MSP Atlas test email' });

    const events = (await owner.call('GET', '/api/security-events')).data as { action: string; detail: string }[];
    expect(events.find((e) => e.action === 'Email settings changed')!.detail).toContain('Microsoft 365 (Graph)');
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('warns while email still uses Microsoft 365 SMTP sign-in', async () => {
    await owner.call('PUT', '/api/settings/email', {
      enabled: true,
      method: 'smtp',
      preset: 'm365',
      host: 'smtp.office365.com',
      username: 'atlas@itdonerightnc.test',
      password: 'x',
      fromAddress: 'atlas@itdonerightnc.test',
    });
    const checks = (await owner.call('GET', '/api/status')).data.checks as { id: string; title: string }[];
    expect(checks.find((c) => c.id === 'email')?.title).toBe('Email uses Microsoft 365 SMTP sign-in');
  });

  it('re-wraps the client secret, SMTP password, and Hudu key when the master key rotates', async () => {
    // The app's master key isn't exposed to tests, so check the mechanism with its own keys.
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const orgId = (await t.handle.pool.query('select id from orgs')).rows[0].id as string;
    const before = new SettingsService(t.handle.db, staticKeyProvider([oldKey]));
    await before.saveSmtp(orgId, { ...GRAPH, clientSecret: SECRET, password: 'smtp-password-1' });
    await before.saveHudu(orgId, { url: 'https://itdr.huducloud.test', apiKey: 'hudu-key-1234567890' });

    expect(await new SettingsService(t.handle.db, staticKeyProvider([newKey, oldKey])).rewrapSecrets()).toBe(3);

    // Only the new key is needed now.
    const after = new SettingsService(t.handle.db, staticKeyProvider([newKey]));
    expect(await after.smtpConfig(orgId)).toMatchObject({ clientSecret: SECRET, password: 'smtp-password-1' });
    expect((await after.hudu(orgId))?.apiKey).toBe('hudu-key-1234567890');
    await expect(new SettingsService(t.handle.db, staticKeyProvider([oldKey])).smtpConfig(orgId)).rejects.toThrow();
  });
});
