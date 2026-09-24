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
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => `${n.target} — ${n.failureSummary}`).join(', ')}`),
  ).toEqual([]);
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

  test('owner documents an asset from a template, edits it, and compares versions', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Clients');
    await page
      .getByRole('link', { name: /Harbor Dental Group/ })
      .first()
      .click();
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Assets' }).click();
    await page.getByRole('button', { name: 'Add asset' }).first().click();
    await page.getByRole('button', { name: /Configurations/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Name/).fill('HDG-FW-01');
    await dialog.getByLabel('Type').selectOption('Firewall');
    await dialog.getByLabel('IP address').fill('10.20.0.999');
    await dialog.getByRole('button', { name: 'Create asset' }).click();
    await expect(dialog.getByText(/must be an IP address/)).toBeVisible();
    await dialog.getByLabel('IP address').fill('10.20.0.1');
    await dialog.getByLabel('Management URL').fill('https://10.20.0.1');
    await accessible(page);
    await dialog.getByRole('button', { name: 'Create asset' }).click();
    await expect(page.getByRole('heading', { name: /HDG-FW-01/ })).toBeVisible();
    await expect(page.getByText('10.20.0.1', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('dialog').getByLabel('Serial number').fill('FGT60F-123');
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('FGT60F-123')).toBeVisible();
    await expect(page.getByText('Version 2', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Compare' }).click();
    await expect(page.getByRole('dialog').getByText('+ Serial number: FGT60F-123')).toBeVisible();
    await accessible(page);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();

    await page
      .getByLabel('Choose files to upload')
      .setInputFiles({ name: 'rack-diagram.txt', mimeType: 'text/plain', buffer: Buffer.from('Rack A, U12') });
    await expect(page.getByRole('link', { name: /rack-diagram\.txt/ }).first()).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/asset.png', fullPage: true });
  });

  test('owner writes a runbook, links it to the asset, and finds it with Ctrl+K', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Clients');
    await page
      .getByRole('link', { name: /Harbor Dental Group/ })
      .first()
      .click();
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Documents' }).click();
    await page.getByRole('button', { name: 'New document' }).first().click();
    await page.getByRole('button', { name: /Runbook \/ SOP/ }).click();
    await page.getByLabel('Title').fill('Internet outage response');
    const editor = page.getByRole('textbox', { name: 'Document content' });
    // Put the cursor at the end of the template, and confirm it's there before typing.
    await expect
      .poll(async () => {
        await editor.locator('p').last().click();
        await page.keyboard.press('End');
        return page.evaluate(() => window.getSelection()?.anchorNode?.textContent ?? '');
      })
      .toContain('who to tell');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Call the fiber carrier before rebooting the firewall.');
    await accessible(page);
    await page.getByRole('button', { name: 'Save document' }).click();
    await expect(page.getByRole('heading', { name: 'Internet outage response' })).toBeVisible();
    await expect(page.getByText('Call the fiber carrier before rebooting the firewall.')).toBeVisible();
    // The sentence went at the end, after the template's last section.
    await expect(page.getByRole('document', { name: 'Document content' }).locator('p').last()).toHaveText(
      'Call the fiber carrier before rebooting the firewall.',
    );

    await page.getByRole('button', { name: 'Link' }).click();
    await page.getByRole('dialog').getByPlaceholder('Type a name…').fill('HDG');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /HDG-FW-01/ })
      .click();
    await expect(page.getByRole('link', { name: /HDG-FW-01/ })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/document.png', fullPage: true });

    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('fiber carr');
    await expect(page.getByRole('option', { name: /Internet outage response/ })).toBeVisible();
    await page.getByRole('combobox').fill('10.20.0.1');
    await expect(page.getByRole('option', { name: /HDG-FW-01/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /HDG-FW-01/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Internet outage response/ })).toBeVisible();
  });

  test('admin adds a custom asset layout and writes an MSP knowledge-base article', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Asset layouts');
    await expect(page.getByText('SSL certificates')).toBeVisible();
    await page.getByRole('button', { name: 'New layout' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Door access');
    await dialog.getByRole('button', { name: 'Add field' }).click();
    await dialog.getByLabel('Field 1 label').fill('Panel model');
    await dialog.getByRole('button', { name: 'Add field' }).click();
    await dialog.getByLabel('Field 2 label').fill('Mode');
    await dialog.getByLabel('Field 2 type').selectOption('select');
    await dialog.getByLabel('Field 2 options').fill('Card, PIN, Mobile');
    await accessible(page);
    await dialog.getByRole('button', { name: 'Save layout' }).click();
    await expect(page.getByText('Door access')).toBeVisible();

    await nav(page, 'Knowledge base');
    await page.getByRole('button', { name: 'New document' }).first().click();
    await page.getByRole('button', { name: /Blank/ }).click();
    await page.getByLabel('Title').fill('Firewall hardening standard');
    await page.getByRole('textbox', { name: 'Document content' }).click();
    await page.keyboard.type('Disable unused services on every client firewall.');
    await page.getByRole('button', { name: 'Save document' }).click();
    await expect(page.getByText('MSP knowledge base').first()).toBeVisible();
  });

  test('owner stores a password, reveals it, rotates it, and shares a one-time link', async ({ page, browser }) => {
    watch(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Clients');
    await page
      .getByRole('link', { name: /Harbor Dental Group/ })
      .first()
      .click();
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Passwords' }).click();
    await page.getByRole('button', { name: 'Add password' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('HDG-FW-01 admin');
    await dialog.getByLabel('Username', { exact: true }).fill('fwadmin');
    await dialog.getByRole('button', { name: 'Generate' }).click();
    await dialog.getByRole('button', { name: 'Use', exact: true }).click();
    const generated = await dialog.getByLabel('Password', { exact: true }).inputValue();
    expect(generated.length).toBeGreaterThanOrEqual(24);
    await expect(dialog.getByText('Very strong')).toBeVisible();
    await dialog.getByLabel('Website or address').fill('https://10.20.0.1');
    await dialog.getByLabel(/Authenticator setup key/).fill('JBSWY3DPEHPK3PXP');
    await accessible(page);
    await dialog.getByRole('button', { name: 'Save to vault' }).click();
    await expect(page.getByRole('heading', { name: /HDG-FW-01 admin/ })).toBeVisible();
    await expect(page.getByText(generated)).toHaveCount(0);

    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(page.getByText(generated)).toBeVisible();
    await page.getByRole('button', { name: 'Copy password' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(generated);
    await page.getByRole('button', { name: 'Show code' }).click();
    await expect(page.getByText(/^\d{3} \d{3}/)).toBeVisible();
    await expect(page.getByText('Copied password').first()).toBeVisible();
    await accessible(page);

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('dialog').getByLabel('New password').fill('Replaced-Firewall-Passphrase-2026!');
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/Replaced by Avery Owner/)).toBeVisible();

    await page.getByRole('button', { name: 'Share' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Create link' }).click();
    const link = await page.getByRole('dialog').getByLabel('Share link').inputValue();
    expect(link).toMatch(/\/share\/[\w-]{32}#[\w-]{43}$/);
    await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('0 of 1 view used')).toBeVisible();
    // The recipient has no Atlas account.
    const outsider = await browser.newContext({ reducedMotion: 'reduce' });
    const recipient = await outsider.newPage();
    await recipient.goto(link);
    await expect(recipient.getByRole('heading', { name: 'Someone shared a password with you' })).toBeVisible();
    expect(recipient.url()).not.toContain('#');
    await recipient.getByRole('button', { name: 'Reveal the password' }).click();
    await expect(recipient.getByText('Replaced-Firewall-Passphrase-2026!')).toBeVisible();
    await expect(recipient.getByText(/used up/)).toBeVisible();
    await accessible(recipient);
    const again = await outsider.newPage();
    await again.goto(link);
    await again.getByRole('button', { name: 'Reveal the password' }).click();
    await expect(again.getByRole('alert')).toContainText('already been used');
    await outsider.close();
    await page.screenshot({ path: 'test-results/screens/password.png', fullPage: true });
  });

  test('a client can require reasons, and BitLocker keys are validated', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Clients');
    await page
      .getByRole('link', { name: /Harbor Dental Group/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Edit client' }).click();
    await page.getByRole('dialog').getByLabel('Require a reason to view passwords').check();
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Passwords' }).click();
    await page.getByRole('link', { name: /HDG-FW-01 admin/ }).click();
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(page.getByRole('heading', { name: 'Why do you need this password?' })).toBeVisible();
    await page.getByRole('dialog').getByLabel('Reason').fill('Ticket 4411 firmware update');
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Replaced-Firewall-Passphrase-2026!')).toBeVisible();
    await expect(page.getByText('Reason: Ticket 4411 firmware update')).toBeVisible();

    await page.getByRole('link', { name: /Harbor Dental Group · Passwords/ }).click();
    await page.getByRole('button', { name: 'Add password' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'BitLocker recovery key' }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('HDG-DC-01 · C:');
    await dialog.getByLabel('Recovery key', { exact: true }).fill('1234');
    await dialog.getByRole('button', { name: 'Save to vault' }).click();
    await expect(dialog.getByText(/8 groups of 6 digits/)).toBeVisible();
    await dialog
      .getByLabel('Recovery key', { exact: true })
      .fill('123456-234567-345678-456789-567890-678901-789012-890123');
    await dialog.getByRole('button', { name: 'Save to vault' }).click();
    await expect(page.getByText('BitLocker recovery key').first()).toBeVisible();
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
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Assets' }).click();
    await expect(page.getByRole('button', { name: 'Add asset' })).toHaveCount(0);
    await page.getByRole('link', { name: /HDG-FW-01/ }).click();
    await expect(page.getByText('FGT60F-123')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Choose files to upload')).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Internet outage response/ })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Knowledge base' }),
    ).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Passwords' })).toHaveCount(
      0,
    );
    await page.goto('/clients');
    await page
      .getByRole('link', { name: /Harbor Dental Group/ })
      .first()
      .click();
    await expect(
      page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Passwords' }),
    ).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('firewall');
    await expect(page.getByRole('option', { name: /HDG-FW-01/ })).toBeVisible();
    await expect(page.getByRole('option', { name: /hardening standard/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
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
