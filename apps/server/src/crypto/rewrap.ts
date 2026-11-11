import { eq, isNotNull, or } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { AuditService } from '../services/audit.js';
import { SettingsService } from '../services/settings.js';
import { open, seal, type KeyProvider } from './keys.js';
import { VaultKeys } from './vault-keys.js';

/**
 * Re-seals everything Atlas encrypts directly with the master key (vault data keys, MFA secrets, and stored
 * settings secrets), and re-signs the security log's checkpoints, under the first (current) key in `master`. `master` must still hold the key each value was
 * sealed with. Used after a key rotation, and after restoring a backup made with another installation's key.
 */
export async function rewrapMasterSecrets(db: Database, master: KeyProvider) {
  const vault = await VaultKeys.rewrapAll(db, master);
  let mfa = 0;
  const reseal = (value: string | null, aad: string) => (value ? seal(master, open(master, value, aad), aad) : null);
  for (const user of await db
    .select()
    .from(schema.users)
    .where(or(isNotNull(schema.users.mfaSecret), isNotNull(schema.users.mfaPending)))) {
    const aad = `user|${user.id}|mfa`;
    await db
      .update(schema.users)
      .set({ mfaSecret: reseal(user.mfaSecret, aad), mfaPending: reseal(user.mfaPending, aad) })
      .where(eq(schema.users.id, user.id));
    mfa++;
  }
  const store = new SettingsService(db, master);
  const settings = await store.rewrapSecrets();
  const audit = new AuditService(db, master, store);
  for (const { id } of await db.select({ id: schema.orgs.id }).from(schema.orgs)) await audit.resignCheckpoint(id);
  return { vault, mfa, settings };
}
