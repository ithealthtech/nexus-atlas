import type { RichText } from '@atlas/shared';
import { HttpError } from '../errors.js';

// Node and mark types the editor may store, with the attributes kept for each. Anything else is rejected,
// so stored documents can't carry script, event handlers, or unexpected embeds.
const NODES: Record<string, (attrs: Record<string, unknown>) => Record<string, unknown> | undefined> = {
  doc: () => undefined,
  paragraph: (a) => align(a),
  text: () => undefined,
  heading: (a) => ({ level: [1, 2, 3, 4].includes(a.level as number) ? a.level : 2, ...align(a) }),
  bulletList: () => undefined,
  orderedList: (a) => ({ start: Number.isInteger(a.start) ? a.start : 1 }),
  listItem: () => undefined,
  taskList: () => undefined,
  taskItem: (a) => ({ checked: a.checked === true }),
  blockquote: () => undefined,
  codeBlock: (a) => ({
    language: typeof a.language === 'string' && /^[a-z0-9+#-]{1,20}$/i.test(a.language) ? a.language : null,
  }),
  horizontalRule: () => undefined,
  hardBreak: () => undefined,
  table: () => undefined,
  tableRow: () => undefined,
  tableHeader: (a) => cell(a),
  tableCell: (a) => cell(a),
};
const MARKS: Record<string, (attrs: Record<string, unknown>) => Record<string, unknown> | undefined> = {
  bold: () => undefined,
  italic: () => undefined,
  strike: () => undefined,
  underline: () => undefined,
  code: () => undefined,
  highlight: () => undefined,
  link: (a) => ({ href: safeHref(a.href) }),
};
function align(a: Record<string, unknown>) {
  return ['left', 'center', 'right'].includes(a.textAlign as string) ? { textAlign: a.textAlign } : undefined;
}
function cell(a: Record<string, unknown>) {
  const span = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20 ? v : 1);
  return { colspan: span(a.colspan), rowspan: span(a.rowspan) };
}
export function safeHref(href: unknown): string {
  if (typeof href !== 'string' || href.length > 2000)
    throw new HttpError(400, 'A link in this document is too long or invalid.');
  const value = href.trim();
  if (/^(https?:|mailto:|tel:)/i.test(value) || /^\/(?!\/)/.test(value) || value.startsWith('#')) return value;
  throw new HttpError(400, 'Links must start with http://, https://, mailto:, or tel:.');
}

const LIMITS = { depth: 40, nodes: 50_000, text: 500_000 };

/** Returns a cleaned copy of the document plus its plain text (for search and diffs). */
export function cleanRichText(input: unknown): { content: RichText; text: string } {
  let nodes = 0;
  let textLength = 0;
  const lines: string[] = [];
  let line = '';
  // Task items prefix their first line with a checkbox marker so diffs show ticked steps.
  let pendingPrefix = '';
  const BLOCKS = new Set([
    'paragraph',
    'heading',
    'listItem',
    'taskItem',
    'codeBlock',
    'blockquote',
    'tableRow',
    'horizontalRule',
  ]);

  const walk = (node: unknown, depth: number): Record<string, unknown> => {
    if (!node || typeof node !== 'object' || Array.isArray(node))
      throw new HttpError(400, 'The document content is not valid.');
    if (depth > LIMITS.depth || ++nodes > LIMITS.nodes)
      throw new HttpError(400, 'This document is too large or deeply nested.');
    const n = node as Record<string, unknown>;
    const type = n.type as string;
    const nodeRule = NODES[type];
    if (!nodeRule) throw new HttpError(400, `Unsupported content in this document (${String(type).slice(0, 30)}).`);
    const out: Record<string, unknown> = { type };
    const attrs = nodeRule((n.attrs as Record<string, unknown>) ?? {});
    if (attrs) out.attrs = attrs;
    if (type === 'text') {
      if (typeof n.text !== 'string' || !n.text) throw new HttpError(400, 'The document content is not valid.');
      textLength += n.text.length;
      if (textLength > LIMITS.text) throw new HttpError(400, 'This document is too long.');
      out.text = n.text;
      line += n.text;
      if (Array.isArray(n.marks) && n.marks.length) {
        out.marks = n.marks.slice(0, 10).map((m) => {
          const mark = m as Record<string, unknown>;
          const markRule = MARKS[mark.type as string];
          if (!markRule) throw new HttpError(400, 'Unsupported formatting in this document.');
          const markAttrs = markRule((mark.attrs as Record<string, unknown>) ?? {});
          return markAttrs ? { type: mark.type, attrs: markAttrs } : { type: mark.type };
        });
      }
      return out;
    }
    if (type === 'taskItem') pendingPrefix = (attrs as { checked: boolean }).checked ? '[x] ' : '[ ] ';
    if (type === 'hardBreak') {
      lines.push(line);
      line = '';
    }
    if (n.content !== undefined) {
      if (!Array.isArray(n.content)) throw new HttpError(400, 'The document content is not valid.');
      out.content = n.content.map((child) => walk(child, depth + 1));
    }
    if (BLOCKS.has(type) && line) {
      lines.push(pendingPrefix + line);
      pendingPrefix = '';
      line = '';
    }
    return out;
  };
  const content = walk(input, 0);
  if (content.type !== 'doc') throw new HttpError(400, 'The document content is not valid.');
  if (line) lines.push(line);
  return { content: content as RichText, text: lines.join('\n') };
}

export const emptyDoc = (): RichText => ({ type: 'doc', content: [{ type: 'paragraph' }] });
