import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

describe('request hardening', () => {
  let t: TestApp;
  let owner: Browser;
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('sends security headers on pages and API responses', async () => {
    for (const url of ['/', '/api/setup']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
      expect(String(res.headers['content-security-policy'])).toContain("script-src 'self'");
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/setup' })).headers['cache-control']).toBe('no-store');
  });

  it('refuses other hosts, other origins, and cross-site requests', async () => {
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/setup', headers: { host: 'evil.example' } })).statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/setup', headers: { origin: 'https://evil.example' } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/setup', headers: { 'sec-fetch-site': 'cross-site' } }))
        .statusCode,
    ).toBe(403);
    // A state-changing request without the session's CSRF token is refused even with a valid cookie.
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: owner.cookie },
      payload: { name: 'Forged' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps API keys inside their allowed paths, whatever the URL encoding', async () => {
    const key = (await owner.call('POST', '/api/api-keys', { name: 'Probe', scopes: ['read', 'write'] })).data.token;
    const get = (url: string) => t.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } });
    expect((await get('/api/v1/clients')).statusCode).toBe(200);
    for (const url of [
      '/api/v1/clients/../users',
      '/api/v1/clients/%2e%2e/users',
      '/api/v1/clients/..%2fusers',
      '/api/v1//users',
      '/api/v1/clients/../security-events',
      '/api/v1/clients/../api-keys',
      '/api/v1/clients/../backups',
      '/api/v1/clients/../status',
    ]) {
      const res = await get(url);
      expect([401, 403, 404], `${url} → ${res.statusCode}`).toContain(res.statusCode);
    }
  });

  it('exports clients whose names use any script', async () => {
    const id = (await owner.call('POST', '/api/clients', { name: '東京 Dental "Main"' })).data.id;
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/clients/${id}/export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    const disposition = String(res.headers['content-disposition']);
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    expect(decodeURIComponent(disposition.split("UTF-8''")[1]!)).toContain('東京');
  });
});
