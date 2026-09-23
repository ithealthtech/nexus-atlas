import { openStore } from './store.mjs';
import { createApp } from './app.mjs';
import { fileURLToPath } from 'node:url';

const store = openStore(process.env.ATLAS_DATABASE || fileURLToPath(new URL('../data/atlas.sqlite', import.meta.url)));
const app = createApp(store);
const port = Number(process.env.PORT || 4318);
app.listen(port, '127.0.0.1', () => console.log(`MSP Atlas development workspace: http://127.0.0.1:${app.address().port}\nSynthetic data only. Vault storage is disabled.`));
app.on('error', error => { console.error(error.message); store.close(); process.exitCode = 1; });
function stop() { app.close(() => { store.close(); process.exit(0); }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
