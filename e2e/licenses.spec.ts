import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { setupOwner, startApp } from '../apps/server/test/helpers';
import { staticKeyProvider } from '../apps/server/src/crypto/keys';
import { SettingsService } from '../apps/server/src/services/settings';

test('client subscriptions and GDAP assignments work on desktop and mobile', async ({ browser }) => {
  test.setTimeout(90_000);
  const base = 'http://localhost:4429';
  const tenant = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const sku = '11111111-aaaa-4bbb-8ccc-222222222222';
  const user = '22222222-aaaa-4bbb-8ccc-333333333333';
  let assigned = false;
  const keys = staticKeyProvider([randomBytes(32)]);
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'synthetic-preview-token' });
    if (url.pathname.endsWith('/delegatedAdminRelationships'))
      return Response.json({
        value: [
          {
            id: 'test-relationship',
            status: 'active',
            endDateTime: new Date(Date.now() + 86400000).toISOString(),
            customer: { tenantId: tenant, displayName: 'Harbor Dental' },
          },
        ],
      });
    if (url.pathname.endsWith('/subscribedSkus'))
      return Response.json({
        value: [
          {
            skuId: sku,
            skuPartNumber: 'SPB',
            prepaidUnits: { enabled: 20 },
            consumedUnits: assigned ? 1 : 0,
            capabilityStatus: 'Enabled',
          },
        ],
      });
    if (url.pathname === '/v1.0/users')
      return Response.json({
        value: [
          {
            id: user,
            displayName: 'Avery Example',
            userPrincipalName: 'avery@harbor.test',
            assignedLicenses: assigned ? [{ skuId: sku }] : [],
            licenseAssignmentStates: [],
          },
        ],
      });
    if (url.pathname.endsWith('/assignLicense') && init?.method === 'POST') {
      assigned = !assigned;
      return Response.json({ id: user });
    }
    throw new Error('Unexpected Microsoft request');
  }) as typeof fetch;
  const t = await startApp({ PUBLIC_URL: base, WEB_DIST: resolve('apps/web/dist') }, { keys, m365Fetch: fetcher });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1080 },
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  try {
    await t.app.listen({ host: 'localhost', port: 4429 });
    const owner = (await setupOwner(t.app)).b;
    const id = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
    const orgId = (await owner.call('GET', '/api/session')).data.actor.orgId;
    await owner.call('PUT', '/api/integrations/m365', {
      clientId: '11111111-2222-4333-8444-555555555555',
      clientSecret: 'synthetic-secret',
      partnerTenantId: '66666666-7777-4888-8999-000000000000',
      authMode: 'gdap',
      autoSync: false,
    });
    const settings = new SettingsService(t.handle.db, keys);
    await settings.saveGdap(
      orgId,
      (await settings.m365(orgId))!,
      {
        refreshSealed: '',
        oid: user,
        name: 'Partner',
        email: 'partner@atlas.test',
        connectedAt: new Date().toISOString(),
      },
      'synthetic-refresh-token',
    );
    await settings.patchM365(orgId, {
      tenants: { [id]: { tenantId: tenant, tenantName: 'Harbor Dental', status: 'ok', checkedAt: null, detail: null } },
    });
    await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: base })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const screenshotDir = process.env.ATLAS_SCREENSHOT_DIR ?? 'test-results/license-screenshots';
    mkdirSync(screenshotDir, { recursive: true });
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(screenshotDir, 'atlas-main-page.png') });
    await page.goto(`${base}/clients/${id}/licenses`);
    await page.getByRole('button', { name: 'Add subscription', exact: true }).click();
    await page.getByLabel('Product / subscription', { exact: true }).fill('Design Suite');
    await page.getByLabel('Vendor', { exact: true }).fill('Example Software');
    await page.getByLabel('Purchased seats', { exact: true }).fill('10');
    await page.getByLabel('Cost per seat per billing period', { exact: true }).fill('15.50');
    await page.getByLabel('Assigned users or devices', { exact: true }).fill('Avery Example\nOffice workstation');
    await page
      .getByLabel('Renewal date', { exact: true })
      .fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    await page.getByLabel('Renews automatically', { exact: true }).check();
    await page.getByRole('button', { name: 'Save subscription', exact: true }).click();
    await expect(page.getByText('$155.00 / month', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Edit Design Suite', exact: true }).click();
    await page.getByLabel('Purchased seats', { exact: true }).fill('12');
    await page.getByRole('button', { name: 'Save subscription', exact: true }).click();
    await expect(page.getByText('2 / 12 assigned', { exact: false })).toBeVisible();
    await page.getByLabel('Microsoft subscription', { exact: true }).selectOption(sku);
    await page.getByLabel('Assign to a user', { exact: true }).selectOption(user);
    await page.getByRole('button', { name: 'Assign license', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm assignment', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove from Avery Example', exact: true })).toBeVisible();
    expect(assigned).toBe(true);
    // One at a time: each notification also closes itself after a few seconds, so a list taken up front goes stale.
    const toasts = page.getByRole('button', { name: 'Dismiss', exact: true });
    while ((await toasts.count()) > 0)
      await toasts
        .first()
        .click({ timeout: 2000 })
        .catch(() => undefined);
    // Desktop/mobile, light/dark: check labels, contrast, and horizontal overflow on the completed page.
    for (const dark of [false, true]) {
      await page.evaluate((dark) => {
        document.documentElement.classList.toggle('dark', dark);
      }, dark);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
        await page.waitForLoadState('networkidle');
        const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
        expect(axe.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({
          path: resolve(screenshotDir, `atlas-licenses-${width}-${dark ? 'dark' : 'light'}.png`),
          fullPage: true,
        });
      }
    }
    // System font metrics vary by platform; larger text must leave the section controls reachable too.
    const fontScale = await page.evaluate(() => {
      const previous = document.documentElement.dataset.font;
      document.documentElement.dataset.font = 'large';
      return previous;
    });
    const largeText = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
    expect(largeText.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) }))).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate((previous) => {
      if (previous) document.documentElement.dataset.font = previous;
      else delete document.documentElement.dataset.font;
    }, fontScale);
    await page.getByRole('button', { name: 'Remove from Avery Example', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
    await expect(page.getByText('0 assigned', { exact: true })).toBeVisible();
    expect(assigned).toBe(false);
    await page.getByRole('button', { name: 'Delete Design Suite', exact: true }).click();
    await page.getByRole('button', { name: 'Delete subscription', exact: true }).click();
    await expect(page.getByText('No subscriptions tracked yet', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await t.close();
  }
});
