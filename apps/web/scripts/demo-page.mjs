// Turns dist-demo/index.html into a page body for publishing as an artifact (the host adds <html>/<head>).
import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync(new URL('../dist-demo/index.html', import.meta.url), 'utf8');
const pick = (re) => [...html.matchAll(re)].map((m) => m[0]).join('\n');
const page = [
  '<title>Atlas Demo</title>',
  pick(/<link rel="stylesheet"[^>]*>/g),
  pick(/<script type="module"[^>]*><\/script>/g),
  pick(/<link rel="modulepreload"[^>]*>/g),
  '<div id="root"></div>',
].join('\n');
writeFileSync(new URL('../dist-demo/page.html', import.meta.url), `${page}\n`);
console.log('Wrote dist-demo/page.html');
