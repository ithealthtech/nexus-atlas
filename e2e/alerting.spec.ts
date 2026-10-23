import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { setupOwner, startApp } from '../apps/server/test/helpers';

test('alert drafts persist and a stale editor cannot overwrite another administrator', async ({ browser }) => {
  test.setTimeout(90_000);
  const base = 'http://localhost:4435';
  const t = await startApp({ PUBLIC_URL: base, WEB_DIST: resolve('apps/web/dist') });
  const context = await browser.newContext();
  try {
    await t.app.listen({ host: 'localhost', port: 4435 });
    const owner = (await setupOwner(t.app)).b;
    await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: base })));
    const page = await context.newPage();
    await page.goto(base + '/admin/email');
    await page.getByRole('link', { name: 'Open alerting center', exact: true }).click();
    await page.getByRole('button', { name: 'New template', exact: true }).click();
    await page.getByLabel('Template name', { exact: true }).fill('Admin certificate message');
    await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await expect(page.getByText('Alert drafts saved.', { exact: true })).toBeVisible();
    await page.reload();
    await page.getByLabel('Template library', { exact: true }).selectOption({ label: 'Admin certificate message' });
    await page.getByRole('button', { name: 'New rule from template', exact: true }).click();
    await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await expect(page.getByText('Alert drafts saved.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Run preview', exact: true }).click();
    await expect(page.getByText('Conditions match', { exact: true })).toBeVisible();
    expect(t.outbox).toEqual([]);
    const other = await context.newPage();
    await other.goto(base + '/admin/alerting');
    await other.getByLabel('Template name', { exact: true }).fill('Saved elsewhere');
    await other.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await expect(other.getByText('Alert drafts saved.', { exact: true })).toBeVisible();
    await page.getByLabel('Template name', { exact: true }).fill('Stale edit');
    await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Another administrator saved these drafts');
    await page.reload();
    await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Saved elsewhere');
  } finally {
    await context.close();
    await t.close();
  }
});
