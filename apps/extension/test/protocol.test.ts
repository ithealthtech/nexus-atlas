import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deviceSigningString } from '@atlas/shared';
import { atlasOrigin, base64url, sha256Hex, signRequest, signingString } from '../src/protocol.js';

describe('extension request signing', () => {
  it('builds the same text the server checks', () => {
    const parts = {
      method: 'post',
      path: '/api/device/logins?url=a%20b',
      timestamp: '1790000000000',
      nonce: 'n',
      bodySha256: 'h',
    };
    expect(signingString(parts)).toBe(deviceSigningString(parts));
  });

  it('signs in the form the server verifies (P-256, r‖s)', async () => {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const body = JSON.stringify({ url: 'https://portal.example.com', reason: '' });
    const headers = await signRequest(key.privateKey, {
      method: 'POST',
      path: '/api/device/logins/x/fill',
      body,
      now: 1790000000000,
    });
    expect(headers['X-Atlas-Timestamp']).toBe('1790000000000');
    const text = signingString({
      method: 'POST',
      path: '/api/device/logins/x/fill',
      timestamp: headers['X-Atlas-Timestamp']!,
      nonce: headers['X-Atlas-Nonce']!,
      bodySha256: await sha256Hex(body),
    });
    const spki = Buffer.from(base64url(await crypto.subtle.exportKey('spki', key.publicKey)), 'base64url');
    const publicKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const signature = Buffer.from(headers['X-Atlas-Signature']!, 'base64url');
    expect(signature).toHaveLength(64);
    expect(verify('sha256', Buffer.from(text), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
    expect(verify('sha256', Buffer.from(`${text}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(
      false,
    );
  });

  it('accepts only https Atlas addresses, and plain http on this computer', () => {
    expect(atlasOrigin('atlas.example.com')).toBe('https://atlas.example.com');
    expect(atlasOrigin(' https://atlas.example.com/login?x=1 ')).toBe('https://atlas.example.com');
    expect(atlasOrigin('https://atlas.example.com:8443')).toBe('https://atlas.example.com:8443');
    expect(atlasOrigin('http://localhost:4318')).toBe('http://localhost:4318');
    expect(atlasOrigin('http://atlas.example.com')).toBeNull();
    expect(atlasOrigin('ftp://atlas.example.com')).toBeNull();
    expect(atlasOrigin('')).toBeNull();
  });
});
