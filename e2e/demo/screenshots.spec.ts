import { expect, test, type Page } from '@playwright/test';
import { open, sampleIds, signIn } from './demo';

// Reference screenshots of the main pages, compared on every pull request so an unintended change to the look shows
// up in review. The demo's sample data is dated from "now", so the clock is fixed. To accept an intended change,
// delete the old image and push: CI takes a new one (failing that once) and uploads it in the demo-screenshots
// artifact, ready to commit.
const NOW = new Date('2026-10-01T15:00:00Z');

const PAGES: [name: string, path: string][] = [
  ['overview', '/'],
  ['clients', '/clients'],
  ['client', '/clients/{client}'],
  ['client-assets', '/clients/{client}/assets'],
  ['asset', '/assets/{asset}'],
  ['document', '/documents/{document}'],
  ['passwords', '/clients/{client}/passwords'],
  ['password', '/passwords/{password}'],
  ['reports', '/reports'],
  ['expirations', '/expirations'],
  ['system-status', '/admin/status'],
  ['people', '/admin/users'],
];
const PHONE_PAGES = new Set(['overview', 'client', 'password', 'reports']);

async function shoot(page: Page, name: string) {
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    // The demo's own "sample data" badge is not part of Atlas.
    mask: [page.locator('[data-demo-badge]')],
  });
}

for (const colorScheme of ['light', 'dark'] as const)
  for (const [view, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['phone', { width: 390, height: 844 }],
  ] as const)
    test.describe(`${colorScheme}, ${view}`, () => {
      test.use({ colorScheme, viewport });

      test('main pages look as they did', async ({ page }) => {
        test.skip(view === 'phone' && colorScheme === 'dark', 'Phone layouts are compared in the light theme only.');
        test.setTimeout(180_000);
        await page.clock.setFixedTime(NOW);
        await signIn(page);
        const ids = await sampleIds(page);
        for (const [name, template] of PAGES) {
          if (view === 'phone' && !PHONE_PAGES.has(name)) continue;
          await open(
            page,
            template.replace(/\{(\w+)\}/g, (_, key: keyof typeof ids) => ids[key]),
          );
          await test.step(name, () => shoot(page, `${name}-${colorScheme}-${view}`));
        }
      });
    });
