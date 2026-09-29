import { fillLogin } from './fill.js';
import type { FillResult, Login, Request, Response, State } from './messages.js';
import { atlasOrigin, base64url, signRequest } from './protocol.js';

// ---------- what the browser keeps ----------
// Never a password or code: only the Atlas address, the device session token, and the device's signing key. The key's
// private half is created non-extractable, so it can sign but can't be read out, even by this extension.

interface Stored {
  server?: string;
  token?: string;
  session?: State['session'];
  pairing?: { id: string; code: string; expiresAt: string };
  clockOffset?: number;
}

const load = () => chrome.storage.local.get(null) as Promise<Stored>;
const save = (values: Partial<Stored>) => chrome.storage.local.set(values);
const drop = (...keys: (keyof Stored)[]) => chrome.storage.local.remove(keys);

const DB = 'atlas-device';
const STORE = 'keys';
function keyStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function keyOp<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await keyStore();
  return new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  }).finally(() => db.close());
}
const loadKey = () => keyOp<CryptoKeyPair | undefined>('readonly', (s) => s.get('device'));
const saveKey = (pair: CryptoKeyPair) => keyOp<unknown>('readwrite', (s) => s.put(pair, 'device'));
const deleteKey = () => keyOp<unknown>('readwrite', (s) => s.delete('device'));

/** A fresh key for each sign-in, so signing out leaves nothing a later session could use. */
async function newKey(): Promise<CryptoKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  await saveKey(pair);
  return pair;
}

// ---------- talking to Atlas ----------
class AtlasError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, options: { signed?: boolean } = {}): Promise<T> {
  const stored = await load();
  if (!stored.server) throw new AtlasError('Enter your Atlas address first.');
  const text = body === undefined ? '' : JSON.stringify(body);
  const send = async () => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (text) headers['Content-Type'] = 'application/json';
    if (options.signed !== false) {
      const pair = await loadKey();
      if (!pair) throw new AtlasError('Sign in to Atlas again.', 'device_session');
      if (stored.token) headers.Authorization = `AtlasDevice ${stored.token}`;
      const now = Date.now() + ((await load()).clockOffset ?? 0);
      Object.assign(headers, await signRequest(pair.privateKey, { method, path, body: text, now }));
    }
    try {
      return await fetch(`${stored.server}${path}`, {
        method,
        headers,
        body: text || undefined,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch {
      throw new AtlasError('Atlas could not be reached. Check your connection and the Atlas address.');
    }
  };
  let response = await send();
  let data = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
  // This computer's clock is off: line up with Atlas's and try once more.
  if (response.status === 401 && data?.code === 'device_clock') {
    const serverTime = Date.parse(response.headers.get('date') ?? '');
    if (!Number.isNaN(serverTime)) {
      await save({ clockOffset: serverTime - Date.now() });
      response = await send();
      data = (await response.json().catch(() => null)) as typeof data;
    }
  }
  if (!response.ok) {
    if (response.status === 401 && data?.code === 'device_session') await signedOut();
    throw new AtlasError(data?.error ?? 'Atlas refused the request.', data?.code, response.status);
  }
  return data as T;
}

async function signedOut() {
  await drop('token', 'session');
  await deleteKey().catch(() => undefined);
}

// ---------- signing in ----------
function deviceName(): string {
  const data = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[]; platform: string } })
    .userAgentData;
  const brands = data?.brands.map((b) => b.brand) ?? [];
  const browser =
    ['Microsoft Edge', 'Google Chrome', 'Brave', 'Opera', 'Vivaldi'].find((b) => brands.includes(b)) ?? 'Browser';
  return data?.platform ? `${browser} on ${data.platform}` : browser;
}

async function startPairing(): Promise<State> {
  await signedOut();
  const pair = await newKey();
  const publicKey = base64url(await crypto.subtle.exportKey('spki', pair.publicKey));
  const pairing = await call<{ id: string; code: string; expiresAt: string }>(
    'POST',
    '/api/device/pair',
    { kind: 'browser_extension', name: deviceName(), publicKey },
    { signed: false },
  );
  await save({ pairing });
  const state = await currentState();
  await chrome.tabs.create({ url: state.pairing!.approveUrl });
  void poll();
  return state;
}

