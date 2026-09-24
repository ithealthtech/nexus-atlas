// Makes an encrypted backup now, or checks a backup file.
// Usage: npm run backup -w @atlas/server                 (writes to the backup folder)
//        npm run backup -w @atlas/server -- verify <file> (reads and checks every part of a backup)
import { join, resolve } from 'node:path';
import { connect, runMigrations } from '@atlas/db';
import { BackupService } from '../backup/service.js';
import { verifyBackup } from '../backup/restore.js';
import { loadConfig } from '../config.js';
import { loadKeyProvider } from '../crypto/keys.js';
import { LocalStorage } from '../services/storage.js';
import { APP_VERSION } from '../version.js';

const config = loadConfig();
const keys = loadKeyProvider({
  envKey: config.ATLAS_MASTER_KEY,
  keyFile: config.ATLAS_MASTER_KEY_FILE,
  defaultFile: join(resolve(config.ATLAS_DATA_DIR), 'atlas-master.key'),
  allowCreate: false,
});
const [command, file] = process.argv.slice(2);

try {
  if (command === 'verify') {
    if (!file) throw new Error('Usage: npm run backup -w @atlas/server -- verify <file.atlasbak>');
    const result = await verifyBackup(resolve(file), keys);
    console.log(
      `OK: backup from ${result.createdAt} (Atlas ${result.appVersion}), ${result.tables} tables, ${result.rows} rows, ${result.files} files.`,
    );
  } else {
    const database = connect(config.DATABASE_URL);
    try {
      await runMigrations(database);
      const backups = new BackupService(
        database,
        keys,
        new LocalStorage(join(resolve(config.ATLAS_DATA_DIR), 'attachments')),
        {
          dir: config.ATLAS_BACKUP_DIR ?? join(resolve(config.ATLAS_DATA_DIR), 'backups'),
          keep: config.ATLAS_BACKUP_KEEP,
          hour: config.ATLAS_BACKUP_HOUR,
          enabled: true,
          appVersion: APP_VERSION,
        },
      );
      const run = await backups.run('manual', 'Command line');
      console.log(
        `Wrote ${join(backups.dir, run.fileName!)} (${run.rows} rows, ${run.files} files, ${run.size} bytes).`,
      );
    } finally {
      await database.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
