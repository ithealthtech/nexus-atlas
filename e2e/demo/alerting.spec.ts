import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { open, settle, signIn } from './demo';

test('email and Teams templates and rule previews work without sending', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await settle(page);
  await page.screenshot({ path: 'test-results/alerting-main.png' });
  await open(page, '/admin/email');
  await page.getByRole('link', { name: 'Open alerting center', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Alerting center', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New template', exact: true }).click();
  await page.getByLabel('Template name', { exact: true }).fill('Certificate reminder');
  await page.getByLabel('Email subject', { exact: true }).fill('{{clientName}}: certificate review');
  await page.getByLabel('Email message', { exact: true }).fill('Hello ');
  await page.getByRole('button', { name: 'Insert field', exact: true }).click();
  await expect(page.getByLabel('Email message', { exact: true })).toHaveValue('Hello {{clientName}}');
  await page
    .getByLabel('Email message', { exact: true })
    .fill('Please review {{itemName}}. Due in {{daysRemaining}} days.');
  await page.getByLabel('Teams message', { exact: true }).fill('Team: {{clientName}} / {{itemName}}');
  await page.getByRole('button', { name: 'New rule from template', exact: true }).click();
  await page.getByLabel('Rule name', { exact: true }).fill('Certificate reminders');
  await page.getByRole('checkbox', { name: /^Microsoft Teams client channel/ }).check();
  await page.getByLabel('Reminder days', { exact: true }).fill('14, 7, 0');
  await page.getByLabel('Example client', { exact: true }).selectOption({ label: 'Harbor Dental Group' });
  await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
  await expect(page.getByText('Alert drafts saved.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run preview', exact: true }).click();
  await expect(page.getByText('Conditions match', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Email preview' })).toContainText(
    'Please review Example certificate. Due in 14 days.',
  );
  await expect(page.getByRole('region', { name: 'Teams preview' })).toContainText(
    'Team: Harbor Dental Group / Example certificate',
  );
  await page.getByLabel('Example days remaining', { exact: true }).fill('13');
  await expect(page.getByRole('region', { name: 'Email preview' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Run preview', exact: true }).click();
  await expect(page.getByText('Conditions do not match', { exact: true })).toBeVisible();
  await page.getByLabel('Version note', { exact: true }).fill('Approve certificate reminders');
  await page.getByRole('button', { name: 'Publish saved drafts', exact: true }).click();
  await page.getByRole('button', { name: 'View version 1', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Published version 1', exact: true })).toBeVisible();
  await page.getByLabel('Email message', { exact: true }).fill('A newer draft');
  await expect(page.getByRole('button', { name: 'Publish saved drafts', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save drafts', exact: true })).toBeDisabled();
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Restore version 1 to drafts', exact: true }).click();
  await expect(
    page.getByText('Version restored to drafts. Review selections before publishing again.', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Template library', { exact: true }).selectOption({ label: 'Certificate reminder' });
  await expect(page.getByLabel('Email message', { exact: true })).toHaveValue(
    'Please review {{itemName}}. Due in {{daysRemaining}} days.',
  );
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      while (await page.getByRole('button', { name: 'Dismiss', exact: true }).count())
        await page.getByRole('button', { name: 'Dismiss', exact: true }).first().click();
      await page.evaluate(() => window.scrollTo(0, 0));
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .exclude('[data-demo-badge]')
        .analyze();
      expect(violations, `${colorScheme} ${width}`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `test-results/alerting-${colorScheme}-${width}.png`, fullPage: true });
    }
  }
  await page.getByLabel('Email message', { exact: true }).fill('Unsafe field: {{secret}}');
  await page.getByRole('button', { name: 'Save drafts', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unknown field: secret');
  await open(page, '/admin/email');
  await page.getByRole('link', { name: 'Open alerting center', exact: true }).click();
  await page.getByLabel('Template library', { exact: true }).selectOption({ label: 'Certificate reminder' });
  await expect(page.getByLabel('Email message', { exact: true })).toHaveValue(
    'Please review {{itemName}}. Due in {{daysRemaining}} days.',
  );
  await page.getByLabel('Draft rule', { exact: true }).selectOption({ label: 'Certificate reminders' });
  await expect(page.getByRole('button', { name: 'Save drafts', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});
