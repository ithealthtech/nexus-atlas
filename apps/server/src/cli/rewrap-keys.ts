// Re-wraps vault data keys, MFA secrets, and stored settings secrets (SMTP password, Microsoft 365 client
// secret, Hudu API key) under the first (current) master key.
// Use after putting a new key first in ATLAS_MASTER_KEY / the key file while keeping the old one listed.
// Once this reports success, the old master key can be removed.
import { join, resolve } from 'node:path';
import { eq, isNotNull } from 'drizzle-orm';
import { connect, runMigrations, schema } from '@atlas/db';
import { loadConfig } from '../config.js';
import { loadKeyProvider, open, seal } from '../crypto/keys.js';
import { VaultKeys } from '../crypto/vault-keys.js';
import { SettingsService } from '../services/settings.js';

const config = loadConfig();
const master = loadKeyProvider({
  envKey: config.ATLAS_MASTER_KEY,
  keyFile: config.ATLAS_MASTER_KEY_FILE,
  defaultFile: join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'),
  allowCreate: false,
});
const database = connect(config.DATABASE_URL);
await runMigrations(database);
const vault = await VaultKeys.rewrapAll(database.db, master);
let mfa = 0;
for (const user of await database.db.select().from(schema.users).where(isNotNull(schema.users.mfaSecret))) {
  const aad = `user|${user.id}|mfa`;
  await database.db
    .update(schema.users)
    .set({ mfaSecret: seal(master, open(master, user.mfaSecret!, aad), aad) })
    .where(eq(schema.users.id, user.id));
  mfa++;
}
const settings = await new SettingsService(database.db, master).rewrapSecrets();
console.log(
  `Re-wrapped ${vault} vault key(s), ${mfa} MFA secret(s), and ${settings} email/import secret(s) under master key ${master.keyId}.`,
);
await database.close();
