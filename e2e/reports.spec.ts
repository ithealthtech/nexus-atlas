import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { setupOwner, startApp } from '../apps/server/test/helpers';

test('premium shell and report snapshots, filters, templates and exports work on desktop and phone', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const base = 'http://localhost:4431';
  const t = await startApp({ PUBLIC_URL: base, WEB_DIST: resolve('apps/web/dist') });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  try {
    await t.app.listen({ host: 'localhost', port: 4431 });
    const owner = (await setupOwner(t.app)).b;
    const client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group', type: 'Customer' })).data;
    await owner.call('POST', '/api/clients', {
      name: 'Northwind Professional Services and Technology',
      type: 'Customer',
    });
    await owner.call('POST', `/api/clients/${client.id}/licenses`, {
      name: 'Design Suite',
      seats: 10,
      assignments: ['Avery'],
      unitCostCents: 1500,
    });
    await owner.call('POST', `/api/clients/${client.id}/licenses`, {
      name: 'Backup Service',
      seats: 2,
      assignments: ['Office', 'Server'],
      unitCostCents: 500,
    });
    await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: base })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const screenshots = process.env.ATLAS_SCREENSHOT_DIR ?? 'test-results/report-screenshots';
    mkdirSync(screenshots, { recursive: true });
    await page.goto(base);
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
    const main = page.getByRole('navigation', { name: 'Main', exact: true });
    await expect(main.getByRole('link')).toHaveCount(5);
    await expect(main).not.toContainText('Harbor Dental');
    await page.screenshot({ path: resolve(screenshots, 'atlas-main-page.png') });
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Search or switch client', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Search Atlas' })).toBeHidden();
    await page.keyboard.press('Control+k');
    const searchDialog = page.getByRole('dialog', { name: 'Search Atlas' });
    await expect(searchDialog).toBeVisible();
    await expect(searchDialog.getByRole('combobox')).toBeFocused();
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.keyboard.press('Escape');
      await expect(searchDialog).toBeHidden();
      await page.keyboard.press('Control+k');
      await expect(searchDialog).toBeVisible();
      await expect(searchDialog.getByRole('combobox')).toBeFocused();
    }
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
    await expect(searchDialog.getByRole('option', { name: 'Reports Go to', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Workspace', exact: true })
      .getByRole('link', { name: 'Reports', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    // The library folds away once a report is open; its collections are a click on Change report away.
    const library = async (collection: string) => {
      const change = page.getByRole('button', { name: 'Change report', exact: true });
      if (await change.isVisible()) await change.click();
      await page.getByRole('button', { name: collection, exact: true }).click();
    };
    await page.getByRole('button', { name: 'License utilization', exact: false }).click();
    await page.getByRole('checkbox', { name: 'Harbor Dental Group', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Include Microsoft 365 inventory through GDAP', exact: false }).uncheck();
    await page.getByRole('button', { name: 'Run report', exact: true }).click();
    // Every section shows at once, under its own heading.
    await expect(page.getByRole('heading', { name: 'Manually tracked subscriptions', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Design Suite', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(screenshots, 'atlas-reports-desktop.png'), fullPage: true });
    // The Needs review figure filters the report, and pressing it again shows everything.
    await page.getByRole('button', { name: /^Needs review/ }).click();
    await expect(page.getByRole('cell', { name: 'Backup Service', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Design Suite', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Needs review/ }).click();
    await page.getByRole('searchbox', { name: 'Search the whole report', exact: true }).fill('Design');
    await expect(page.getByRole('cell', { name: 'Design Suite', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Backup Service', exact: true })).toHaveCount(0);
    const csvEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'CSV', exact: true }).click();
    const csv = await csvEvent;
    const csvPath = await csv.path();
    const text = readFileSync(csvPath!, 'utf8');
    expect(text).toContain('Design Suite');
    expect(text).not.toContain('Backup Service');
    expect(text).toContain('"Product","Status"');
    const pdfEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'PDF', exact: true }).click();
    const pdf = await pdfEvent;
    expect(
      readFileSync((await pdf.path())!)
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    // Sharing with the client: a one-client snapshot can be shared, and its link opens without an account.
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
    const [latest] = (await owner.call('GET', '/api/reports/runs')).data as { id: string }[];
    const link = (await owner.call('POST', `/api/reports/runs/${latest!.id}/shares`, { expiresDays: 7 })).data
      .url as string;
    const visitor = await browser.newContext({ reducedMotion: 'reduce', colorScheme: 'light' });
    const shared = await visitor.newPage();
    await shared.goto(link);
    await expect(shared.getByRole('heading', { name: 'License utilization', exact: true, level: 1 })).toBeVisible();
    await expect(shared.getByRole('cell', { name: 'Design Suite', exact: true })).toBeVisible();
    await expect(shared.getByRole('link', { name: 'Download PDF', exact: true })).toBeVisible();
    const sharedViolations = (
      await new AxeBuilder({ page: shared }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
    ).violations;
    expect(sharedViolations.map((v) => v.id)).toEqual([]);
    await shared.screenshot({ path: resolve(screenshots, 'atlas-shared-report.png'), fullPage: true });
    await visitor.close();
    // Scheduling it: saved to the Scheduled tab. With email not set up, Send now records why it wasn't sent.
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    const scheduleDialog = page.getByRole('dialog', { name: 'Schedule this report' });
    await scheduleDialog.getByLabel('Send to').fill('office.manager@harbor.example');
    await scheduleDialog.getByRole('button', { name: 'Schedule report', exact: true }).click();
    await expect(scheduleDialog).toHaveCount(0);
    await library('Scheduled');
    await expect(page.getByText('Every month on day 1 at 07:00')).toBeVisible();
    await page.getByRole('button', { name: 'Send now', exact: true }).click();
    await expect(page.getByText(/Not delivered to office\.manager@harbor\.example: Email is not set up/)).toBeVisible();
    await library('Built-in');
    await page.getByRole('button', { name: 'Save template', exact: true }).click();
    await page.getByLabel('Template name', { exact: true }).fill('Monthly client licenses');
    await page.getByRole('dialog').getByRole('button', { name: 'Save template', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await library('Templates');
    await page.getByRole('button', { name: 'Monthly client licenses', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run report', exact: true })).toBeVisible();
    // Running the same report again offers a comparison with the first run.
    await page.getByRole('button', { name: 'Run report', exact: true }).click();
    await page.getByRole('button', { name: /^Compare with / }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Compared with' })).toBeVisible();
    await expect(page.getByText(/0 new, 0 changed, 0 removed/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Stop comparing', exact: true }).click();
    await library('History');
    await page
      .getByRole('button', { name: /^License utilization/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: 'Manually tracked subscriptions', exact: true })).toBeVisible();
    // One at a time: each notification also closes itself after a few seconds, so a list taken up front goes stale.
    const toasts = page.getByRole('button', { name: 'Dismiss', exact: true });
    while ((await toasts.count()) > 0)
      await toasts
        .first()
        .click({ timeout: 2000 })
        .catch(() => undefined);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const width of [1600, 390]) {
        await page.setViewportSize({ width, height: 1100 });
        const violations = (
          await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
        ).violations;
        expect(
          violations,
          `${theme} ${width}: ${JSON.stringify(violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })))}`,
        ).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (width === 390)
          await page.screenshot({ path: resolve(screenshots, `atlas-reports-mobile-${theme}.png`), fullPage: true });
      }
    }
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('link', { name: 'Clients', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Client workspaces', exact: true })).toBeVisible();
    await page.goto(`${base}/clients/${client.id}/reports`);
    await expect(page.getByRole('checkbox', { name: 'Harbor Dental Group', exact: true })).toBeChecked();
    // One click on the client's page: the quarterly review pack, as one PDF named after the client.
    await page.setViewportSize({ width: 1600, height: 1100 });
    const packEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Review pack', exact: true }).click();
    const pack = await packEvent;
    expect(pack.suggestedFilename()).toMatch(/^Harbor Dental Group quarterly review \d{4}-\d{2}-\d{2}\.pdf$/);
    expect(
      readFileSync((await pack.path())!)
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    await pack.saveAs(resolve(screenshots, 'atlas-review-pack.pdf'));
    // It's kept in the client's report history, grouped by the reports it's made of.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: /^Harbor Dental Group quarterly review/ }).click();
    await expect(page.getByRole('button', { name: 'Review pack PDF', exact: true })).toBeVisible();
    // Every part of the pack is on the page, each section marked with the report it belongs to.
    for (const part of ['Executive summary', 'Security posture', 'Service review', 'Upcoming renewals'])
      await expect(page.getByText(part, { exact: true }).first()).toBeVisible();
    // Administration's pages are tabs like every other area's: the section you're in, and the rest under More.
    const prefs = (await owner.call('GET', '/api/account/workspace')).data;
    await owner.call('PUT', '/api/account/workspace', { ...prefs, menu: 'top' });
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(`${base}/admin/users`);
    const adminTabs = page.getByRole('navigation', { name: 'Workspace', exact: true });
    await expect(adminTabs.getByRole('link', { name: 'People & access', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(adminTabs.getByRole('link', { name: 'Groups', exact: true })).toBeVisible();
    await expect(adminTabs.getByRole('link', { name: 'Webhooks', exact: true })).toHaveCount(0);
    await adminTabs.getByRole('button', { name: 'More administration pages', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Webhooks', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/webhooks$/);
    await expect(adminTabs.getByRole('link', { name: 'Updates', exact: true })).toBeVisible();
    await expect(adminTabs.getByRole('link', { name: 'Groups', exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(screenshots, 'atlas-admin-tabs.png') });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await t.close();
  }
});
