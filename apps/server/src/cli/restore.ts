// Restores an encrypted backup into an empty database. Stop Atlas first.
// Usage: npm run restore -w @atlas/server -- <file.atlasbak> [--replace]
// --replace erases the current database and attachments first. The master key the backup was made with must be
// loaded (ATLAS_MASTER_KEY or the key file), because the backup and the vault are both encrypted with it.
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { connect } from '@atlas/db';
import { restoreBackup, verifyBackup } from '../backup/restore.js';
import { loadConfig } from '../config.js';
import { loadKeyProvider } from '../crypto/keys.js';
import { LocalStorage } from '../services/storage.js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: npm run restore -w @atlas/server -- <file.atlasbak> [--replace]');
  process.exit(2);
}

const config = loadConfig();
const keys = loadKeyProvider({
  envKey: config.ATLAS_MASTER_KEY,
  keyFile: config.ATLAS_MASTER_KEY_FILE,
  defaultFile: join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'),
  allowCreate: false,
});
const attachments = join(resolve(config.ATLAS_DATA_DIR), 'attachments');
const database = connect(config.DATABASE_URL);
try {
  // Read the whole file first: a damaged backup must never erase anything.
  console.log('Checking the backup…');
  await verifyBackup(resolve(file), keys);
  if (replace) await rm(attachments, { recursive: true, force: true });
  const result = await restoreBackup({
    handle: database,
    keys,
    storage: new LocalStorage(attachments),
    file: resolve(file),
    replace,
    verified: true,
    log: (line) => console.log(line),
  });
  console.log(
    `Done: ${result.rows} rows in ${result.tables} tables and ${result.files} files, from the backup of ${result.createdAt}.`,
  );
  if (result.missingFiles.length)
    console.log(`${result.missingFiles.length} attachment(s) were already missing when the backup was made.`);
  console.log('Start Atlas. Everyone signs in again; sessions are not part of backups.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await database.close();
}
