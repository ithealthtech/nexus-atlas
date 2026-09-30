import type { FillResult, Login, Request, Response, State } from './messages.js';
import { atlasOrigin } from './protocol.js';

const main = document.getElementById('main')!;
const subtitle = document.getElementById('subtitle')!;
const title = document.getElementById('title')!;
const menu = document.getElementById('menu') as HTMLButtonElement;
const toastEl = document.getElementById('toast')!;

class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function ask<T>(request: Request): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  if (!response) throw new RequestError('The extension is starting. Try again.');
  if (!response.ok) throw new RequestError(response.error, response.code);
  return response.value;
}

type Child = Node | string | false | null | undefined;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child) el.append(child);
  return el;
}

let toastTimer: number | undefined;
function toast(message: string, error = false) {
  toastEl.textContent = message;
  toastEl.className = error ? 'error' : '';
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4000);
}

function show(...children: Child[]) {
  main.replaceChildren(...children.filter((c): c is Node | string => !!c));
}

// ---------- not set up ----------
function setupView(error = '') {
  menu.hidden = true;
  title.textContent = 'Atlas';
  subtitle.textContent = 'Fill logins from your vault';
  const input = h('input', { type: 'url', placeholder: 'https://atlas.example.com', required: true, autofocus: true });
  const form = h(
    'form',
    { className: 'grid' },
    h('label', { htmlFor: 'server' }, h('h2', {}, 'Atlas address')),
    input,
    error && h('p', { className: 'error' }, error),
    h('button', { className: 'primary', type: 'submit' }, 'Continue'),
  );
  input.id = 'server';
  form.style.display = 'grid';
  form.style.gap = '8px';
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const origin = atlasOrigin(input.value);
    if (!origin) return setupView('Enter an https address, like https://atlas.example.com.');
    // The browser asks the person to allow the extension to reach this one address.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) return setupView('The extension needs permission to reach your Atlas.');
    try {
      render(await ask<State>({ type: 'set-server', server: origin }));
    } catch (e) {
      setupView((e as Error).message);
    }
  });
  show(h('p', { className: 'muted' }, 'Enter the address you use to open Atlas. You sign in there, not here.'), form);
}

// ---------- signing in ----------
function signInView(state: State, error = '') {
  menu.hidden = true;
  title.textContent = 'Atlas';
  subtitle.textContent = new URL(state.server!).host;
  const start = h('button', { className: 'primary' }, 'Sign in through Atlas');
  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      render(await ask<State>({ type: 'start-pairing' }));
    } catch (e) {
      signInView(state, (e as Error).message);
    }
  });
  const change = h('button', { className: 'ghost' }, 'Use a different Atlas');
  change.addEventListener('click', async () => render(await ask<State>({ type: 'forget-server' })));
  show(
    h(
      'p',
      {},
      'Atlas opens in a new tab. Approve this browser there and the extension signs in. No password is typed here.',
    ),
    error && h('p', { className: 'error' }, error),
    h('div', { className: 'row' }, start, change),
  );
}

let pollTimer: number | undefined;
function pairingView(state: State) {
  menu.hidden = true;
  subtitle.textContent = new URL(state.server!).host;
  const open = h('button', { className: 'primary' }, 'Open Atlas');
  open.addEventListener('click', () => chrome.tabs.create({ url: state.pairing!.approveUrl }));
  const cancel = h('button', {}, 'Cancel');
  cancel.addEventListener('click', async () => render(await ask<State>({ type: 'cancel-pairing' })));
  show(
    h('h2', {}, 'Approve this browser in Atlas'),
    h('p', {}, 'Check that Atlas shows this code, then choose Allow.'),
    h('div', { className: 'code', ariaLabel: `Code ${state.pairing!.code.split('').join(' ')}` }, state.pairing!.code),
    h('p', { className: 'muted' }, 'If you didn’t start this, choose Cancel.'),
    h('div', { className: 'row' }, open, cancel),
  );
  clearTimeout(pollTimer);
  pollTimer = window.setTimeout(async () => render(await ask<State>({ type: 'state' })), 1500);
}

// ---------- signed in ----------
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url && /^https?:/.test(tab.url) ? tab.url : null;
  return { id: tab?.id, url };
}

/** Asks for a reason when the client requires one, inline under the login. */
function withReason(item: Login, row: HTMLElement, run: (reason: string) => Promise<void>) {
  return async () => {
    if (!item.requireReason) return run('').catch(onReasonRequired);
    askReason();
    function askReason() {
      if (row.querySelector('form')) return;
      const text = h('textarea', { placeholder: `Why do you need this? ${item.clientName} asks for a reason.` });
      const go = h('button', { className: 'primary', type: 'submit' }, 'Continue');
      const cancel = h('button', { type: 'button' }, 'Cancel');
      const form = h('form', {}, text, h('div', { className: 'actions' }, go, cancel));
      form.style.display = 'grid';
      form.style.gap = '6px';
      cancel.addEventListener('click', () => form.remove());
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!text.value.trim()) return toast('Enter a reason.', true);
        go.disabled = true;
        try {
          await run(text.value.trim());
          form.remove();
        } catch (e) {
          toast((e as Error).message, true);
          go.disabled = false;
        }
      });
      row.append(form);
      text.focus();
    }
    async function onReasonRequired(e: unknown) {
      // The client started requiring reasons after the list loaded.
      if (e instanceof RequestError && e.code === 'reason_required') {
        item.requireReason = true;
        return askReason();
      }
      toast((e as Error).message, true);
    }
  };
}

