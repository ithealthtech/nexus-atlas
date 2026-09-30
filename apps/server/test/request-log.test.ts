import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPrivatePath, redactBody, redactHeaders, redactUrl, serviceOf } from '../src/services/request-log.js';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

describe('request log redaction', () => {
  it('removes secrets from bodies, headers, and URLs', () => {
    const body = JSON.parse(
      redactBody(
        JSON.stringify({
          client_id: 'abc',
          client_secret: 's3cret',
          nested: { access_token: 'tok', name: 'Server 1' },
          fields: [
            { label: 'Admin password', value: 'hunter2' },
            { label: 'Serial', value: 'XYZ' },
          ],
          note: 'Bearer abc.def.ghi',
        }),
        'application/json',
      ),
    );
    expect(body.client_id).toBe('abc');
    expect(body.client_secret).toBe('[redacted]');
    expect(body.nested).toEqual({ access_token: '[redacted]', name: 'Server 1' });
    expect(body.fields).toEqual([
      { label: 'Admin password', value: '[redacted]' },
      { label: 'Serial', value: 'XYZ' },
    ]);
    expect(body.note).toBe('Bearer [redacted]');
    expect(redactBody('grant_type=client_credentials&client_secret=abc', '')).toBe(
      'grant_type=client_credentials&client_secret=[redacted]',
    );
    expect(redactHeaders({ Authorization: 'Bearer x', 'x-api-key': 'k', Accept: 'application/json' })).toEqual({
      authorization: '[redacted]',
      'x-api-key': '[redacted]',
      accept: 'application/json',
    });
    expect(redactUrl('https://user:pw@hudu.example.com/api?api_key=abc&page=2')).toBe(
      'https://[redacted]:[redacted]@hudu.example.com/api?api_key=[redacted]&page=2',
    );
    expect(serviceOf('https://openapi.service.itsupport247.net/v1/token')).toBe('ConnectWise');
    expect(serviceOf('https://graph.microsoft.com/v1.0/users')).toBe('Microsoft');
    expect(isPrivatePath('/api/clients/abc/passwords')).toBe(true);
    expect(isPrivatePath('/api/passwords/abc/reveal')).toBe(true);
    expect(isPrivatePath('/api/rotation/agent/result')).toBe(true);
    expect(isPrivatePath('/api/clients/abc')).toBe(false);
  });
});

describe('verbose request log', () => {
  let t: TestApp;
  let b: Browser;
  beforeEach(async () => {
    const updateFetch = (async () =>
      new Response(JSON.stringify([{ tag_name: 'v99.0.0', draft: false, prerelease: false, token: 'gh-secret' }]), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    t = await startApp({}, { updateFetch });
    ({ b } = await setupOwner(t.app));
  });
  afterEach(() => t.close());

  it('records nothing until turned on', async () => {
    await b.call('POST', '/api/updates/check', {});
    const r = await b.call('GET', '/api/request-log');
    expect(r.status).toBe(200);
    expect(r.data.settings.enabled).toBe(false);
    expect(r.data.entries).toEqual([]);
  });

  it('records outbound calls and incoming requests with secrets redacted, and filters them', async () => {
    const saved = await b.call('PUT', '/api/request-log/settings', { enabled: true, retentionDays: 3 });
    expect(saved.data).toEqual({ enabled: true, incoming: true, retentionDays: 3 });
    await b.call('POST', '/api/updates/check', {});
    await b.call('POST', '/api/session/reauth', { password: 'not the password' });

    const all = await b.call('GET', '/api/request-log');
    expect(all.data.services).toEqual(expect.arrayContaining(['Atlas', 'GitHub']));
    const out = all.data.entries.find((e: { direction: string }) => e.direction === 'outbound');
    expect(out).toMatchObject({ service: 'GitHub', method: 'GET', status: 200 });
    const detail = await b.call('GET', `/api/request-log/${out.id}`);
    expect(detail.data.responseBody).toContain('v99.0.0');
    expect(detail.data.responseBody).not.toContain('gh-secret');

    const reauth = all.data.entries.find((e: { url: string }) => e.url === '/api/session/reauth');
    expect(reauth.actor).toBeTruthy();
    const hidden = await b.call('GET', `/api/request-log/${reauth.id}`);
    expect(hidden.data.requestBody).toMatch(/not recorded/);
    expect(hidden.data.requestHeaders.cookie).toBe('[redacted]');
    expect(JSON.stringify(hidden.data)).not.toContain('not the password');
    // The log page doesn't log itself.
    expect(all.data.entries.some((e: { url: string }) => e.url.startsWith('/api/request-log'))).toBe(false);

    const outbound = await b.call('GET', '/api/request-log?direction=outbound');
    expect(outbound.data.entries.every((e: { direction: string }) => e.direction === 'outbound')).toBe(true);
    const errors = await b.call('GET', '/api/request-log?outcome=error');
    expect(errors.data.entries.map((e: { url: string }) => e.url)).toContain('/api/session/reauth');
    const search = await b.call('GET', '/api/request-log?q=updates/check');
    expect(search.data.entries.length).toBeGreaterThan(0);

    await b.call('DELETE', '/api/request-log');
    await b.call('PUT', '/api/request-log/settings', { enabled: false });
    expect((await b.call('GET', '/api/request-log')).data.entries).toEqual([]);
  });
});