let polling = false;
/** Waits for the person to approve this browser in Atlas, then collects the session. */
async function poll() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const { pairing } = await load();
      if (!pairing) return;
      if (Date.parse(pairing.expiresAt) < Date.now()) {
        await drop('pairing');
        return;
      }
      try {
        const result = await call<
          { status: 'pending' } | { status: 'approved'; token: string; session: State['session'] }
        >('POST', `/api/device/pair/${pairing.id}/session`, {});
        if (result.status === 'approved') {
          await save({ token: result.token, session: result.session });
          await drop('pairing');
          return;
        }
      } catch (error) {
        // Denied or expired: start again. Network trouble: keep waiting.
        if (error instanceof AtlasError && error.status >= 400 && error.status < 500) {
          await drop('pairing');
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    polling = false;
  }
}

async function currentState(): Promise<State> {
  const stored = await load();
  return {
    server: stored.server ?? null,
    pairing: stored.pairing
      ? {
          code: stored.pairing.code,
          expiresAt: stored.pairing.expiresAt,
          approveUrl: `${stored.server}/apps/connect?code=${encodeURIComponent(stored.pairing.code)}`,
        }
      : null,
    session: stored.token ? (stored.session ?? null) : null,
  };
}

// ---------- the popup's requests ----------
async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case 'state': {
      const state = await currentState();
      if (state.pairing) void poll();
      return state;
    }
    case 'set-server': {
      const server = atlasOrigin(request.server);
      if (!server) throw new AtlasError('Enter the Atlas address, like https://atlas.example.com.');
      if (!(await chrome.permissions.contains({ origins: [`${server}/*`] })))
        throw new AtlasError('Allow the extension to reach this Atlas address.');
      await signedOut();
      await drop('pairing');
      await save({ server, clockOffset: 0 });
      return currentState();
    }
    case 'forget-server':
      await call('DELETE', '/api/device/session').catch(() => undefined);
      await signedOut();
      await drop('pairing', 'server');
      return currentState();
    case 'start-pairing':
      return startPairing();
    case 'cancel-pairing':
      await drop('pairing');
      return currentState();
    case 'sign-out':
      await call('DELETE', '/api/device/session').catch(() => undefined);
      await signedOut();
      return currentState();
    case 'matches':
      return call<Login[]>('GET', `/api/device/logins?url=${encodeURIComponent(request.url)}`);
    case 'search':
      return call<Login[]>('GET', `/api/device/logins/search?q=${encodeURIComponent(request.query)}`);
    case 'fill': {
      // The password goes straight from Atlas into the page; the popup never sees it.
      const origin = new URL(request.url).origin;
      const { username, password } = await call<{ username: string; password: string }>(
        'POST',
        `/api/device/logins/${encodeURIComponent(request.id)}/fill`,
        { url: request.url, reason: request.reason },
      );
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: request.tabId },
        func: fillLogin,
        args: [origin, username, password],
      });
      return (result?.result ?? 'no-form') as FillResult;
    }
    case 'copy':
      return call<{ value: string; expiresIn?: number }>(
        'POST',
        `/api/device/logins/${encodeURIComponent(request.id)}/copy`,
        { field: request.field, reason: request.reason },
      );
  }
}

chrome.runtime.onMessage.addListener((request: Request, sender, respond: (r: Response<unknown>) => void) => {
  // Only this extension's own pages may ask.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  handle(request).then(
    (value) => respond({ ok: true, value }),
    (error: unknown) =>
      respond({
        ok: false,
        error: error instanceof Error ? error.message : 'Something went wrong.',
        code: error instanceof AtlasError ? error.code : undefined,
      }),
  );
  return true;
});

// A sign-in that was waiting when the browser closed picks up where it left off.
chrome.runtime.onStartup.addListener(() => void poll());
