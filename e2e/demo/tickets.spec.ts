import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { open, signIn } from './demo';

test('opens a ConnectWise PSA ticket from a client workspace, lists it straight away, and answers it', async ({
  page,
}) => {
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

  // A PSA ticket has a conversation: the notes the customer sees, and a box to answer.
  const row = main.getByRole('row').filter({ hasText: 'Scanner in the back office will not connect' });
  await row.getByRole('button', { name: 'Conversation' }).click();
  await expect(main.getByText('No replies yet.')).toBeVisible();
  await main.getByLabel('Your reply').fill('It still shows the error this morning.');
  await main.getByRole('button', { name: 'Send reply' }).click();
  await expect(main.getByText(/It still shows the error this morning\./)).toBeVisible();
  expect(errors).toEqual([]);
});

test('connects ConnectWise PSA and needs a board before client portal tickets turn on', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await open(page, '/admin/data');
  // The card is the bordered box around the "ConnectWise PSA" heading.
  const card = page
    .getByRole('heading', { name: 'ConnectWise PSA', exact: true })
    .locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
  await card.getByLabel('Site').fill('api-na.myconnectwise.net');
  await card.getByLabel('Company ID').fill('itdr');
  await card.getByLabel('Public key').fill('public-key-123');
  await card.getByLabel('Private key').fill('private-key-456');
  await card.getByLabel('Client ID').fill('client-id-789');
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();

  const portal = card.getByRole('checkbox', { name: /Client portal tickets/ });
  await expect(portal).toBeDisabled();
  await card.getByLabel('Portal ticket board').fill('Help Desk');
  await card.getByLabel('Portal ticket board').blur();
  await expect(portal).toBeEnabled();
  await portal.click();
  await expect(portal).toBeChecked();

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const { violations } = await new AxeBuilder({ page })
      .include('main')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .exclude('[data-demo-badge]')
      .analyze();
    expect(violations, `${scheme}: ${JSON.stringify(violations.map((v) => v.id))}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});
