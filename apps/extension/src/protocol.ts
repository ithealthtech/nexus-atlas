// The request-signing format shared with the Atlas server (packages/shared/src/devices.ts, deviceSigningString).
// A test keeps the two identical.

export function signingString(parts: {
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

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text = '';
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The headers that sign one request with the device's private key. */
export async function signRequest(
  key: CryptoKey,
  request: { method: string; path: string; body: string; now: number },
): Promise<Record<string, string>> {
  const timestamp = String(Math.round(request.now));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
  const text = signingString({
    method: request.method,
    path: request.path,
    timestamp,
    nonce,
    bodySha256: await sha256Hex(request.body),
  });
  // WebCrypto ECDSA signatures are r‖s (64 bytes for P-256), which the server reads as IEEE P1363.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(text));
  return { 'X-Atlas-Timestamp': timestamp, 'X-Atlas-Nonce': nonce, 'X-Atlas-Signature': base64url(signature) };
}

/** The Atlas address as an origin, or null when it isn't one. Plain http is only accepted for this computer. */
export function atlasOrigin(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
  return url.origin;
}
