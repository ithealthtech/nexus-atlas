import { useEffect, useState } from 'react';
import { DOCUMENT_STATUS_LABELS, REPORTABLE_FIELD_TYPES, type RichText } from '@atlas/shared';
import { useAsset, useDocument, useLayouts } from '@/lib/queries';
import { relativeTime } from '@/lib/format';

// Links to an asset or a document, wherever they are: lists, search, relations, reports, the activity feed.
const PATTERN = /\/(assets|documents)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
const DELAY = 450;
const WIDTH = 300;

type Target = { kind: 'assets' | 'documents'; id: string; rect: DOMRect };

/**
 * Pausing on a link to an asset or document shows a small card with what it is, so you can tell similar names
 * apart without opening each. Only with a mouse: touch screens have no hover, and the card never takes focus or
 * clicks (the page the link opens has the same details, for keyboards and screen readers).
 */
export function HoverPeek() {
  const [target, setTarget] = useState<Target | null>(null);
  useEffect(() => {
    if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Element | null = null;
    const over = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.('a[href]') ?? null;
      if (link === current) return;
      current = link;
      clearTimeout(timer);
      const match = link && !link.closest('[data-no-peek]') ? PATTERN.exec(link.getAttribute('href') ?? '') : null;
      if (!match) {
        setTarget(null);
        return;
      }
      timer = setTimeout(
        () =>
          setTarget({
            kind: match[1]!.toLowerCase() as Target['kind'],
            id: match[2]!.toLowerCase(),
            rect: link!.getBoundingClientRect(),
          }),
        DELAY,
      );
    };
    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTarget(null);
    };
    document.addEventListener('mouseover', over);
    for (const type of ['mousedown', 'keydown', 'scroll'] as const) document.addEventListener(type, hide, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mouseover', over);
      for (const type of ['mousedown', 'keydown', 'scroll'] as const) document.removeEventListener(type, hide, true);
    };
  }, []);
  if (!target) return null;
  // Below the link, or above it near the bottom of the window; kept inside the window sideways.
  const { rect } = target;
  const below = rect.bottom + 220 < window.innerHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 rounded-lg border border-border bg-surface p-4 text-sm shadow-lg"
      style={{
        width: WIDTH,
        left,
        ...(below ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      }}
    >
      {target.kind === 'assets' ? <AssetPeek id={target.id} /> : <DocumentPeek id={target.id} />}
    </div>
  );
}

function Loading() {
  return <p className="text-muted">Loading…</p>;
}

function AssetPeek({ id }: { id: string }) {
  const { data, isError } = useAsset(id);
  const layouts = useLayouts();
  if (isError) return <p className="text-muted">Not available.</p>;
  if (!data) return <Loading />;
  const layout = layouts.data?.find((l) => l.id === data.layoutId);
  // Fields shown in lists first, then the rest; short values only.
  const fields = [...(layout?.fields ?? [])]
    .filter((f) => REPORTABLE_FIELD_TYPES.includes(f.type))
    .sort((a, b) => Number(b.showInList) - Number(a.showInList))
    .map((f) => {
      const v = data.fields[f.key];
      const text = Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '');
      return { label: f.label, text };
    })
    .filter((f) => f.text)
    .slice(0, 4);
  return (
    <>
      <p className="truncate font-semibold">{data.name}</p>
      <p className="truncate text-xs text-muted">
        {data.layoutName} · {data.clientName} · <span className="capitalize">{data.status}</span>
      </p>
      {fields.length > 0 && (
        <dl className="mt-3 space-y-1">
          {fields.map((f) => (
            <div key={f.label} className="flex gap-2">
              <dt className="w-24 shrink-0 truncate text-muted">{f.label}</dt>
              <dd className="min-w-0 truncate">{f.text}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-3 text-xs text-muted">
        Updated {relativeTime(data.updatedAt)}
        {data.updatedByName && ` by ${data.updatedByName}`}
      </p>
    </>
  );
}

/** The opening words of a document, from its rich text. */
function excerpt(content: RichText, max = 180): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (node: unknown) => {
    if (length > max || !node || typeof node !== 'object') return;
    const n = node as { text?: unknown; content?: unknown[] };
    if (typeof n.text === 'string') {
      parts.push(n.text);
      length += n.text.length;
    }
    if (Array.isArray(n.content))
      for (const child of n.content) {
        walk(child);
        if (length > max) return;
        parts.push(' ');
      }
  };
  walk(content);
  const text = parts.join('').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function DocumentPeek({ id }: { id: string }) {
  const { data, isError } = useDocument(id);
  if (isError) return <p className="text-muted">Not available.</p>;
  if (!data) return <Loading />;
  const words = excerpt(data.content);
  return (
    <>
      <p className="truncate font-semibold">{data.title}</p>
      <p className="truncate text-xs text-muted">
        {data.clientName ?? 'Knowledge base'} · {DOCUMENT_STATUS_LABELS[data.status]}
      </p>
      {words && <p className="mt-3 line-clamp-3 text-text-2">{words}</p>}
      <p className="mt-3 text-xs text-muted">
        Updated {relativeTime(data.updatedAt)}
        {data.updatedByName && ` by ${data.updatedByName}`}
      </p>
    </>
  );
}
