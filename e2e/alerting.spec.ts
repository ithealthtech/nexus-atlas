import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { AlertWorkspace } from '@atlas/shared';
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
    const savedTemplate = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Admin certificate message', exact: true }) });
    await expect(savedTemplate).toContainText('Saved');
    await savedTemplate.getByRole('button', { name: 'Use in new rule', exact: true }).click();
    await expect(page.getByLabel('Message template', { exact: true })).toHaveValue(
      (await owner.call('GET', '/api/settings/alerting')).data.templates.find(
        (t: { name: string }) => t.name === 'Admin certificate message',
      ).id,
    );
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
    await page.getByRole('button', { name: 'Templates', exact: true }).click();
    await page.getByLabel('Template name', { exact: true }).fill('Stale edit');
    await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Another administrator saved these drafts');
    await page.reload();
    await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Saved elsewhere');
    const client = (await owner.call('POST', '/api/clients', { name: 'Temporary client' })).data;
    const created = await owner.call('POST', '/api/users', {
      email: 'temporary@atlas.test',
      name: 'Temporary technician',
      role: 'technician',
      allClients: 'read',
      password: 'copper lantern orbit 1234',
      grants: [],
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const user = created.data;
    const draft = (await owner.call('GET', '/api/settings/alerting')).data as AlertWorkspace;
    draft.rules[0]!.clientIds = [client.id];
    draft.rules[0]!.emailUserIds.push(user.id);
    expect((await owner.call('PUT', '/api/settings/alerting', draft)).status).toBe(200);
    await t.handle.db.delete(schema.clients).where(eq(schema.clients.id, client.id));
    await t.handle.db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, user.id));
    await page.reload();
    await page.getByRole('button', { name: 'Rules', exact: true }).click();
    await page.getByLabel('Draft rule', { exact: true }).selectOption(draft.rules[0]!.id);
    const unavailableClient = page.getByRole('checkbox', {
      name: 'Unavailable client 1 — remove selection',
      exact: true,
    });
    await unavailableClient.click();
    await expect(unavailableClient).toHaveCount(0);
    const unavailableUser = page.getByRole('checkbox', {
      name: 'Temporary technician (unavailable — remove selection)',
      exact: true,
    });
    await unavailableUser.click();
    await expect(unavailableUser).toHaveCount(0);
    await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
    await expect(page.getByText('Alert drafts saved.', { exact: true })).toBeVisible();
  } finally {
    await context.close();
    await t.close();
  }
});

test('delivery controls remain usable when the independent drafts request fails', async ({ browser }) => {
  test.setTimeout(90_000);
  const base = 'http://localhost:4436';
  const t = await startApp({ PUBLIC_URL: base, WEB_DIST: resolve('apps/web/dist') });
  const context = await browser.newContext();
  try {
    await t.app.listen({ host: 'localhost', port: 4436 });
    const owner = (await setupOwner(t.app)).b;
    const drafts = (await owner.call('GET', '/api/settings/alerting')).data as AlertWorkspace;
    expect((await owner.call('PUT', '/api/settings/alerting', drafts)).status).toBe(200);
    expect(
      (
        await owner.call('POST', '/api/settings/alerting/publish', {
          revision: 1,
          lastVersion: 0,
          note: 'Recovery test',
        })
      ).status,
    ).toBe(200);
    expect((await owner.call('PUT', '/api/settings/alerting/delivery', { mode: 'center', confirm: true })).status).toBe(
      200,
    );
    await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: base })));
    const page = await context.newPage();
    await page.route('**/api/settings/alerting', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Draft storage unavailable.' }),
      }),
    );
    await page.goto(base + '/admin/alerting');
    await expect(page.getByRole('button', { name: 'Switch back to classic alerts', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Delivery history', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Draft storage unavailable.', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Switch back to classic alerts', exact: true }).click();
    await expect(page.getByText('Classic alerts', { exact: true })).toBeVisible();
    expect((await owner.call('GET', '/api/settings/alerting/delivery')).data.mode).toBe('classic');
    await page.unroute('**/api/settings/alerting');
    await page.getByRole('button', { name: 'Retry loading drafts', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your template library', exact: true })).toBeVisible();
    expect(t.outbox).toEqual([]);
  } finally {
    await context.close();
    await t.close();
  }
});