const FILL_MESSAGES: Record<FillResult, [string, boolean]> = {
  filled: ['Filled.', false],
  'username-only': ['Username filled. Continue to the password page, then fill again.', false],
  'password-only': ['Password filled.', false],
  'no-form': ['No login form was found on this page.', true],
  'wrong-site': ['The page changed. Open Atlas again to fill it.', true],
};

function loginRow(item: Login, tab: { id?: number; url: string | null }) {
  const row = h('li');
  const actions = h('div', { className: 'actions' });
  const button = (label: string, run: (reason: string) => Promise<void>, primary = false) => {
    const b = h('button', { className: primary ? 'primary' : '', type: 'button' }, label);
    b.addEventListener('click', withReason(item, row, run));
    actions.append(b);
  };
  if (item.match && tab.id !== undefined && tab.url)
    button(
      'Fill',
      async (reason) => {
        const result = await ask<FillResult>({ type: 'fill', tabId: tab.id!, url: tab.url!, id: item.id, reason });
        const [message, error] = FILL_MESSAGES[result];
        toast(message, error);
        if (result === 'filled' || result === 'password-only') window.setTimeout(() => window.close(), 600);
      },
      true,
    );
  button('Copy password', async (reason) => {
    const { value } = await ask<{ value: string }>({ type: 'copy', id: item.id, field: 'secret', reason });
    await navigator.clipboard.writeText(value);
    toast('Password copied.');
  });
  if (item.hasTotp)
    button('Copy code', async (reason) => {
      const { value, expiresIn } = await ask<{ value: string; expiresIn?: number }>({
        type: 'copy',
        id: item.id,
        field: 'totp',
        reason,
      });
      await navigator.clipboard.writeText(value);
      toast(expiresIn ? `Code copied. It changes in ${expiresIn} seconds.` : 'Code copied.');
    });
  if (item.username) {
    const copyUser = h('button', { type: 'button', className: 'ghost' }, 'Copy username');
    copyUser.addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.username);
      toast('Username copied.');
    });
    actions.append(copyUser);
  }
  row.append(
    h(
      'div',
      { className: 'item-title' },
      h('strong', { title: item.name }, item.name),
      item.match === 'domain' && h('span', { className: 'badge', title: item.url }, 'Same domain'),
    ),
    h('div', { className: 'item-meta', title: item.url }, [item.username, item.clientName].filter(Boolean).join(' · ')),
    actions,
  );
  return row;
}

async function signedInView(state: State) {
  const session = state.session!;
  title.textContent = session.organization.name;
  subtitle.textContent = session.user.email;
  menu.hidden = false;
  const tab = await activeTab();
  const host = tab.url ? new URL(tab.url).host : null;

  const matchList = h('ul', { className: 'list' });
  const matchSection = h(
    'section',
    {},
    h('h2', {}, host ? `For ${host}` : 'This page'),
    h('p', { className: 'muted' }, host ? 'Looking in Atlas…' : 'Open a website to see its logins.'),
  );
  const search = h('input', { type: 'search', placeholder: 'Search logins, usernames, clients', autofocus: true });
  search.setAttribute('aria-label', 'Search logins');
  const results = h('div');
  show(matchSection, search, results);
  matchSection.style.display = results.style.display = 'grid';
  matchSection.style.gap = results.style.gap = '6px';

  if (host && tab.url)
    ask<Login[]>({ type: 'matches', url: tab.url }).then(
      (logins) => {
        const note = matchSection.querySelector('p')!;
        if (!logins.length) note.textContent = 'No saved logins for this site. Search below to copy one.';
        else {
          note.remove();
          matchList.replaceChildren(...logins.map((l) => loginRow(l, tab)));
          matchSection.append(matchList);
        }
      },
      (e: Error) => {
        matchSection.querySelector('p')!.textContent = e.message;
        if (e instanceof RequestError && e.code === 'device_session') void refresh();
      },
    );

  let searchTimer: number | undefined;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      const query = search.value.trim();
      if (query.length < 2) return results.replaceChildren();
      try {
        const found = await ask<Login[]>({ type: 'search', query });
        if (search.value.trim() !== query) return;
        results.replaceChildren(
          found.length
            ? h('ul', { className: 'list' }, ...found.map((l) => loginRow({ ...l, match: null }, tab)))
            : h('p', { className: 'muted' }, 'Nothing found.'),
        );
      } catch (e) {
        results.replaceChildren(h('p', { className: 'error' }, (e as Error).message));
      }
    }, 250);
  });
}

// ---------- routing ----------
function render(state: State) {
  clearTimeout(pollTimer);
  if (!state.server) return setupView();
  if (state.session) return void signedInView(state);
  if (state.pairing) return pairingView(state);
  return signInView(state);
}

async function refresh() {
  try {
    render(await ask<State>({ type: 'state' }));
  } catch (e) {
    show(h('p', { className: 'error' }, (e as Error).message));
  }
}

menu.addEventListener('click', async () => {
  render(await ask<State>({ type: 'sign-out' }));
  toast('Signed out.');
});
void refresh();
