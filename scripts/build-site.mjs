/**
 * Builds the documentation site (pages/) from the Markdown in site/.
 *
 *   node scripts/build-site.mjs          writes the pages
 *   node scripts/build-site.mjs --check  fails if a page is out of date (CI runs this)
 *
 * Every page is a Markdown file with a few lines of front matter. The Markdown is a small, strict subset: headings,
 * paragraphs, lists, tables, callouts, figures, code blocks, and raw HTML blocks. Anything it doesn't understand is
 * an error rather than a surprise on the published site. {{version}} becomes the version in package.json.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'site');
const OUT = join(ROOT, 'pages');
const REPO = 'https://github.com/ithealthtech/nexus-atlas';
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const check = process.argv.includes('--check');

// ---------------------------------------------------------------------------------------------------------------
// Pages

function readPage(file) {
  const raw = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: front matter missing`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`${file}: bad front matter line "${line}"`);
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const key of ['title', 'out']) if (!meta[key]) throw new Error(`${file}: "${key}" missing`);
  return { ...meta, file, body: raw.slice(m[0].length).replaceAll('{{version}}', version) };
}

const pages = readdirSync(SRC)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => readPage(join(SRC, f)));

// The manual's chapters, in order, grouped as the sidebar shows them.
const chapters = pages.filter((p) => p.group).sort((a, b) => Number(a.order) - Number(b.order));
const GROUPS = [...new Set(chapters.map((c) => c.group))];

// ---------------------------------------------------------------------------------------------------------------
// Markdown

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function inline(text, where) {
  // Code spans first, so nothing inside them is formatted.
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(`<code>${esc(c)}</code>`);
    return `@@code${codes.length - 1}@@`;
  });
  s = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const external = /^https?:/.test(href);
      return `<a href="${href}"${external ? ' rel="noopener"' : ''}>${label}</a>`;
    })
    .replace(/(^|\s)--(\s|$)/g, '$1&ndash;$2');
  s = s.replace(/@@code(\d+)@@/g, (_, i) => codes[Number(i)]);
  if (/\*\*|\]\(/.test(s.replace(/<code>[\s\S]*?<\/code>/g, '')))
    throw new Error(`${where}: unclosed formatting in "${text}"`);
  return s;
}

/** Turns one page's Markdown into HTML, and lists its sections for the contents and the search index. */
function render(page) {
  const lines = page.body.split('\n');
  const html = [];
  const sections = [];
  let current = null; // the section being collected for search
  let i = 0;
  const where = () => `${relative(ROOT, page.file)}:${i + 1}`;
  const text = (s) => {
    if (current) current.text.push(s.replace(/<[^>]+>/g, ''));
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // The list of chapters, on the manual's first page.
    if (line.trim() === '{{chapters}}') {
      const root = '../'.repeat(page.out.split('/').length - 1);
      html.push(
        `<ul class="chapters">${chapters
          .filter((c) => c.number)
          .map(
            (c) =>
              `<li><a href="${root}${c.out}"><b>${c.number}</b><span><strong>${esc(c.title)}</strong>${esc(c.summary ?? '')}</span></a></li>`,
          )
          .join('')}</ul>`,
      );
      i++;
      continue;
    }

    // Raw HTML block: runs until a blank line.
    if (line.startsWith('<')) {
      const block = [];
      while (i < lines.length && lines[i].trim()) block.push(lines[i++]);
      html.push(block.join('\n'));
      continue;
    }

    const heading = line.match(/^(#{1,3}) (.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2], where());
      if (level === 1) {
        html.push(`<h1>${content}</h1>`);
      } else {
        const id = slug(heading[2]);
        html.push(`<h${level} id="${id}"><a class="anchor" href="#${id}">${content}</a></h${level}>`);
        if (level === 2) {
          current = { id, title: heading[2].replace(/[*`]/g, ''), text: [] };
          sections.push(current);
        } else text(heading[2]);
      }
      i++;
      continue;
    }

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const block = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) block.push(lines[i++]);
      if (i >= lines.length) throw new Error(`${where()}: code block not closed`);
      i++;
      html.push(
        `<div class="code"><pre><code${lang ? ` data-lang="${lang}"` : ''}>${esc(block.join('\n'))}</code></pre>` +
          `<button class="copy" type="button" aria-label="Copy">Copy</button></div>`,
      );
      continue;
    }

    // Callout: > [!note] Optional title
    if (line.startsWith('>')) {
      const block = [];
      while (i < lines.length && lines[i].startsWith('>')) block.push(lines[i++].replace(/^> ?/, ''));
      const head = block[0].match(/^\[!(note|tip|warning)\]\s*(.*)$/);
      if (!head) throw new Error(`${where()}: a callout starts with [!note], [!tip] or [!warning]`);
      const body = block
        .slice(1)
        .join('\n')
        .split(/\n\s*\n/)
        .map((p) => `<p>${inline(p.replace(/\n/g, ' '), where())}</p>`)
        .join('');
      const title = head[2] ? `<p class="callout-title">${inline(head[2], where())}</p>` : '';
      html.push(`<aside class="callout callout-${head[1]}">${title}${body}</aside>`);
      text(block.slice(1).join(' '));
      continue;
    }

    // Figure: ![alt](src "caption")
    const figure = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)$/);
    if (figure) {
      const [, alt, src, caption] = figure;
      if (!alt) throw new Error(`${where()}: a figure needs alt text`);
      const file = join(OUT, dirname(page.out), src);
      if (!existsSync(file)) throw new Error(`${where()}: no image at ${relative(ROOT, file)}`);
      html.push(
        `<figure><a href="${src}"><img src="${src}" alt="${esc(alt)}" loading="lazy" /></a>` +
          (caption ? `<figcaption>${inline(caption, where())}</figcaption>` : '') +
          `</figure>`,
      );
      i++;
      continue;
    }

    // Table
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      const cells = (r) =>
        r
          .replace(/^\||\|$/g, '')
          .split(/(?<!\\)\|/)
          .map((c) => c.trim().replace(/\\\|/g, '|'));
      if (!/^\|[\s:|-]+\|$/.test(rows[1] ?? '')) throw new Error(`${where()}: table separator row missing`);
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      for (const r of body)
        if (r.length !== head.length) throw new Error(`${where()}: table row has ${r.length} cells`);
      html.push(
        `<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c, where())}</th>`).join('')}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, where())}</td>`).join('')}</tr>`).join('') +
          `</tbody></table></div>`,
      );
      for (const r of body) text(r.join(' '));
      continue;
    }

    // Lists, with one level of nesting (two spaces).
    const item = /^(\s*)(- |\d+\. )(.*)$/;
    if (item.test(line)) {
      const ordered = /^\d+\. /.test(line.trim());
      // A numbered list split by a code block carries on from where it stopped.
      const first = ordered ? Number(line.trim().match(/^\d+/)[0]) : 1;
      const top = [];
      while (i < lines.length && (item.test(lines[i]) || /^ {2,}\S/.test(lines[i]))) {
        const m = lines[i].match(item);
        if (m && m[1].length === 0) top.push({ text: m[3], children: [] });
        else if (m) top.at(-1).children.push(m[3]);
        else if (top.at(-1).children.length)
          top[top.length - 1].children[top.at(-1).children.length - 1] += ' ' + lines[i].trim();
        else top.at(-1).text += ' ' + lines[i].trim();
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(
        `<${tag}${ordered ? ' class="steps"' : ''}${first > 1 ? ` start="${first}"` : ''}>` +
          top
            .map(
              (t) =>
                `<li>${inline(t.text, where())}` +
                (t.children.length
                  ? `<ul>${t.children.map((c) => `<li>${inline(c, where())}</li>`).join('')}</ul>`
                  : '') +
                `</li>`,
            )
            .join('') +
          `</${tag}>`,
      );
      for (const t of top) text([t.text, ...t.children].join(' '));
      continue;
    }

    // Paragraph: runs until a blank line or another block.
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|>|\||- |\d+\. |!\[|<)/.test(lines[i]))
      para.push(lines[i++]);
    if (!para.length) throw new Error(`${where()}: can't read "${line}"`);
    const p = para.join(' ');
    html.push(`<p>${inline(p, where())}</p>`);
    text(p);
  }
  return { html: html.join('\n'), sections };
}

// ---------------------------------------------------------------------------------------------------------------
// Layout

const ICON = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="currentColor"/><path d="M9 23 16 8l7 15M11.6 18h8.8" fill="none" stroke="var(--bg)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function header(root, active) {
  const link = (href, label, key) =>
    `<a href="${root}${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="${root}index.html">${ICON}<span>MSP Atlas</span></a>
    <nav class="topnav" aria-label="Site">
      ${link('manual/index.html', 'Manual', 'manual')}
      ${link('install.html', 'Install', 'install')}
      ${link('security.html', 'Security', 'security')}
      ${link('support.html', 'Support', 'support')}
    </nav>
    <div class="topbar-tools">
      <div class="search" data-root="${root}">
        <label class="sr-only" for="site-search">Search the manual</label>
        <input id="site-search" type="search" placeholder="Search the manual" autocomplete="off" />
        <kbd>/</kbd>
        <div class="search-results" role="listbox" hidden></div>
      </div>
      <button class="theme" type="button" aria-label="Switch between light and dark">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
      </button>
      <a class="gh" href="${REPO}" aria-label="MSP Atlas on GitHub" rel="noopener">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.85-2.34 4.7-4.57 4.94.36.31.68.92.68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>
      </a>
      <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="sidebar">Contents</button>
    </div>
  </div>
</header>`;
}

function footer(root) {
  return `<footer class="footer">
  <div class="footer-inner">
    <p>MSP Atlas {{v}}. Documentation, passwords and client operations for managed service providers, on a server you own.</p>
    <p>
      <a href="${REPO}/releases/latest" rel="noopener">Releases</a>
      <a href="${REPO}/blob/main/CHANGELOG.md" rel="noopener">Changelog</a>
      <a href="${root}security.html#reporting-a-vulnerability">Report a vulnerability</a>
      <a href="${REPO}/issues" rel="noopener">Issues</a>
    </p>
  </div>
</footer>`;
}

function shell({ title, description, root, active, body, bodyClass }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description ?? '')}" />
<link rel="icon" href="${root}images/favicon.svg" type="image/svg+xml" />
<link rel="preload" href="${root}assets/fonts/instrument-sans.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="${root}assets/site.css" />
<script src="${root}assets/theme.js"></script>
<script src="${root}assets/site.js" defer></script>
</head>
<body class="${bodyClass}">
<a class="skip" href="#content">Skip to content</a>
${header(root, active)}
${body}
${footer(root)}
</body>
</html>`.replace('{{v}}', version);
}

function sidebar(root, current) {
  return `<nav class="sidebar" id="sidebar" aria-label="Manual">
  ${GROUPS.map(
    (g) => `<p class="sidebar-group">${esc(g)}</p>
  <ul>${chapters
    .filter((c) => c.group === g)
    .map(
      (c) =>
        `<li><a href="${root}${c.out}"${c === current ? ' aria-current="page"' : ''}>${
          c.number ? `<span class="num">${c.number}</span>` : ''
        }${esc(c.nav ?? c.title)}</a></li>`,
    )
    .join('')}</ul>`,
  ).join('\n')}
</nav>`;
}

function chapterPage(page, rendered) {
  const root = '../'.repeat(page.out.split('/').length - 1);
  const index = chapters.indexOf(page);
  const prev = chapters[index - 1];
  const next = chapters[index + 1];
  const toc =
    rendered.sections.length > 1
      ? `<nav class="toc" aria-label="On this page"><p>On this page</p><ul>${rendered.sections
          .map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`)
          .join('')}</ul></nav>`
      : '<div class="toc"></div>';
  const pager = `<nav class="pager" aria-label="Chapters">${
    prev
      ? `<a class="prev" href="${root}${prev.out}"><span>Previous</span>${esc(prev.nav ?? prev.title)}</a>`
      : '<span></span>'
  }${next ? `<a class="next" href="${root}${next.out}"><span>Next</span>${esc(next.nav ?? next.title)}</a>` : ''}</nav>`;
  const eyebrow = page.number ? `Chapter ${page.number}` : page.group;
  const body = `<div class="layout">
${sidebar(root, page)}
<main id="content" class="doc">
  <p class="eyebrow">${esc(eyebrow)}</p>
  ${rendered.html}
  ${pager}
</main>
${toc}
</div>`;
  return shell({
    title: `${page.title} · MSP Atlas manual`,
    description: page.summary,
    root,
    active: page.active ?? 'manual',
    body,
    bodyClass: 'chapter',
  });
}

function plainPage(page, rendered) {
  const root = '../'.repeat(page.out.split('/').length - 1);
  return shell({
    title: page.title,
    description: page.summary,
    root,
    active: page.active,
    body: `<main id="content" class="${page.layout}">\n${rendered.html}\n</main>`,
    bodyClass: page.layout,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Build

const outputs = new Map();
const index = [];
for (const page of pages) {
  const rendered = render(page);
  if (page.group) {
    page.number = page.number || '';
    outputs.set(page.out, chapterPage(page, rendered));
    for (const s of rendered.sections)
      index.push({
        u: page.out,
        p: page.nav ?? page.title,
        s: s.title,
        h: s.id,
        t: s.text.join(' ').replace(/\s+/g, ' '),
      });
  } else {
    outputs.set(page.out, plainPage(page, rendered));
  }
}
outputs.set('assets/search.json', JSON.stringify(index));

let stale = [];
for (const [out, content] of outputs) {
  const file = join(OUT, out);
  const formatted = await prettier.format(content, { ...(await prettier.resolveConfig(file)), filepath: file });
  const before = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (before === formatted) continue;
  if (check) stale.push(out);
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, formatted);
    console.log(`wrote pages/${out}`);
  }
}
if (stale.length) {
  console.error(
    `These pages are out of date. Run node scripts/build-site.mjs and commit the result:\n  ${stale.join('\n  ')}`,
  );
  process.exit(1);
}
if (check) console.log(`site is up to date (${outputs.size} files)`);
