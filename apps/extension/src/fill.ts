import type { FillResult } from './messages.js';

/**
 * Runs inside the page (chrome.scripting.executeScript serializes it), so it must not use anything from outside the
 * function. It fills only when the page is still on the origin the login was matched against: if the tab navigated
 * after the popup opened, nothing is filled.
 */
export function fillLogin(expectedOrigin: string, username: string, password: string): FillResult {
  if (location.origin !== expectedOrigin) return 'wrong-site';

  const visible = (el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const usable = Array.from(document.querySelectorAll('input')).filter(
    (el) => !el.disabled && !el.readOnly && visible(el),
  );
  const passwordField = usable.find((el) => el.type === 'password');
  const textLike = usable.filter((el) => ['text', 'email', 'tel', ''].includes(el.getAttribute('type') ?? ''));
  const named = (el: HTMLInputElement) =>
    /user|login|email|account|name|logon/i.test(`${el.name} ${el.id} ${el.getAttribute('aria-label') ?? ''}`);

  // The username field: one marked as such, else the text field just before the password (in the same form when
  // there is one), else a field that looks like a username on a page with no password field yet.
  let usernameField = textLike.find((el) => /username|email/.test(el.autocomplete));
  if (!usernameField && passwordField) {
    const before = textLike.filter(
      (el) =>
        (!passwordField.form || el.form === passwordField.form) &&
        el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    usernameField = before[before.length - 1];
  }
  if (!usernameField && !passwordField) usernameField = textLike.find(named);

  const setValue = (el: HTMLInputElement, value: string) => {
    el.focus();
    // Frameworks like React track the value through the prototype's setter, so set it the same way.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (usernameField && username) setValue(usernameField, username);
  if (passwordField) setValue(passwordField, password);
  if (passwordField && usernameField) return 'filled';
  if (passwordField) return 'password-only';
  if (usernameField) return 'username-only';
  return 'no-form';
}
