import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { setupOwner, startApp } from '../apps/server/test/helpers';
import { REPORT_INFO, REPORT_KINDS } from '../packages/shared/src/reports';

/**
 * Protected features (see AGENTS.md): things the owner relies on that must never disappear in a redesign or a
 * "clean-up". If one of these checks fails, a feature was removed or broken: put it back rather than changing the
 * test, unless the owner asked for that feature to go.
 */

// Every page the owner reaches from the menus. Each must still exist and open.
const PAGES = [
  '/',
  '/clients',
  '/expirations',
  '/reports',
  '/assets',
  '/documents',
  '/checklists',
  '/passwords',
  '/my-vault',
  '/password-health',
  '/sends',
  '/account',
  '/admin/rotation',
  '/admin/bitlocker',
  '/admin/vault-policies',
  '/admin/users',
  '/admin/groups',
  '/admin/security',
  '/admin/layouts',
  '/admin/data',
  '/admin/duplicates',
  '/admin/status',
  '/admin/services',
  '/admin/certificate',
  '/admin/remote-access',
  '/admin/request-log',
  '/admin/webhooks',
  '/admin/updates',
  '/admin/email',
  '/admin/monitoring',
  '/admin/sign-in',
  '/admin/api-keys',
  '/admin/theme',
];

const shellMenu = (page: Page) => page.locator('[data-menu]').getAttribute('data-menu');

test('protected features stay in place', async ({ browser }) => {
  test.setTimeout(180_000);
  const base = 'http://localhost:4433';
  const t = await startApp({ PUBLIC_URL: base, WEB_DIST: resolve('apps/web/dist') });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  try {
    await t.app.listen({ host: 'localhost', port: 4433 });
    const owner = (await setupOwner(t.app)).b;
    const client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data;
    await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: base })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    // ---- every page still exists ----
    for (const path of PAGES) {
      await page.goto(`${base}${path}`);
      await expect(page.getByRole('heading', { level: 1 }).first(), path).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Page not found' }), path).toHaveCount(0);
    }

    // ---- the three menu styles, chosen per person and saved to the account ----
    await page.goto(`${base}/account`);
    const styles = page.getByRole('radiogroup', { name: 'Menu style' });
    await expect(styles.getByRole('radio')).toHaveCount(3);
    for (const [label, style] of [
      ['Sidebar', 'sidebar'],
      ['Top bar', 'top'],
      ['Rail and panel', 'rail'],
    ] as const) {
      await styles.getByRole('radio', { name: new RegExp(`^${label}`) }).click();
      await expect(styles.getByRole('radio', { name: new RegExp(`^${label}`) })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect.poll(() => shellMenu(page)).toBe(style);
      await expect(page.getByRole('navigation', { name: 'Main', exact: true })).toBeVisible();
      // Collapse sidebar belongs to the two side menus; the top bar has nothing to collapse.
      await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toHaveCount(
        style === 'top' ? 0 : 1,
      );
      // Saved to the account, not the browser: it survives a reload.
      await page.reload();
      await expect.poll(() => shellMenu(page)).toBe(style);
    }

    // ---- the dashboard can be customized ----
    await page.goto(`${base}/`);
    await expect(page.getByRole('button', { name: 'Customize', exact: true })).toBeVisible();

    // ---- search or switch client, from anywhere ----
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Search Atlas' })).toBeVisible();
    await page.keyboard.press('Escape');

    // ---- a client's sections, with the rest under More ----
    await page.goto(`${base}/clients/${client.id}`);
    const sections = page.getByRole('navigation', { name: 'Client sections' });
    await expect(sections.getByRole('link', { name: /Assets/ })).toBeVisible();
    await sections.getByRole('button', { name: /More sections/ }).click();
    await expect(page.getByRole('menuitem', { name: /Activity/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // ---- Theme keeps its options, including the way back to Atlas defaults ----
    await page.goto(`${base}/admin/theme`);
    await expect(page.getByRole('button', { name: /Atlas defaults/ })).toBeVisible();

    // ---- every report type is offered ----
    await page.goto(`${base}/reports`);
    for (const kind of REPORT_KINDS)
      await expect(
        page.getByRole('button', {
          name: new RegExp(`^${REPORT_INFO[kind].name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
        }),
        kind,
      ).toBeVisible();

    // ---- phones always get the slide-out menu, whatever the style ----
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible();

    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await t.close();
  }
});
