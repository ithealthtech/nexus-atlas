import { readFileSync } from 'node:fs';

// Same relative path from src/ and dist/: the server package's own package.json.
export const APP_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;
