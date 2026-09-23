import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { passwordSchema } from '@atlas/shared';
import { HttpError } from '../errors.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: object,
) => Promise<Buffer>;
const PARAMS = { N: 32768, r: 8, p: 1 };
const MAXMEM = 64 * 1024 * 1024;

// Same format as Atlas 0.2, so migrated password hashes keep working.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, { ...PARAMS, maxmem: MAXMEM });
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, {
    N: +N,
    r: +r,
    p: +p,
    maxmem: MAXMEM,
  });
  return timingSafeEqual(key, expected);
}

export function checkPassword(password: unknown, email = ''): string {
  const parsed = passwordSchema.safeParse(password);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Choose a stronger password.');
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && parsed.data.toLowerCase().includes(local))
    throw new HttpError(400, 'Passwords cannot contain your email name.');
  return parsed.data;
}
