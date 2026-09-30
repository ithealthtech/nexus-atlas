import { z } from 'zod';

// ---------- native apps (Atlas for Windows) ----------
// Native apps sign in through the system browser with an authorization code, PKCE (S256), and a loopback redirect
// (RFC 8252), and get a revocable app session. They are public clients: nothing about them is secret.
export const NATIVE_CLIENTS = {
  'atlas-windows': { name: 'Atlas for Windows' },
} as const;
export type NativeClientId = keyof typeof NATIVE_CLIENTS;

export const APP_SCOPES = ['read', 'write', 'reveal'] as const;
export type AppScope = (typeof APP_SCOPES)[number];
export const APP_SCOPE_LABELS: Record<AppScope, string> = {
  read: 'Search and read clients, assets, documents, and password entries you can see',
  write: 'Create and change documentation',
  reveal: 'Copy passwords and one-time codes (recorded like a reveal in the browser)',
};

/** How long an app session lasts: 30 days without use, and 90 days at most before signing in again. */
export const APP_SESSION_LIMITS = { idleDays: 30, absoluteDays: 90, perUser: 10 } as const;

/**
 * A loopback redirect: http, an IP literal (never "localhost", which DNS or a hosts file could point elsewhere), an
 * explicit port, and no credentials, query, or fragment.
 */
export function isLoopbackRedirect(value: string): boolean {
  if (value.length > 200) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
    !!url.port &&
    Number(url.port) >= 1024 &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    !value.includes('?') &&
    !value.includes('#')
  );
}

const scopeList = z
  .string()
  .trim()
  .max(100)
  .default('read')
  .transform((v) => [...new Set(v.split(/\s+/).filter(Boolean))])
  .pipe(
    z
      .array(z.enum(APP_SCOPES, { message: 'The app asked for a permission Atlas does not know.' }))
      .min(1)
      .refine((s) => s.includes('read'), 'The app must ask to read.'),
  );

/** The authorization request, as the app puts it in the sign-in address. */
export const nativeAuthorizeSchema = z.object({
  client_id: z.enum(Object.keys(NATIVE_CLIENTS) as [NativeClientId], {
    message: 'This sign-in link is not from an app Atlas knows.',
  }),
  redirect_uri: z.string().refine(isLoopbackRedirect, 'This sign-in link does not return to an app on this computer.'),
  response_type: z.literal('code', { message: 'This sign-in link is not valid.' }).default('code'),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'This sign-in link is missing its PKCE challenge.'),
  code_challenge_method: z.literal('S256', { message: 'The app must use S256 PKCE.' }),
  state: z.string().regex(/^[A-Za-z0-9._~-]{16,200}$/, 'This sign-in link is missing its state.'),
  scope: scopeList,
  // What the app calls this computer, shown on the consent screen and the Account page.
  device_name: z
    .string()
    .trim()
    .default('')
    .transform((v) => v.replace(/[\p{C}]/gu, '').slice(0, 60) || 'Windows PC'),
});
export type NativeAuthorizeRequest = z.infer<typeof nativeAuthorizeSchema>;
export const nativeDecisionSchema = nativeAuthorizeSchema.extend({ approve: z.boolean() });

/** The token request the app makes after the browser hands it the code. */
export const nativeTokenSchema = z.object({
  grant_type: z.literal('authorization_code'),
  client_id: z.enum(Object.keys(NATIVE_CLIENTS) as [NativeClientId]),
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  redirect_uri: z.string().max(200),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});

export interface NativeTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  scope: string;
  /** Seconds until the session ends if it is never used; each use extends it, up to the 90-day limit. */
  expires_in: number;
  session_id: string;
  user: { name: string; email: string };
}

/** One signed-in app on the Account page. */
export interface AppSessionView {
  id: string;
  client: string;
  deviceName: string;
  scopes: AppScope[];
  ip: string;
  createdAt: string;
  lastSeenAt: string;
}
