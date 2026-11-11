import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { open, signIn } from './demo';

/** The asset names in the list, top to bottom. */
const names = (page: Page) =>
  page.getByRole('main').getByRole('table').locator('tbody tr td:first-child a span.font-semibold').allInnerTexts();

test('assets filter live, sort by column, keep filters in the address, and save named views', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await open(page, '/assets');
  const main = page.getByRole('main');
  const search = main.getByRole('searchbox', { name: 'Filter assets' });
  await expect.poll(async () => (await names(page)).length).toBeGreaterThan(5);
  const total = (await names(page)).length;

  // Typing filters at once, across fields as well as names, and every word has to match.
  await search.pressSequentially('dell 2022', { delay: 20 });
  await expect(search).toHaveValue('dell 2022');
  await expect.poll(() => names(page)).toEqual(['HDG-DC-01']);
  await expect(main.getByText(`Showing 1 of ${total} assets`)).toBeVisible();
  expect(page.url()).toContain('q=dell');
  await main.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(search).toHaveValue('');

  // Client, layout and a field combine.
  await main.getByLabel('Client', { exact: true }).selectOption({ label: 'Harbor Dental Group' });
  await expect.poll(async () => (await names(page)).length).toBe(4);
  await main
    .getByRole('navigation', { name: 'Asset layouts' })
    .getByRole('button', { name: /Configurations/ })
    .click();
  await expect.poll(() => names(page)).toEqual(['HDG-DC-01', 'HDG-FW-01']);
  await main.getByLabel('Filter by a field').selectOption({ label: 'Type' });
  await main.getByRole('combobox', { name: 'Type', exact: true }).selectOption({ label: 'is Firewall' });
  await expect.poll(() => names(page)).toEqual(['HDG-FW-01']);
  await main.getByRole('button', { name: 'Remove Type filter' }).click();
  await main.getByLabel('Filter by a field').selectOption({ label: 'Operating system' });
  await main.getByRole('textbox', { name: 'Operating system contains' }).fill('server');
  await expect.poll(() => names(page)).toEqual(['HDG-DC-01']);
  await main.getByRole('combobox', { name: 'How to match Operating system' }).selectOption('(none)');
  await expect.poll(() => names(page)).toEqual(['HDG-FW-01']);

  // Status toggles narrow further; nothing left offers to clear.
  await main.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Retired' }).click();
  await expect(main.getByText('Nothing matches')).toBeVisible();
  await main.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'Retired' }).click();
  await expect.poll(() => names(page)).toEqual(['HDG-FW-01']);

  // The filters are in the address, so leaving and coming back keeps them. (The demo makes new sample data on
  // every load, so a reload would not find the same client.)
  await open(page, '/clients');
  await expect(search).toHaveCount(0);
  await page.goBack();
  await expect.poll(() => names(page)).toEqual(['HDG-FW-01']);
  await expect(main.getByLabel('Client', { exact: true })).toHaveValue(/.+/);

  // Save the view, clear everything, and bring it back.
  await main.getByRole('button', { name: 'Save view' }).click();
  await page.getByRole('dialog').getByLabel('View name').fill('Harbor gear without an OS');
  await page.getByRole('dialog').getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await main
    .getByRole('navigation', { name: 'Asset layouts' })
    .getByRole('button', { name: /All assets/ })
    .click();
  await main.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect.poll(async () => (await names(page)).length).toBe(total);
  await main.getByLabel('Saved views').selectOption({ label: 'Harbor gear without an OS' });
  await expect.poll(() => names(page)).toEqual(['HDG-FW-01']);
  // Clearing filters keeps the chosen layout.
  await main.getByRole('button', { name: 'Clear filters' }).first().click();
  await expect.poll(() => names(page)).toEqual(['CRCU-SW-CORE', 'HDG-DC-01', 'HDG-FW-01', 'NLA-NAS-01']);
  await main
    .getByRole('navigation', { name: 'Asset layouts' })
    .getByRole('button', { name: /All assets/ })
    .click();

  // Column headings sort, and a second click reverses.
  const nameHeading = main.getByRole('columnheader', { name: 'Name' });
  await expect(nameHeading).toHaveAttribute('aria-sort', 'ascending');
  const ascending = await names(page);
  await nameHeading.getByRole('button').click();
  await expect(nameHeading).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(() => names(page)).toEqual([...ascending].reverse());
  await main.getByRole('columnheader', { name: 'Client' }).getByRole('button').click();
  await expect(main.getByRole('columnheader', { name: 'Client' })).toHaveAttribute('aria-sort', 'ascending');
  await expect(nameHeading).not.toHaveAttribute('aria-sort');
  expect((await names(page))[0]).toMatch(/cedarridgecu|CRCU/i);

  await main.getByLabel('Client', { exact: true }).selectOption({ label: 'Harbor Dental Group' });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .exclude('[data-demo-badge]')
        .analyze();
      expect(violations, `${colorScheme} ${width}`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/assets-filters-${colorScheme}-${width}.png`, fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});
