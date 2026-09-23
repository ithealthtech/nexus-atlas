import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// RFC 6238 TOTP (SHA-1, 30-second steps, 6 digits): the variant every authenticator app supports.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function toBase32(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits ? output + B32[(value << (5 - bits)) & 31] : output;
}

export function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = B32.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret.');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const newTotpSecret = () => toBase32(randomBytes(20));
export const totpStep = (time = Date.now()) => Math.floor(time / 30000);

export function totp(secret: string, step = totpStep()): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', fromBase32(secret)).update(message).digest();
  const offset = hmac[19]! & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** Accepts the current step and one either side; returns the matched step, or 0. Steps at or before lastStep are rejected (no replay). */
export function matchTotp(secret: string, code: string, lastStep: number, time = Date.now()): number {
  const current = totpStep(time);
  const given = Buffer.from(code);
  for (const step of [current - 1, current, current + 1]) {
    if (step <= lastStep) continue;
    const expected = Buffer.from(totp(secret, step));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return step;
  }
  return 0;
}

export function otpauthUri(secret: string, account: string, issuer = 'MSP Atlas'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
