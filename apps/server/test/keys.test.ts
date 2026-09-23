import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadKeyProvider, open, seal, staticKeyProvider } from '../src/crypto/keys.js';
import { loadConfig } from '../src/config.js';

describe('sealed secrets', () => {
  const keys = staticKeyProvider([randomBytes(32)]);

  it('round-trips and binds ciphertext to its associated data', () => {
    const sealed = seal(keys, 'JBSWY3DPEHPK3PXP', 'user|a|mfa');
    expect(sealed).toMatch(/^v2:[\w-]{8}:/);
    expect(sealed).not.toContain('JBSWY3DP');
    expect(open(keys, sealed, 'user|a|mfa')).toBe('JBSWY3DPEHPK3PXP');
    // Moved to another row or field: authentication fails.
    expect(() => open(keys, sealed, 'user|b|mfa')).toThrow();
    const parts = sealed.split(':');
    parts[4] = Buffer.from('tampered').toString('base64url');
    expect(() => open(keys, parts.join(':'), 'user|a|mfa')).toThrow();
  });

  it('decrypts with older keys after rotation and names a missing key', () => {
    const oldKey = randomBytes(32);
    const before = seal(staticKeyProvider([oldKey]), 'secret', 'x');
    const rotated = staticKeyProvider([randomBytes(32), oldKey]);
    expect(open(rotated, before, 'x')).toBe('secret');
    expect(seal(rotated, 'secret', 'x').split(':')[1]).toBe(rotated.keyId);
    expect(() => open(staticKeyProvider([randomBytes(32)]), before, 'x')).toThrow(/not available/);
  });

  it('creates a private key file only when allowed, and reads extra lines as old keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-keys-'));
    try {
      const file = join(dir, 'master.key');
      expect(() => loadKeyProvider({ defaultFile: file, allowCreate: false })).toThrow(/not found/);
      const created = loadKeyProvider({ defaultFile: file, allowCreate: true });
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
      writeFileSync(file, `${randomBytes(32).toString('base64url')}\n${readFileSync(file, 'utf8')}`);
      const both = loadKeyProvider({ defaultFile: file, allowCreate: false });
      expect(both.keyId).not.toBe(created.keyId);
      expect(() => both.key(created.keyId)).not.toThrow();
      expect(() => loadKeyProvider({ envKey: 'too-short', defaultFile: file, allowCreate: false })).toThrow(/32-byte/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('configuration', () => {
  it('fails fast on unsafe production settings', () => {
    const base = { DATABASE_URL: 'postgres://u@h/db', NODE_ENV: 'production' };
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'http://atlas.example.com', ATLAS_MASTER_KEY_FILE: '/k' })).toThrow(
      /https/,
    );
    expect(() => loadConfig({ ...base, PUBLIC_URL: 'https://atlas.example.com' })).toThrow(/ATLAS_MASTER_KEY/);
    const ok = loadConfig({ ...base, PUBLIC_URL: 'https://atlas.example.com', ATLAS_MASTER_KEY_FILE: '/k' });
    expect(ok.secureCookies).toBe(true);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
