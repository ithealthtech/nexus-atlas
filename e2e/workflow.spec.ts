import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { totp, totpStep } from '../apps/server/src/identity/totp';
import { E2E } from '../playwright.config';

const OWNER = { name: 'Avery Owner', email: 'owner@atlas.test', password: 'correct horse battery 1' };
// Kept on disk as well as in memory: Playwright restarts the worker after a failure, and the tests that follow
// still need to sign in as the owner instead of all failing with it.
const SECRET_FILE = 'test-results/e2e-data/owner-mfa-secret';
let ownerSecret = '';
let recoveryCode = '';
const problems: string[] = [];

function watch(page: Page) {
  page.on('console', (m) => {
    // Rejected sign-ins and permission checks log 4xx responses by design; script errors and CSP violations are failures.
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
}
async function accessible(page: Page) {
  // Check the finished page: rows that arrive after the heading would otherwise be measured half-rendered.
  await page.waitForLoadState('networkidle');
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
    mkdirSync('test-results/e2e-data', { recursive: true });
    writeFileSync(SECRET_FILE, ownerSecret);
    await page.getByLabel(/Enter the 6-digit code/).fill(await freshCode(ownerSecret));
    await page.getByRole('button', { name: 'Turn on two-step verification' }).click();
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
    const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
    await expect(codes).toHaveCount(10);
    recoveryCode = await codes.first().innerText();
    await accessible(page);
    await page.getByRole('button', { name: 'Continue to Atlas' }).click();
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
    await editor.locator('p').last().click();
    await page.keyboard.press('End');
    await expect
      .poll(async () => {
        // Ask the editor itself, not the browser: ProseMirror catches up with a browser selection change a moment
        // later, and a key pressed before then goes to its old position (the start of the document).
        return page.evaluate(() => {
          type Pm = {
            state: {
              selection: {
                empty: boolean;
                $head: { parent: { textContent: string; content: { size: number } }; parentOffset: number };
              };
            };
          };
          const view = (document.querySelector('.ProseMirror') as unknown as { editor?: { view: Pm } }).editor?.view;
          const sel = view?.state.selection;
          if (!sel?.empty || sel.$head.parentOffset !== sel.$head.parent.content.size) return '';
          return sel.$head.parent.textContent;
        });
      })
      .toBe('How to confirm it worked, and who to tell.');
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
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');
    await page.getByLabel('Password').fill('temporary pass 1234');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
    // Client accounts only see passwords shared with them; none are yet, and names of others don't leak.
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Passwords' }).click();
    await expect(page.getByText('Nothing has been shared with you yet')).toBeVisible();
    await expect(page.getByText('HDG-FW-01 admin')).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Activity' }).click();
    await expect(page.getByText(/added a password/)).toHaveCount(0);
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

test.describe.serial('account security and administration', () => {
  test.setTimeout(90_000);

  test('owner signs in with a recovery code and remembers the browser', async ({ page }) => {
    watch(page);
    await page.goto('/');
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill(recoveryCode);
    await page.getByLabel('Remember this browser for 30 days').check();
    await accessible(page);
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

    await signOut(page);
    await page.getByLabel('Email').fill(OWNER.email);
    await page.getByLabel('Password').fill(OWNER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Remembered: no second step on this browser.
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
    await page.goto('/account');
    await expect(page.getByText('9 of 10 unused')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Remembered browsers' })).toBeVisible();
    await accessible(page);
  });

  test('owner adds a passkey and signs in with it alone', async ({ page }) => {
    watch(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Add passkey' }).click();
    await page.getByRole('dialog').getByLabel('Name').fill('Office laptop');
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('Passkey added.')).toBeVisible();
    await expect(page.getByText('Office laptop')).toBeVisible();
    await accessible(page);

    await page.context().clearCookies();
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  });

  test('admin sets up Microsoft 365 email, a group, and checks expirations and log integrity', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Settings');
    await page.getByLabel('Send email from Atlas').check();
    await page.getByLabel('Microsoft 365').check();
    await expect(page.getByLabel('SMTP server', { exact: true })).toHaveValue('smtp.office365.com');
    await expect(page.getByLabel('Port', { exact: true })).toHaveValue('587');
    await page.getByLabel('Username', { exact: true }).fill('atlas@itdonerightnc.test');
    await page.getByLabel('Password', { exact: true }).fill('app-password-for-smtp');
    await page.getByLabel('From address').fill('atlas@itdonerightnc.test');
    await page.getByRole('button', { name: 'Save email settings' }).click();
    await expect(page.getByText('Email settings saved')).toBeVisible();
    await expect(page.getByText('Saved and encrypted. Leave empty to keep it.')).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/settings.png', fullPage: true });

    await nav(page, 'Groups');
    await page.getByRole('button', { name: 'New group' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('Tier 1 helpdesk');
    await dialog.getByLabel('Group access to Harbor Dental Group').selectOption('read');
    await accessible(page);
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByText('Tier 1 helpdesk')).toBeVisible();
    await expect(page.getByText('Harbor Dental Group · Read')).toBeVisible();
    await accessible(page);

    await nav(page, 'Expirations');
    await expect(page.getByRole('heading', { name: 'Expirations' })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/expirations.png', fullPage: true });

    await nav(page, 'Security log');
    await page.getByRole('button', { name: 'Verify now' }).click();
    await expect(page.getByText('Intact.')).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/security.png' });

    await page.goto('/account');
    await page.screenshot({ path: 'test-results/screens/account.png', fullPage: true });

    // With email on, the sign-in page offers a reset link.
    await page.context().clearCookies();
    await page.goto('/');
    await page.getByRole('button', { name: 'Forgot your password?' }).click();
    await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
    await accessible(page);
    await page.goto('/reset-password');
    await expect(page.getByRole('heading', { name: 'This link is incomplete' })).toBeVisible();
  });

  test.afterAll(() => {
    expect(problems).toEqual([]);
  });
});

test.describe.serial('data in and out, and the client portal', () => {
  test.setTimeout(90_000);

  test('admin imports a CSV, creates an API key, brands Atlas, and exports a client', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Import & export');
    await expect(page.getByRole('heading', { name: 'Import & export' })).toBeVisible();
    await page.getByLabel('CSV file').setInputFiles({
      name: 'clients.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Client Name,Type,Notes\nCedar Ridge Credit Union,Customer,"Credit union, 4 branches"\n'),
    });
    await expect(page.getByText('clients.csv: 1 row.')).toBeVisible();
    await page.getByRole('button', { name: 'Check the file' }).click();
    await expect(page.getByText('1 row ready to import.')).toBeVisible();
    await accessible(page);
    await page.getByRole('button', { name: 'Import 1 row' }).click();
    await expect(page.getByText('Imported: 1 new, 0 updated.')).toBeVisible();

    await nav(page, 'Settings');
    await page.getByRole('button', { name: 'New key' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name').fill('ConnectWise sync');
    await dialog.getByRole('button', { name: 'Create key' }).click();
    await expect(dialog.getByText(/^atlas_[A-Za-z0-9]{10}_/)).toBeVisible();
    await accessible(page);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('ConnectWise sync')).toBeVisible();

    await page.getByLabel('Accent colour').fill('#1d4ed8');
    await page.getByRole('button', { name: 'Save branding' }).click();
    await expect(page.getByText('Branding saved.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--primary'))).toBe('#1d4ed8');
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/settings-branding.png', fullPage: true });

    await nav(page, 'Clients');
    await page.getByRole('link', { name: /Harbor Dental Group/ }).click();
    await page.getByRole('button', { name: 'Export' }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download zip' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^atlas-Harbor-Dental-Group-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  test('admin makes a backup and reviews system status', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'System status');
    await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();
    await expect(page.getByText('No backup yet')).toBeVisible();
    await page.getByRole('button', { name: 'Back up now' }).click();
    await expect(page.getByText('Backups are current')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('table', { name: 'Backup history' }).getByText('Done')).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/status.png', fullPage: true });
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /^Download backup from/ }).click(),
    ]);
    expect(file.suggestedFilename()).toMatch(/^atlas-\d{8}-\d{6}\.atlasbak$/);
  });

  test('a client viewer sees the passwords shared with their client, read-only', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Passwords');
    await page
      .getByRole('link', { name: /HDG-FW-01 admin/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('dialog').getByLabel("Share with the client's own accounts").check();
    await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Shared with client')).toBeVisible();

    await page.context().clearCookies();
    await page.goto('/');
    await page.getByLabel('Email').fill('morgan@harbor.test');
    await page.getByLabel('Password').fill('harbor reader pass 7');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Your documentation, kept by our team.')).toBeVisible();
    await nav(page, 'Clients');
    await page.getByRole('link', { name: /Harbor Dental Group/ }).click();
    await page.getByRole('navigation', { name: 'Client sections' }).getByRole('link', { name: 'Passwords' }).click();
    await page.getByRole('link', { name: /HDG-FW-01 admin/ }).click();
    await expect(page.getByRole('heading', { name: /HDG-FW-01 admin/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Show password' }).click();
    // Harbor requires a reason for every reveal, including by its own contacts.
    await page.getByRole('dialog').getByLabel('Reason').fill('Setting up the new office printer');
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Hide password' })).toBeVisible();
    await accessible(page);
    await page.screenshot({ path: 'test-results/screens/portal-password.png', fullPage: true });
  });

  test.afterAll(() => {
    expect(problems).toEqual([]);
  });
});

test.describe.serial('accessibility sweep', () => {
  test.setTimeout(180_000);

  test('every screen passes WCAG 2.2 AA checks in light, dark, and phone layouts', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    await nav(page, 'Clients');
    await page.getByRole('link', { name: /Harbor Dental Group/ }).click();
    const client = new URL(page.url()).pathname;
    const screens = [
      '/',
      '/clients',
      client,
      `${client}/assets`,
      `${client}/documents`,
      `${client}/passwords`,
      `${client}/contacts`,
      `${client}/locations`,
      `${client}/activity`,
      '/assets',
      '/documents',
      '/passwords',
      '/expirations',
      '/account',
      '/admin/users',
      '/admin/groups',
      '/admin/layouts',
      '/admin/security',
      '/admin/data',
      '/admin/status',
      '/admin/updates',
      '/admin/settings',
    ];
    for (const theme of ['light', 'dark'] as const) {
      // Choose the theme the way a person does (it's saved and applied as each page loads), rather than
      // flipping the class after load, which raced with rows still rendering in the other theme's colours.
      await page.evaluate((t) => localStorage.setItem('atlas-theme', t), theme);
      for (const path of screens) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/);
        await accessible(page);
      }
    }
    await page.evaluate(() => localStorage.removeItem('atlas-theme'));
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['/', client, `${client}/passwords`, '/admin/status', '/admin/settings']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), path).toBeLessThanOrEqual(0);
      await accessible(page);
    }
  });

  test('works from the keyboard alone', async ({ page }) => {
    watch(page);
    await signIn(page, OWNER.email, OWNER.password, ownerSecret);
    // The first Tab reaches the skip link, which moves focus past the navigation.
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    expect(
      await page.evaluate(() => document.activeElement?.closest('main') !== null || location.hash === '#main'),
    ).toBe(true);
    // Ctrl+K opens search, results can be chosen with the arrow keys, and Escape returns focus.
    await page.keyboard.press('Control+k');
    const search = page.getByRole('dialog');
    await expect(search).toBeVisible();
    await page.keyboard.type('Harbor');
    await expect(search.getByText('Harbor Dental Group').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Harbor Dental Group' })).toBeVisible();
    // Dialogs open from the keyboard, keep focus inside, and give it back when closed.
    const edit = page.getByRole('button', { name: 'Edit client' });
    await edit.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    // A native modal <dialog> makes the page behind it unreachable. Tab moves through the dialog, then out to the
    // browser's own controls (the page sees <body>), then back in. Focus must never land on the page behind it.
    let insideDialog = 0;
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active || active === document.body) return 'browser';
        return active.closest('dialog[open]') ? 'dialog' : `page: ${active.outerHTML.slice(0, 80)}`;
      });
      expect(['dialog', 'browser']).toContain(where);
      if (where === 'dialog') insideDialog++;
    }
    expect(insideDialog).toBeGreaterThan(5);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(edit).toBeFocused();
  });

  test.afterAll(() => {
    expect(problems).toEqual([]);
  });
});

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Atlas' })).toBeVisible();
}

// Each code works once, like a real authenticator: wait for an unused time step when needed.
// The last step used is kept on disk too: a restarted worker must not reuse a code the server already accepted.
const STEP_FILE = 'test-results/e2e-data/last-totp-step';
let lastStep = totpStep();
async function freshCode(secret: string) {
  if (existsSync(STEP_FILE)) lastStep = Math.max(lastStep, Number(readFileSync(STEP_FILE, 'utf8')));
  const step = Math.max(totpStep() - 1, lastStep + 1);
  while (step > totpStep() + 1) await new Promise((r) => setTimeout(r, 500));
  lastStep = step;
  mkdirSync('test-results/e2e-data', { recursive: true });
  writeFileSync(STEP_FILE, String(step));
  return totp(secret, step);
}

async function signIn(page: Page, email: string, password: string, given: string) {
  const secret = given || (email === OWNER.email && existsSync(SECRET_FILE) ? readFileSync(SECRET_FILE, 'utf8') : '');
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Authentication code').fill(await freshCode(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
}

const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
