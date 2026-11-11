import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, runMigrations } from '@atlas/db';
import { buildApp } from './app.js';
import { applyStagedRestore } from './backup/staged.js';
import { loadConfig } from './config.js';
import { loadKeyProvider } from './crypto/keys.js';
import { IdentityService } from './identity/service.js';
import { LocalStorage } from './services/storage.js';

const config = loadConfig();
const database = connect(config.DATABASE_URL);
await runMigrations(database);
const keyFile = config.ATLAS_MASTER_KEY
  ? null
  : (config.ATLAS_MASTER_KEY_FILE ?? join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'));
const loadedKeys = loadKeyProvider({
  envKey: config.ATLAS_MASTER_KEY,
  keyFile: config.ATLAS_MASTER_KEY_FILE,
  defaultFile: join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'),
  allowCreate: config.NODE_ENV !== 'production',
});
// A backup restore asked for from the Status page is installed now, before anything else uses the database.
const attachmentsDir = join(resolve(config.ATLAS_DATA_DIR), 'attachments');
const keys = await applyStagedRestore({
  handle: database,
  keys: loadedKeys,
  dataDir: resolve(config.ATLAS_DATA_DIR),
  storage: new LocalStorage(attachmentsDir),
  attachmentsDir,
  keyFile,
  log: (line) => console.log(line),
});
config.WEB_DIST ??= fileURLToPath(new URL('../../web/dist', import.meta.url));

// First run: only someone who can read this console (or set ATLAS_SETUP_CODE) can create the owner account.
const needsSetup = await new IdentityService(database.db, keys, { requireStaffMfa: true }).needsSetup();
const setupCode = needsSetup ? (config.ATLAS_SETUP_CODE ?? randomBytes(12).toString('base64url')) : '';
// Exit code 75 ("try again") counts as a failure to systemd, Docker, and the Windows service wrapper, so each one
// starts Atlas again, and the new start installs the restore.
const restart = () => {
  console.log('Restarting to install a backup restore…');
  void app
    .close()
    .then(() => database.close())
    .finally(() => process.exit(75));
};
const app = await buildApp({ config, database, keys, setupCode, restart });
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
