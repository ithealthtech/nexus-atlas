import { expect, test, type Page } from '@playwright/test';
import { fillLogin } from '../apps/extension/src/fill';

// The browser extension's fill runs inside the page, the way chrome.scripting.executeScript runs it. These pages are
// served at their own origins by the test, so nothing leaves the machine.
async function site(page: Page, origin: string, body: string) {
  await page.route(`${origin}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>${body}</body></html>` }),
  );
  await page.goto(`${origin}/login`);
}
// Passed as source, as the extension's scripting call does: the function can't reach anything outside itself.
const fill = (page: Page, origin: string) =>
  page.evaluate(({ source, args }) => (new Function(`return (${source})`)() as (...a: string[]) => string)(...args), {
    source: fillLogin.toString(),
    args: [origin, 'fwadmin', 'Correct-Horse-Battery-9!'],
  });

test.describe('browser extension fill', () => {
  test('fills the username and password of a login form, and tells frameworks', async ({ page }) => {
    await site(
      page,
      'https://portal.harbor-dental.test',
      `<form>
        <input type="hidden" name="csrf" value="x">
        <input type="search" placeholder="Search the site">
        <input name="q" style="display:none">
        <input type="email" name="user" autocomplete="username">
        <input type="password" name="pass">
        <button>Sign in</button>
      </form>
      <script>
        window.events = [];
        for (const el of document.querySelectorAll('input'))
          el.addEventListener('input', () => window.events.push(el.name));
      </script>`,
    );
    expect(await fill(page, 'https://portal.harbor-dental.test')).toBe('filled');
    await expect(page.locator('[name=user]')).toHaveValue('fwadmin');
    await expect(page.locator('[name=pass]')).toHaveValue('Correct-Horse-Battery-9!');
    await expect(page.locator('[name=q]')).toHaveValue('');
    expect(await page.evaluate(() => (window as unknown as { events: string[] }).events)).toEqual(['user', 'pass']);
  });

  test('picks the text field just before the password when nothing is labelled', async ({ page }) => {
    await site(
      page,
      'https://10.20.0.1',
      `<input id="search" type="text">
      <form><input id="login" type="text"><input id="pw" type="password"></form>`,
    );
    expect(await fill(page, 'https://10.20.0.1')).toBe('filled');
    await expect(page.locator('#login')).toHaveValue('fwadmin');
    await expect(page.locator('#search')).toHaveValue('');
  });

  test('fills the username on the first step of a two-step sign-in', async ({ page }) => {
    await site(page, 'https://login.harbor-dental.test', `<input type="email" name="loginfmt"><button>Next</button>`);
    expect(await fill(page, 'https://login.harbor-dental.test')).toBe('username-only');
    await expect(page.locator('[name=loginfmt]')).toHaveValue('fwadmin');
  });

  test('fills nothing when the page is no longer the site the login was matched to', async ({ page }) => {
    await site(page, 'https://evil.harbor-dental.test', `<input type="text" name="u"><input type="password" name="p">`);
    expect(await fill(page, 'https://portal.harbor-dental.test')).toBe('wrong-site');
    await expect(page.locator('[name=p]')).toHaveValue('');
  });

  test('reports a page without a login form', async ({ page }) => {
    await site(page, 'https://portal.harbor-dental.test', `<p>Welcome back</p><input type="checkbox">`);
    expect(await fill(page, 'https://portal.harbor-dental.test')).toBe('no-form');
  });
});
