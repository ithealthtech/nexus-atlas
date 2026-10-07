import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventName, signWebhook, type WebhookService } from '../src/services/webhooks.js';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const URL_OK = 'https://hooks.example.test/atlas';

describe('webhook events', () => {
  it('names an event after the kind of item and what happened to it', () => {
    expect(eventName('asset', 'Created')).toBe('asset.created');
    expect(eventName('asset', 'Synced from ConnectWise RMM')).toBe('asset.updated');
    expect(eventName('asset', 'Archived')).toBe('asset.archived');
    expect(eventName('document', 'Attached a file to')).toBe('document.file_added');
    expect(eventName('password', 'Added a password')).toBe('password.created');
    expect(eventName('password', 'Changed password (automatic rotation)')).toBe('password.rotated');
    expect(eventName('password', 'Changed the password for')).toBe('password.rotated');
    expect(eventName('checklist_run', 'Completed')).toBe('checklist.completed');
    expect(eventName('client_notes', 'Updated quick notes of')).toBe('client.updated');
    // Kinds webhooks don't carry.
    expect(eventName('security', 'API key created')).toBeNull();
  });

  it('signs the timestamp and the body together', () => {
    const expected = createHmac('sha256', 's3cret').update('1700000000.{"a":1}').digest('hex');
    expect(signWebhook('s3cret', '1700000000', '{"a":1}')).toBe(`sha256=${expected}`);
  });
});

