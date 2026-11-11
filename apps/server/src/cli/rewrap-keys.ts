// Re-wraps vault data keys, MFA secrets, and stored settings secrets (SMTP password, Microsoft 365 client
// secret, Hudu API key) under the first (current) master key.
// Use after putting a new key first in ATLAS_MASTER_KEY / the key file while keeping the old one listed.
// Once this reports success, the old master key can be removed.
import { join, resolve } from 'node:path';
import { connect, runMigrations } from '@atlas/db';
import { loadConfig } from '../config.js';
import { loadKeyProvider } from '../crypto/keys.js';
import { rewrapMasterSecrets } from '../crypto/rewrap.js';

const config = loadConfig();
const master = loadKeyProvider({
  envKey: config.ATLAS_MASTER_KEY,
  keyFile: config.ATLAS_MASTER_KEY_FILE,
  defaultFile: join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'),
  allowCreate: false,
});
const database = connect(config.DATABASE_URL);
await runMigrations(database);
const { vault, mfa, settings } = await rewrapMasterSecrets(database.db, master);
console.log(
  `Re-wrapped ${vault} vault key(s), ${mfa} MFA secret(s), and ${settings} email/import secret(s) under master key ${master.keyId}.`,
);
await database.close();
