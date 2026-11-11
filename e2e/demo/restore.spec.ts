import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';
import { open, signIn } from './demo';

const scan = async (page: Page, label: string) => {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .exclude('[data-demo-badge]')
    .analyze();
  expect(violations, label).toEqual([]);
};

test('restoring a backup checks it first and asks before overwriting', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await open(page, '/admin/status');
  await expect(page.getByRole('heading', { name: 'Restore from a backup', exact: true })).toBeVisible();
  // Nothing to install until the backup has been checked.
  await expect(page.getByRole('checkbox', { name: /^Overwrite current values/ })).toHaveCount(0);
  await page.getByLabel('Backup in the backup folder', { exact: true }).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Check backup', exact: true }).click();
  await expect(page.getByText('The backup is complete and unchanged.', { exact: true })).toBeVisible();

  const overwrite = page.getByRole('checkbox', { name: /^Overwrite current values/ });
  await expect(overwrite).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Restore backup', exact: true })).toBeDisabled();
  await page.getByLabel('Your password', { exact: true }).fill('demo password');
  await overwrite.check();
  await page.getByRole('button', { name: 'Overwrite and restore…', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Overwrite the database?' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Overwrite and restore', exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /^I understand/ }).check();
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/^Type the organization name:/).fill('Wrong name');
  await expect(confirm).toBeDisabled();
  await scan(page, 'confirmation');
  await dialog.getByRole('button', { name: 'Keep current data', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Adding back only what's missing goes straight to the restore (the demo can't restart a server).
  await overwrite.uncheck();
  await page.getByRole('button', { name: 'Restore backup', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText("Restoring a backup isn't available in the demo.");

  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await scan(page, `${colorScheme} ${width}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});
