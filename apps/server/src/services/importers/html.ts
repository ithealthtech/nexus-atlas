import type { RichText } from '@atlas/shared';

// Converts imported HTML (Hudu articles, IT Glue documents) into the editor's document format.
// Only structure is kept; the result still goes through cleanRichText, which enforces the allowed nodes and links.

type Mark = { type: string; attrs?: Record<string, unknown> };
type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: Mark[] };
type Token =
  { kind: 'open' | 'close' | 'self'; tag: string; attrs: Record<string, string> } | { kind: 'text'; text: string };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1\s*>/gi, '');
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    if (m[3] !== undefined) {
      tokens.push({ kind: 'text', text: decodeEntities(m[3]) });
      continue;
    }
    const tag = m[1]!.toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of m[2]!.matchAll(/([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g))
      attrs[a[1]!.toLowerCase()] = decodeEntities(a[3] ?? a[4] ?? a[5] ?? '');
    const kind = m[0].startsWith('</')
      ? 'close'
      : /\/\s*>$/.test(m[0]) || ['br', 'hr', 'img'].includes(tag)
        ? 'self'
        : 'open';
    tokens.push({ kind, tag, attrs });
  }
  return tokens;
}

const BLOCK = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'pre',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'section',
  'article',
  'hr',
]);
const MARK_TAGS: Record<string, string> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  u: 'underline',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
  mark: 'highlight',
};

export function htmlToRichText(html: string): RichText {
  const tokens = tokenize(html ?? '');
  let i = 0;

  // Parses inline content until a block tag or the closing tag `until`.
  function inline(marks: Mark[], until?: string): Node[] {
    const out: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.kind === 'text') {
        const text = t.text.replace(/\s+/g, ' ');
        if (text) out.push({ type: 'text', text, ...(marks.length ? { marks: [...marks] } : {}) });
        i++;
      } else if (t.kind === 'self' && t.tag === 'br') {
        out.push({ type: 'hardBreak' });
        i++;
      } else if (t.kind === 'close' && t.tag === until) {
        i++;
        return out;
      } else if (BLOCK.has(t.tag)) {
        return out;
      } else if (t.kind === 'open' && (MARK_TAGS[t.tag] || t.tag === 'a')) {
        i++;
        // Links to anything but web, email, or phone addresses keep their text and lose the link.
        const href = (t.attrs.href ?? '').trim();
        const mark: Mark | null =
          t.tag !== 'a'
            ? { type: MARK_TAGS[t.tag]! }
            : /^(https?:\/\/|mailto:|tel:)/i.test(href)
              ? { type: 'link', attrs: { href } }
              : null;
        out.push(...inline(mark ? [...marks, mark] : marks, t.tag));
      } else i++;
    }
    return out;
  }

  const trimText = (nodes: Node[]) => {
    const first = nodes[0];
    if (first?.type === 'text') first.text = first.text!.replace(/^\s+/, '');
    const last = nodes.at(-1);
    if (last?.type === 'text') last.text = last.text!.replace(/\s+$/, '');
    return nodes.filter((n) => n.type !== 'text' || n.text);
  };
  const paragraph = (content: Node[]): Node => ({ type: 'paragraph', ...(content.length ? { content } : {}) });

  function blocks(until?: string): Node[] {
    const out: Node[] = [];
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.kind === 'close') {
        i++;
        if (t.tag === until) return out;
        continue;
      }
      if (t.kind === 'text' || !BLOCK.has(t.tag) || t.tag === 'br') {
        const content = trimText(inline([]));
        if (content.length) out.push(paragraph(content));
        continue;
      }
      i++;
      const tag = t.tag;
      if (tag === 'hr') out.push({ type: 'horizontalRule' });
      else if (/^h[1-6]$/.test(tag))
        out.push({
          type: 'heading',
          attrs: { level: Math.min(Number(tag[1]), 4) },
          content: trimText(inline([], tag)),
        });
      else if (tag === 'p') out.push(paragraph(trimText(inline([], 'p'))));
      else if (tag === 'pre') {
        const text: string[] = [];
        while (i < tokens.length && !(tokens[i]!.kind === 'close' && (tokens[i] as { tag: string }).tag === 'pre')) {
          const x = tokens[i++]!;
          if (x.kind === 'text') text.push(x.text);
          else if (x.kind === 'self' && x.tag === 'br') text.push('\n');
        }
        i++;
        const code = text.join('');
        out.push({ type: 'codeBlock', ...(code ? { content: [{ type: 'text', text: code }] } : {}) });
      } else if (tag === 'ul' || tag === 'ol') {
        const items = blocks(tag).filter((n) => n.type === 'listItem');
        if (items.length) out.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: items });
      } else if (tag === 'li') {
        const inner = blocks('li');
        out.push({ type: 'listItem', content: inner.length ? inner : [paragraph([])] });
      } else if (tag === 'blockquote') {
        const inner = blocks('blockquote');
        out.push({ type: 'blockquote', content: inner.length ? inner : [paragraph([])] });
      } else if (tag === 'table') {
        const rows = blocks('table').flatMap((n) =>
          n.type === 'tableRow' ? [n] : (n.content?.filter((r) => r.type === 'tableRow') ?? []),
        );
        if (rows.length) out.push({ type: 'table', content: rows });
      } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        out.push({ type: 'rowgroup', content: blocks(tag) });
      } else if (tag === 'tr') {
        const cells = blocks('tr').filter((n) => n.type === 'tableCell' || n.type === 'tableHeader');
        if (cells.length) out.push({ type: 'tableRow', content: cells });
      } else if (tag === 'td' || tag === 'th') {
        const inner = blocks(tag);
        out.push({ type: tag === 'th' ? 'tableHeader' : 'tableCell', content: inner.length ? inner : [paragraph([])] });
      } else out.push(...blocks(tag)); // div, section, article: unwrap
    }
    return out;
  }

  const content = blocks().filter((n) => n.type !== 'rowgroup');
  return { type: 'doc', content: content.length ? content : [paragraph([])] };
}

/** Plain text from HTML, for fields that aren't rich text. */
export const htmlToText = (html: string) =>
  decodeEntities((html ?? '').replace(/<(br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
