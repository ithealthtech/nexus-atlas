// Migrates an Atlas 0.2 SQLite database (legacy/data/atlas.sqlite) into this installation.
// Usage: npm run migrate-legacy -w @atlas/server -- <path to atlas.sqlite> [--legacy-key <0.2 key file>] [--owner <email>]
// Run it after first-run setup. It can be run again: records it already migrated are skipped.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { connect, runMigrations, schema } from '@atlas/db';
import { loadConfig } from '../config.js';
import { loadKeyProvider } from '../crypto/keys.js';
import { actorFor } from '../identity/service.js';
import { migrateLegacy } from '../services/importers/legacy.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const legacyKeyFile = flag('--legacy-key');
const ownerEmail = flag('--owner');
const file = args[0];
if (!file) {
  console.error(
    'Usage: npm run migrate-legacy -w @atlas/server -- <atlas.sqlite> [--legacy-key <file>] [--owner <email>]',
  );
  process.exit(2);
}

const config = loadConfig();
const keys = loadKeyProvider({
  envKey: config.ATLAS_MASTER_KEY,
  keyFile: config.ATLAS_MASTER_KEY_FILE,
  defaultFile: join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'),
  allowCreate: false,
});
const database = connect(config.DATABASE_URL);
await runMigrations(database);
const owners = await database.db.select().from(schema.users).where(eq(schema.users.role, 'owner'));
const owner = ownerEmail ? owners.find((u) => u.email === ownerEmail.toLowerCase()) : owners[0];
if (!owner) {
  console.error('No owner account found. Complete first-run setup (or pass --owner <email>) before migrating.');
  process.exit(1);
}
const legacyKey = legacyKeyFile ? Buffer.from(readFileSync(legacyKeyFile, 'utf8').trim(), 'base64url') : undefined;
const run = await migrateLegacy(database.db, actorFor(owner), keys, { file: resolve(file), legacyKey });
for (const [kind, c] of Object.entries(run.counts))
  console.log(
    `${kind.padEnd(10)} ${c.created} created, ${c.updated} updated, ${c.skipped} skipped, ${c.failed} failed`,
  );
for (const message of run.messages) console.log(`- ${message}`);
await database.close();
