// Messages between the popup and the service worker. Only the service worker talks to Atlas and holds the device
// key; the popup asks it for what it needs.

/** A login offered for this site or found by search. Mirrors DeviceLoginView on the server. */
export interface Login {
  id: string;
  name: string;
  username: string;
  url: string;
  clientId: string;
  clientName: string;
  hasTotp: boolean;
  requireReason: boolean;
  match: 'exact' | 'domain' | null;
}

export interface State {
  server: string | null;
  /** Set while waiting for the person to approve this browser in Atlas. */
  pairing: { code: string; expiresAt: string; approveUrl: string } | null;
  session: {
    user: { name: string; email: string };
    organization: { name: string };
    device: { id: string; name: string; expiresAt: string };
  } | null;
}

export type Request =
  | { type: 'state' }
  | { type: 'set-server'; server: string }
  | { type: 'forget-server' }
  | { type: 'start-pairing' }
  | { type: 'cancel-pairing' }
  | { type: 'sign-out' }
  | { type: 'matches'; url: string }
  | { type: 'search'; query: string }
  | { type: 'fill'; tabId: number; url: string; id: string; reason: string }
  | { type: 'copy'; id: string; field: 'secret' | 'totp'; reason: string };

export type FillResult = 'filled' | 'username-only' | 'password-only' | 'no-form' | 'wrong-site';

export type Response<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };
