import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, runMigrations } from '@atlas/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { loadKeyProvider } from './crypto/keys.js';
import { IdentityService } from './identity/service.js';

const config = loadConfig();
const database = connect(config.DATABASE_URL);
await runMigrations(database);
const keys = loadKeyProvider({
  envKey: config.ATLAS_MASTER_KEY,
  keyFile: config.ATLAS_MASTER_KEY_FILE,
  defaultFile: join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'),
  allowCreate: config.NODE_ENV !== 'production',
});
config.WEB_DIST ??= fileURLToPath(new URL('../../web/dist', import.meta.url));

// First run: only someone who can read this console (or set ATLAS_SETUP_CODE) can create the owner account.
const needsSetup = await new IdentityService(database.db, keys, { requireStaffMfa: true }).needsSetup();
const setupCode = needsSetup ? (config.ATLAS_SETUP_CODE ?? randomBytes(12).toString('base64url')) : '';
const app = await buildApp({ config, database, keys, setupCode });
await app.listen({ host: config.HOST, port: config.PORT });
console.log(`\nMSP Atlas is running at ${config.PUBLIC_URL}`);
if (setupCode && !config.ATLAS_SETUP_CODE)
  console.log(`\nFirst-run setup code: ${setupCode}\nOpen Atlas and enter this code to create the owner account.\n`);

const stop = async () => {
  await app.close();
  await database.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
