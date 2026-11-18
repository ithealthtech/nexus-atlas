import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { open, signIn } from './demo';

test('opens a ConnectWise ticket from a client workspace and lists it straight away', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await open(page, '/clients');
  await page.getByRole('main').getByRole('link', { name: 'Harbor Dental Group' }).first().click();
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'New ticket' }).click();

  const drawer = page.getByRole('dialog', { name: 'New ticket' });
  await expect(drawer).toBeVisible();
  const submit = drawer.getByRole('button', { name: 'Open ticket' });
  // Both fields are needed before it can be sent.
  await expect(submit).toBeDisabled();
  await drawer.getByLabel('Summary').fill('Scanner in the back office will not connect');
  await expect(submit).toBeDisabled();
  await drawer.getByLabel('Details').fill('Since Monday the scanner shows "network error" when scanning to email.');

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .exclude('[data-demo-badge]')
      .analyze();
    expect(violations, `${scheme}: ${JSON.stringify(violations.map((v) => v.id))}`).toEqual([]);
  }

  await submit.click();
  await expect(drawer).toBeHidden();
  await expect(page.getByText(/Ticket #\d+ opened/)).toBeVisible();
  const details = main.locator('section, div').filter({ has: page.getByRole('heading', { name: 'Ticket details' }) });
  const showAll = details.getByRole('button', { name: /Show all/ });
  if (await showAll.count()) await showAll.first().click();
  await expect(main.getByText('Scanner in the back office will not connect')).toBeVisible();
  expect(errors).toEqual([]);
});
