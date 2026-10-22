import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DEFAULT_BRANDING } from '@atlas/shared';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const png = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes, 7).toString('base64')}`;

describe('theme', () => {
  let t: TestApp;
  let owner: Browser;
  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
  });
  afterEach(async () => {
    await t.close();
  });

  it('saves the whole theme and serves it publicly for the sign-in page', async () => {
    const theme = {
      ...DEFAULT_BRANDING,
      brandName: 'IT Done Right',
      tagline: 'Managed IT',
      browserTitle: 'IT Done Right Docs',
      accent: '#1d4ed8',
      accentDark: '#93c5fd',
      sidebar: '#f1f5f9',
      loginHeadline: 'Welcome back',
      loginText: 'Sign in to your documentation.',
      logo: png(1000),
      logoDark: png(1000),
      favicon: 'data:image/svg+xml;base64,PHN2Zy8+',
      // Close to the 400 KB limit; with the logos the request needs the route's larger body limit.
      loginBackground: png(390 * 1024),
      fontScale: 'large',
      radius: 'round',
      sidebarWidth: 'wide',
      density: 'compact',
      navStyle: 'bar',
      motion: false,
    };
    const saved = await owner.call('PUT', '/api/branding', theme);
    expect(saved.status, JSON.stringify(saved.data).slice(0, 300)).toBe(200);

    const pub = await t.app.inject({ method: 'GET', url: '/api/branding' });
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({
      brandName: 'IT Done Right',
      density: 'compact',
      navStyle: 'bar',
      motion: false,
    });

    const events = (await owner.call('GET', '/api/security-events')).data as { action: string; detail: string }[];
    expect(events.find((e) => e.action === 'Theme changed')?.detail).toContain('IT Done Right');
  });

  it('rejects bad values and oversized images', async () => {
    const bad = async (body: object) =>
      (await owner.call('PUT', '/api/branding', { ...DEFAULT_BRANDING, ...body })).status;
    expect(await bad({ accent: 'blue' })).toBe(400);
    expect(await bad({ density: 'tiny' })).toBe(400);
    expect(await bad({ logo: png(200 * 1024) })).toBe(400);
    expect(await bad({ favicon: 'data:text/html;base64,PGgxPg==' })).toBe(400);
    expect(await bad({ loginBackground: 'data:image/svg+xml;base64,PHN2Zy8+' })).toBe(400);
  });

  it('loads settings saved before the theme manager, with defaults for the rest', async () => {
    await t.handle.db.execute(
      sql`update orgs set settings = settings || '{"branding":{"accent":"#205843","logo":null,"portalWelcome":"Hi"}}'::jsonb`,
    );
    const pub = (await t.app.inject({ method: 'GET', url: '/api/branding' })).json();
    expect(pub).toMatchObject({ ...DEFAULT_BRANDING, accent: '#205843', portalWelcome: 'Hi' });
  });

  it('serves the icon Atlas for Windows uses, and says when it has not changed', async () => {
    const icon = (headers: Record<string, string> = {}) =>
      t.app.inject({ method: 'GET', url: '/api/v1/branding/app-icon', headers });
    // No favicon, or only an SVG one with no PNG made from it: nothing Windows can draw.
    expect((await icon()).statusCode).toBe(404);
    const save = (body: object) => owner.call('PUT', '/api/branding', { ...DEFAULT_BRANDING, ...body });
    await save({ favicon: 'data:image/svg+xml;base64,PHN2Zy8+' });
    expect((await icon()).statusCode).toBe(404);

    // The PNG made from the favicon wins over the favicon itself.
    await save({ favicon: 'data:image/svg+xml;base64,PHN2Zy8+', appIcon: png(500) });
    const first = await icon();
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/png');
    expect(first.rawPayload).toEqual(Buffer.alloc(500, 7));
    const etag = String(first.headers.etag);
    expect((await icon({ 'if-none-match': etag })).statusCode).toBe(304);

    // A PNG or ICO favicon is used as it is; a new picture is a new ETag.
    await save({ favicon: 'data:image/x-icon;base64,AAABAAEA', appIcon: null });
    const ico = await icon({ 'if-none-match': etag });
    expect(ico.statusCode).toBe(200);
    expect(ico.headers['content-type']).toBe('image/x-icon');
    expect(ico.headers.etag).not.toBe(etag);

    // Only PNG for the made icon.
    expect((await save({ appIcon: 'data:image/svg+xml;base64,PHN2Zy8+' })).status).toBe(400);
  });

  it('only lets administrators change it', async () => {
    const anon = await t.app.inject({ method: 'PUT', url: '/api/branding', payload: DEFAULT_BRANDING });
    expect(anon.statusCode).toBe(401);
  });
});