describe('webhooks', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let received: { url: string; headers: Record<string, string>; body: string }[];
  let answer: number | 'down';
  const deliver = (at?: Date) => (t.app as unknown as { webhooks: WebhookService }).webhooks.tick(at);

  beforeEach(async () => {
    received = [];
    answer = 200;
    const webhookFetch = (async (input: string | URL, init?: RequestInit) => {
      if (answer === 'down') throw new TypeError('fetch failed');
      received.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: String(init?.body),
      });
      return new Response('', { status: answer });
    }) as typeof fetch;
    t = await startApp({}, { webhookFetch });
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const layoutId = async () =>
    ((await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[]).find(
      (l) => l.key === 'configuration',
    )!.id;
  const addAsset = async (name: string) =>
    (await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId: await layoutId(), name })).data;

  it('posts a signed message for the kinds of item chosen, without the item’s contents', async () => {
    const made = await owner.call('POST', '/api/webhooks', {
      name: 'Automation',
      url: URL_OK,
      topics: ['asset', 'password'],
    });
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const secret = made.data.secret as string;
    expect(secret.length).toBeGreaterThan(30);
    // The secret is shown once, and stored sealed.
    expect(JSON.stringify((await owner.call('GET', '/api/webhooks')).data)).not.toContain(secret);
    expect(JSON.stringify((await t.handle.pool.query('select * from webhooks')).rows)).not.toContain(secret);

    const asset = await addAsset('HDG-FW-01');
    await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      name: 'Firewall admin',
      username: 'admin',
      secret: 'correct horse battery staple 9',
    });
    // Not a chosen kind: nothing is queued for it.
    await owner.call('POST', `/api/clients/${harbor}/contacts`, { name: 'Dana Whitfield' });
    expect(await deliver()).toBe(2);

    expect(received).toHaveLength(2);
    const [first, second] = received;
    expect(first!.url).toBe(URL_OK);
    const message = JSON.parse(first!.body);
    expect(message).toMatchObject({
      event: 'asset.created',
      actor: { name: 'Avery Owner' },
      client: { id: harbor, name: 'Harbor Dental Group' },
      item: { type: 'asset', id: asset.id, title: 'HDG-FW-01', url: `http://localhost/assets/${asset.id}` },
    });
    expect(first!.headers['x-atlas-event']).toBe('asset.created');
    expect(first!.headers['x-atlas-delivery']).toBe(message.id);
    expect(first!.headers['x-atlas-signature']).toBe(
      signWebhook(secret, first!.headers['x-atlas-timestamp']!, first!.body),
    );
    // A password event names the entry and nothing more.
    expect(JSON.parse(second!.body)).toMatchObject({ event: 'password.created', item: { title: 'Firewall admin' } });
    expect(second!.body).not.toContain('correct horse');
    expect(second!.body).not.toContain('"admin"');

    const log = (await owner.call('GET', `/api/webhooks/${made.data.id}/deliveries`)).data;
    expect(log.map((d: { event: string; status: string }) => [d.event, d.status]).sort()).toEqual([
      ['asset.created', 'delivered'],
      ['password.created', 'delivered'],
    ]);
    // Nothing is sent twice.
    expect(await deliver()).toBe(0);
  });

  it('retries a failed delivery with the same ID, then gives up, and pauses a webhook that keeps failing', async () => {
    const { id } = (await owner.call('POST', '/api/webhooks', { name: 'Flaky', url: URL_OK, topics: ['asset'] })).data;
    answer = 500;
    await addAsset('HDG-SW-01');
    expect(await deliver()).toBe(1);
    let [delivery] = (await owner.call('GET', `/api/webhooks/${id}/deliveries`)).data;
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 500 });
    // Not due yet: the first retry waits a minute.
    expect(await deliver()).toBe(0);
    answer = 200;
    expect(await deliver(new Date(Date.now() + 61_000))).toBe(1);
    [delivery] = (await owner.call('GET', `/api/webhooks/${id}/deliveries`)).data;
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(new Set(received.map((r) => r.headers['x-atlas-delivery'])).size).toBe(1);

    // Unreachable for good: each delivery is tried six times over about eight and a half hours, then dropped.
    answer = 'down';
    await addAsset('HDG-SW-02');
    for (let i = 0; i < 6; i++) await deliver(new Date(Date.now() + (i + 1) * 7 * 3600_000));
    [delivery] = (await owner.call('GET', `/api/webhooks/${id}/deliveries`)).data;
    expect(delivery).toMatchObject({ status: 'failed', attempts: 6, error: 'The receiver could not be reached.' });

    // Ten given up on in a row pauses it; while paused nothing new is queued, and resuming starts it again.
    await t.handle.pool.query('update webhooks set failures = 9 where id = $1', [id]);
    await addAsset('HDG-SW-03');
    for (let i = 0; i < 6; i++) await deliver(new Date(Date.now() + (i + 1) * 7 * 3600_000));
    expect((await owner.call('GET', '/api/webhooks')).data[0]).toMatchObject({ paused: true });
    await owner.call('POST', `/api/webhooks/${id}/resume`, {});
    answer = 200;
    await addAsset('HDG-SW-04');
    expect(await deliver()).toBe(1);
    expect((await owner.call('GET', '/api/webhooks')).data[0]).toMatchObject({ paused: false });
  });

  it('tests on request, replaces its secret, and is for administrators with an https address only', async () => {
    for (const url of ['http://hooks.example.test/x', 'https://user:pw@hooks.example.test/x', 'not a url'])
      expect((await owner.call('POST', '/api/webhooks', { name: 'Bad', url, topics: ['asset'] })).status).toBe(400);
    expect((await owner.call('POST', '/api/webhooks', { name: 'None', url: URL_OK, topics: [] })).status).toBe(400);

    const made = (await owner.call('POST', '/api/webhooks', { name: 'Chat', url: URL_OK, topics: ['checklist'] })).data;
    expect((await owner.call('POST', `/api/webhooks/${made.id}/test`, {})).data).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(JSON.parse(received[0]!.body)).toMatchObject({ event: 'ping', item: { title: 'Chat' } });
    // A redirect is a failure, not something to follow.
    answer = 302;
    const redirected = (await owner.call('POST', `/api/webhooks/${made.id}/test`, {})).data;
    expect(redirected.ok).toBe(false);
    expect(redirected.detail).toMatch(/redirect/);

    answer = 200;
    const replaced = (await owner.call('POST', `/api/webhooks/${made.id}/secret`, {})).data;
    expect(replaced.secret).not.toBe(made.secret);
    received = [];
    await owner.call('POST', `/api/webhooks/${made.id}/test`, {});
    expect(received[0]!.headers['x-atlas-signature']).toBe(
      signWebhook(replaced.secret, received[0]!.headers['x-atlas-timestamp']!, received[0]!.body),
    );

    // Switched off: nothing is queued.
    await owner.call('PATCH', `/api/webhooks/${made.id}`, { enabled: false, topics: ['asset'] });
    await addAsset('HDG-AP-01');
    expect(await deliver()).toBe(0);

    await owner.call('POST', '/api/users', {
      email: 'casey@atlas.test',
      name: 'Casey',
      password: 'temporary pass 1234',
      role: 'technician',
      allClients: 'edit',
    });
    const { b: tech } = await signIn(t.app, 'casey@atlas.test', 'temporary pass 1234');
    await tech.call('POST', '/api/account/password', { current: 'temporary pass 1234', next: 'cobalt fresh pass 12' });
    await enroll(tech);
    expect((await tech.call('GET', '/api/webhooks')).status).toBe(403);
    expect((await tech.call('POST', '/api/webhooks', { name: 'x', url: URL_OK, topics: ['asset'] })).status).toBe(403);
    expect((await owner.call('DELETE', `/api/webhooks/${made.id}`)).status).toBe(200);
    expect((await owner.call('GET', '/api/webhooks')).data).toHaveLength(0);
  });
});
