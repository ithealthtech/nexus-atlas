import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Supplies the master key-encryption key. v1 reads it from the environment or a file;
 * cloud key managers can implement the same interface later.
 */
export interface KeyProvider {
  /** Short fingerprint stored with each ciphertext so rotated keys can be told apart. */
  readonly keyId: string;
  key(keyId: string): Buffer;
}

const fingerprint = (key: Buffer) => createHash('sha256').update(key).digest('base64url').slice(0, 8);

function decode(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64url');
  if (key.length !== 32) throw new Error(`${source} must contain a 32-byte key encoded as base64url.`);
  return key;
}

export function staticKeyProvider(keys: Buffer[]): KeyProvider {
  if (!keys.length) throw new Error('At least one master key is required.');
  const byId = new Map(keys.map((key) => [fingerprint(key), key]));
  const keyId = fingerprint(keys[0]!);
  return {
    keyId,
    key(id) {
      const key = byId.get(id);
      if (!key) throw new Error(`Master key ${id} is not available. Restore the matching key file.`);
      return key;
    },
  };
}

/** Loads ATLAS_MASTER_KEY, or ATLAS_MASTER_KEY_FILE, or (development only) creates a key file. */
export function loadKeyProvider(options: {
  envKey?: string;
  keyFile?: string;
  defaultFile: string;
  allowCreate: boolean;
}): KeyProvider {
  if (options.envKey) return staticKeyProvider(options.envKey.split(',').map((k) => decode(k, 'ATLAS_MASTER_KEY')));
  const file = options.keyFile ?? options.defaultFile;
  if (!existsSync(file)) {
    if (!options.allowCreate) throw new Error(`Master key file ${file} was not found.`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* Windows: protect the folder with NTFS permissions instead. */
    }
  }
  // Extra lines hold older keys kept for decrypting data written before a rotation.
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return staticKeyProvider(lines.map((line) => decode(line, file)));
}

/**
 * AES-256-GCM with associated data. Output: v2:<keyId>:<iv>:<tag>:<ciphertext>.
 * The associated data binds a ciphertext to where it belongs (for example "user|<id>|mfa"),
 * so a value copied into another row fails to decrypt.
 */
export function seal(keys: KeyProvider, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.key(keys.keyId), iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v2',
    keys.keyId,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    body.toString('base64url'),
  ].join(':');
}

export function open(keys: KeyProvider, sealed: string, aad: string): string {
  const [version, keyId, iv, tag, body] = sealed.split(':');
  if (version !== 'v2' || !keyId || !iv || !tag || body === undefined)
    throw new Error('Unsupported ciphertext format.');
  const decipher = createDecipheriv('aes-256-gcm', keys.key(keyId), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}
