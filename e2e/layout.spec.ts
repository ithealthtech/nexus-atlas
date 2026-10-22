import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { setupOwner, startApp } from '../apps/server/test/helpers';

// Every main page fits a phone: nothing pushes the page sideways, and a drawer opens from the edge.
test('main pages fit a phone without scrolling sideways', async ({ browser }) => {
  test.setTimeout(120_000);
  const base = 'http://localhost:4433';
  const t = await startApp({ PUBLIC_URL: base, WEB_DIST: resolve('apps/web/dist') });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  try {
    await t.app.listen({ host: 'localhost', port: 4433 });
    const owner = (await setupOwner(t.app)).b;
    const client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group', type: 'Customer' })).data;
    await owner.call('POST', `/api/clients/${client.id}/contacts`, {
      name: 'Robin Hale',
      email: 'robin@harbor.example',
    });
    await owner.call('POST', '/api/groups', {
      name: 'Tier 1 helpdesk',
      description: 'Read access to every client for first-line support.',
      memberIds: [],
      grants: [{ clientId: client.id, level: 'read' }],
    });
    await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: base })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    for (const path of [
      '/',
      '/clients',
      `/clients/${client.id}`,
      `/clients/${client.id}/contacts`,
      '/assets',
      '/passwords',
      '/password-health',
      '/checklists',
      '/admin/users',
      '/admin/groups',
      '/admin/security',
      '/admin/duplicates',
      '/admin/webhooks',
    ]) {
      await page.goto(`${base}${path}`);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForTimeout(600);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), path).toBeLessThanOrEqual(0);
    }
    // A record's form is a drawer: the whole screen on a phone, closed by Escape.
    await page.goto(`${base}/clients`);
    await page.getByRole('button', { name: 'Add client', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Add a client' });
    await expect(drawer).toBeVisible();
    expect((await drawer.boundingBox())?.width).toBe(390);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    // The menu slides in from the left and leaves a strip of the page to tap back to.
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const menu = page.getByRole('dialog', { name: 'Navigation' });
    await expect(menu).toBeVisible();
    // Once it has finished sliding in.
    await expect.poll(async () => (await menu.boundingBox())?.x).toBe(0);
    expect((await menu.boundingBox())!.width).toBeLessThan(390);
    await page.mouse.click(380, 400);
    await expect(menu).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await t.close();
  }
});
