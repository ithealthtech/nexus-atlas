import { z } from 'zod';

// Apps a person signs in to through Atlas on one device, such as the browser extension.
export const DEVICE_KINDS = ['browser_extension'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
export const DEVICE_KIND_LABELS: Record<DeviceKind, string> = { browser_extension: 'Browser extension' };

/** A device asking to sign in: its name and the public half of its P-256 signing key (SPKI, base64url). */
export const devicePairSchema = z.object({
  kind: z.enum(DEVICE_KINDS),
  name: z.string().trim().min(1, 'Name the device.').max(80),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{100,200}$/, 'Send the device key as base64url SPKI.'),
});

/** The request the approval page shows, so the person can check it's theirs. */
export interface DevicePairingView {
  code: string;
  kind: DeviceKind;
  name: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
}

/** A signed-in app on the account page. */
export interface ConnectedAppView {
  id: string;
  kind: DeviceKind;
  name: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** What a device sees about its own session. */
export interface DeviceSessionInfo {
  user: { name: string; email: string };
  organization: { name: string };
  device: { id: string; name: string; expiresAt: string };
}

/** A login offered by the extension. `match` says how its address matches the page (null in search results). */
export interface DeviceLoginView {
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

export const deviceFillSchema = z.object({
  // The page being filled; the login's address must match it.
  url: z.string().trim().min(1).max(2048),
  reason: z.string().trim().max(300).default(''),
});
export const deviceCopySchema = z.object({
  field: z.enum(['secret', 'totp']),
  reason: z.string().trim().max(300).default(''),
});

/**
 * The text a device signs for each request. The extension builds the same string (apps/extension/src/protocol.ts);
 * a test keeps the two identical.
 */
export function deviceSigningString(parts: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}): string {
  return [
    'ATLAS-DEVICE-1',
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256,
  ].join('\n');
}
