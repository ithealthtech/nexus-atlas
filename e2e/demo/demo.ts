import { expect, type Page } from '@playwright/test';

/** Signs in to the demo (any address, code 123456). */
export async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Authentication code' }).fill('123456');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation').first()).toBeVisible();
}

/** Opens a page of the demo, whose routes live in the URL fragment, and waits for it to settle. */
export async function open(page: Page, path: string) {
  await page.evaluate((hash) => (location.hash = hash), `#${path}`);
  await settle(page);
}

/** Waits until loading placeholders are gone and the main content has drawn. */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('[aria-busy="true"], .animate-pulse[aria-hidden]')).toHaveCount(0, { timeout: 10_000 });
}

/** The ID in the first link on a list page whose address matches, such as the first asset. */
export async function firstId(page: Page, list: string, pattern: RegExp): Promise<string> {
  await open(page, list);
  const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  const id = hrefs.map((h) => pattern.exec(h)?.[1]).find(Boolean);
  if (!id) throw new Error(`No link like ${pattern} on ${list}`);
  return id;
}

/** IDs of a sample client, asset, document and password, which the demo makes afresh on every load. */
export async function sampleIds(page: Page) {
  const uuid = '([0-9a-f-]{36})';
  return {
    client: await firstId(page, '/clients', new RegExp(`/clients/${uuid}`)),
    asset: await firstId(page, '/assets', new RegExp(`/assets/${uuid}`)),
    document: await firstId(page, '/documents', new RegExp(`/documents/${uuid}`)),
    password: await firstId(page, '/passwords', new RegExp(`/passwords/${uuid}`)),
  };
}
