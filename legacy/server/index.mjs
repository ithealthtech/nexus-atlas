import { openStore } from './store.mjs';
import { openIdentity } from './identity.mjs';
import { createApp } from './app.mjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const database = process.env.ATLAS_DATABASE || fileURLToPath(new URL('../data/atlas.sqlite', import.meta.url));
const store = openStore(database);
// The MFA sealing key lives beside the database but in its own file; back both up, and protect the key.
const identity = openIdentity(store, { keyFile: process.env.ATLAS_KEY_FILE || join(dirname(database), 'atlas.key') });
// First run: only someone who can read this console can create the first administrator.
const setupCode = identity.needsSetup() ? randomBytes(9).toString('base64url') : '';
const app = createApp(store, identity, { setupCode });
const port = Number(process.env.PORT || 4318);
app.listen(port, '127.0.0.1', () => {
  console.log(`MSP Atlas development workspace: http://127.0.0.1:${app.address().port}\nSynthetic data only. Vault storage is disabled.`);
  if (setupCode) console.log(`\nFirst-run setup code: ${setupCode}\nOpen Atlas and enter this code to create the first administrator.`);
});
app.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
function stop() { app.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
