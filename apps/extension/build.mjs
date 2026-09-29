// Builds the browser extension into apps/extension/dist (load it unpacked from there) and zips it for the Edge
// Add-ons and Chrome Web Store dashboards, or for installing through group policy.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const version = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')).version;

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(here, '../../node_modules/typescript/bin/tsc'), '-p', here], { stdio: 'inherit' });
cpSync(join(here, 'static'), dist, { recursive: true });
// The extension's version follows Atlas's.
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);

const files = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files[relative(dist, path).split('\\').join('/')] = readFileSync(path);
  }
};
walk(dist);
mkdirSync(join(here, 'package'), { recursive: true });
const zip = join(here, 'package', `msp-atlas-extension-${version}.zip`);
writeFileSync(zip, zipSync(files, { level: 9 }));
console.log(`Built ${relative(process.cwd(), dist)} and ${relative(process.cwd(), zip)}`);
