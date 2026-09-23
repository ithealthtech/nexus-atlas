import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
let count = 0;
for (const dir of ['server','public','scripts','tests']) for (const name of readdirSync(dir)) {
  if (!/\.(mjs|js)$/.test(name)) continue;
  const result = spawnSync(process.execPath,['--check',join(dir,name)],{stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status || 1);
  count++;
}
console.log(`Syntax checks passed for ${count} application and test files.`);
