import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Format: "ATF1" | 12-byte IV | ciphertext | 16-byte GCM tag.
const MAGIC = Buffer.from('ATF1', 'ascii');
const IV = 12;
const TAG = 16;

/** A fresh 256-bit key for one file. */
export const newFileKey = () => randomBytes(32);

/**
 * AES-256-GCM for a whole file held in memory. The associated data binds it to where it belongs (for example
 * "pwa|<password>|<attachment>|file"), so a file copied under another record fails to decrypt.
 */
export function sealBytes(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

/** Decrypts and authenticates the whole file before returning any of it. Throws if anything was changed. */
export function openBytes(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < MAGIC.length + IV + TAG || !sealed.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('Unsupported encrypted file format.');
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + IV);
  const tag = sealed.subarray(sealed.length - TAG);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + IV, sealed.length - TAG)), decipher.final()]);
}
