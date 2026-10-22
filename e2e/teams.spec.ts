import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { staticKeyProvider } from '../apps/server/src/crypto/keys';
import { TeamsSettingsStore } from '../apps/server/src/services/teams/settings';
import { setupOwner, startApp } from '../apps/server/test/helpers';
import type { GraphMessage } from '../apps/server/src/services/teams/graph';

test('Teams connection settings and client discussions work on desktop and phone', async ({ browser }) => {
  test.setTimeout(180_000);
  const base = 'http://localhost:4434';
  const keys = staticKeyProvider([randomBytes(32)]);
  const messages: GraphMessage[] = [
    {
      id: 'external',
      from: { user: { displayName: 'Robin Hale' } },
      body: { contentType: 'html', content: '<p>Review agenda</p>' },
      createdDateTime: new Date().toISOString(),
    },
  ];
  const replies: GraphMessage[] = [];
  let nextId = 0;
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://login.microsoftonline.com/'))
      return Response.json({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh' });
    if (!url.startsWith('https://graph.microsoft.com/v1.0/teams/')) throw new Error('Unexpected Teams service');
    const list = url.includes('/replies') ? replies : messages;
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { body: GraphMessage['body'] };
      const message = {
        id: `message-${++nextId}`,
        body: body.body,
        from: { user: { displayName: 'Atlas Teams account' } },
        createdDateTime: new Date().toISOString(),
      };
      list.unshift(message);
      return Response.json(message, { status: 201 });
    }
    if (init?.method === 'PATCH') {
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
      const message = list.find((m) => m.id === id)!;
      message.body = (JSON.parse(String(init.body)) as { body: GraphMessage['body'] }).body;
      return new Response(null, { status: 204 });
    }
    return Response.json({ value: list });
  }) as typeof fetch;
  const t = await startApp({ PUBLIC_URL: base, WEB_DIST: resolve('apps/web/dist') }, { keys, teamsFetch: fake });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  try {
    await t.app.listen({ host: 'localhost', port: 4434 });
    const owner = (await setupOwner(t.app)).b;
    const actor = (await owner.call('GET', '/api/session')).data.actor;
    const client = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data;
    await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: base })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/admin/teams');
    await expect(page.getByRole('heading', { name: 'Microsoft Teams', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download Teams app', exact: true })).toHaveCount(0);
    await expect(page.getByText('Teams app package', { exact: true })).toHaveCount(0);
    await page.getByLabel('Enable Microsoft Teams', { exact: true }).check();
    await page.getByLabel('Directory (tenant) ID', { exact: true }).fill('11111111-2222-4333-8444-555555555555');
    await page.getByLabel('Application (client) ID', { exact: true }).fill('22222222-2222-4333-8444-555555555555');
    await page.getByLabel('Application secret', { exact: true }).fill('synthetic-client-secret');
    await page.getByRole('button', { name: 'Add client channel', exact: true }).click();
    await page.getByLabel('Client', { exact: true }).selectOption(client.id);
    await page.getByLabel('Team ID', { exact: true }).fill('22222222-2222-4333-8444-555555555555');
    await page.getByLabel('Channel name', { exact: true }).fill('Harbor team');
    await page.getByLabel('Channel ID', { exact: true }).fill('19:harbor@thread.tacv2');
    await page.getByRole('button', { name: 'Save Teams settings', exact: true }).click();
    await expect(page.getByText('Teams settings saved.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Application secret', { exact: true })).toHaveValue('');
    const store = new TeamsSettingsStore(t.handle.db, keys);
    await store.connect(
      actor.orgId,
      (await store.load(actor.orgId))!.generation,
      { oid: actor.id, name: 'Atlas Teams account', connectedAt: new Date().toISOString() },
      'synthetic-refresh',
    );
    await page.reload();
    await expect(
      page.getByText('Discussions and alerts connected as Atlas Teams account.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Send test notification', exact: true }).click();
    await expect(page.getByText('Test notification sent.', { exact: true })).toBeVisible();
    expect(messages.some((m) => m.body?.content?.includes('Atlas test notification'))).toBe(true);
    await page.goto(base + `/clients/${client.id}/teams`);
    await expect(page.getByText('Review agenda', { exact: true })).toBeVisible();
    await page.getByLabel('Post', { exact: true }).fill('New review discussion');
    await page.getByRole('button', { name: 'Post to Teams', exact: true }).click();
    await expect(page.getByText('New review discussion', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit post', exact: true }).click();
    await page.getByLabel('Post', { exact: true }).fill('Updated review discussion');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('Updated review discussion', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Read and reply', exact: true }).first().click();
    await page.getByLabel('Reply', { exact: true }).fill('Ready for the client meeting.');
    await page.getByRole('button', { name: 'Send reply', exact: true }).click();
    await expect(page.getByText('Ready for the client meeting.', { exact: true })).toBeVisible();
    const shots = resolve('test-results/teams-screenshots');
    mkdirSync(shots, { recursive: true });
    for (const path of [`/clients/${client.id}/teams`, '/admin/teams']) {
      await page.goto(base + path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      for (const scheme of ['light', 'dark'] as const)
        for (const width of [1440, 390]) {
          await page.emulateMedia({ colorScheme: scheme });
          await page.setViewportSize({ width, height: 1100 });
          const violations = (
            await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
          ).violations;
          expect(violations, `${path} ${scheme} ${width}`).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await page.screenshot({
            path: resolve(shots, `${path.endsWith('/admin/teams') ? 'settings' : 'discussion'}-${scheme}-${width}.png`),
            fullPage: true,
          });
        }
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await t.close();
  }
});
