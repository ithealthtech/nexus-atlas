import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { totp, totpStep } from '../apps/server/src/identity/totp';
import { E2E } from '../playwright.config';

const OWNER = { name: 'Avery Owner', email: 'owner@atlas.test', password: 'correct horse battery 1' };
let ownerSecret = '';
const problems: string[] = [];

function watch(page: Page) {
  page.on('console', (m) => {
    // Rejected sign-ins and permission checks log 4xx responses by design; script errors and CSP violations are failures.
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
}
async function accessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
}
async function mfaSecretFrom(page: Page) {
  const key = await page.getByText(/^([A-Z2-7]{4} )+[A-Z2-7]{1,4}$/).innerText();
  return key.replace(/\s/g, '');
}

test.describe.serial('first run to restricted client access', () => {
  test.setTimeout(90_000);
  test('owner completes setup and turns on MFA', async ({ page }) => {
    watch(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to Atlas' })).toBeVisible();
    await accessible(page);
    await page.getByLabel('Setup code').fill('wrong-code-000000');
    await page.getByLabel('Company name').fill('IT Done Right');
    await page.getByLabel('Your name').fill(OWNER.name);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Create owner account' }).click();
    await expect(page.getByRole('alert')).toContainText('setup code is incorrect');
    await page.getByLabel('Setup code').fill(E2E.setupCode);
    await page.getByRole('button', { name: 'Create owner account' }).click();
    await expect(page.getByRole('heading', { name: 'Protect your account' })).toBeVisible();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    ownerSecret = await mfaSecretFrom(page);
    await page.getByLabel(/Enter the 6-digit code/).fill(totp(ownerSecret));
    await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), Avery/ })).toBeVisible();
    await accessible(page);
  });

  test('owner adds clients and a client viewer', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Clients');
    for (const name of ['Harbor Dental Group', 'Northline Architecture']) {
      await page.getByRole('button', { name: 'Add client' }).first().click();
      await page.getByLabel('Client name').fill(name);
      await page.getByRole('button', { name: 'Create client' }).click();
      await expect(page.getByRole('heading', { name })).toBeVisible();
      await nav(page, 'Clients');
    }
    await expect(page.getByRole('link', { name: /Northline Architecture/ })).toBeVisible();
    await accessible(page);

    await nav(page, 'People & access');
    await page.getByRole('button', { name: 'Add person' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Morgan Ellis');
    await dialog.getByLabel('Email').fill('morgan@harbor.test');
    await dialog.getByLabel(/Client viewer/).check();
    await dialog.getByLabel('Access to Harbor Dental Group').selectOption('read');
    await dialog.getByLabel('Temporary password').fill('temporary pass 1234');
    await accessible(page);
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('cell', { name: /Morgan Ellis/ })).toBeVisible();
    await expect(page.getByText('Harbor Dental Group · Read')).toBeVisible();
    await nav(page, 'Security log');
    await expect(page.getByText('User created').first()).toBeVisible();
    await nav(page, 'People & access');
    await expect(page.getByRole('cell', { name: /Morgan Ellis/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dismiss' })).toHaveCount(0, { timeout: 10_000 });
    await page.screenshot({ path: 'test-results/screens/people.png' });
    await nav(page, 'Dashboard');
    await expect(page.getByText('Recently updated clients')).toBeVisible();
    await page.screenshot({ path: 'test-results/screens/dashboard.png' });
  });

  test('client viewer replaces the temporary password and sees only Harbor, read-only', async ({ page }) => {
    watch(page);
    await page.goto('/');
    await page.getByLabel('Email').fill('morgan@harbor.test');
    await page.getByLabel('Password').fill('wrong password here');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');
    await page.getByLabel('Password').fill('temporary pass 1234');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
    await page.getByLabel('Temporary password').fill('temporary pass 1234');
    await page.getByLabel('New password').fill('harbor reader pass 7');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByRole('heading', { name: /Morgan/ })).toBeVisible();
    await nav(page, 'Clients');
    await expect(page.getByRole('link', { name: /Harbor Dental Group/ })).toBeVisible();
    await expect(page.getByText('Northline Architecture')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add client' })).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'People & access' }),
    ).toHaveCount(0);
    await page.getByRole('link', { name: /Harbor Dental Group/ }).click();
    await expect(page.getByRole('button', { name: 'Edit client' })).toHaveCount(0);
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'Administrators only' })).toBeVisible();
  });

  test('works in dark mode and at phone width', async ({ page }) => {
    watch(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.keyboard.press('Escape');
    await nav(page, 'Clients');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/mobile-dark.png', fullPage: true });
  });

  test.afterAll(() => {
    expect(problems).toEqual([]);
  });
});

// Each code works once, like a real authenticator: wait for an unused time step when needed.
let lastStep = totpStep();
async function freshCode(secret: string) {
  const step = Math.max(totpStep() - 1, lastStep + 1);
  while (step > totpStep() + 1) await new Promise((r) => setTimeout(r, 500));
  lastStep = step;
  return totp(secret, step);
}

async function signIn(page: Page, email: string, password: string, secret: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Authentication code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
