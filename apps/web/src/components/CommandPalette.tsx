import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, BookOpen, Building2, LayoutDashboard, Search, Server } from 'lucide-react';
import type { SearchResult } from '@atlas/shared';
import { ItemIcon, itemHref } from '@/components/ItemIcon';
import { useGo } from '@/components/AppLink';
import { useSearch } from '@/lib/queries';
import { cn } from '@/lib/cn';

type Entry = { key: string; title: string; subtitle: string; href: string; icon: React.ReactNode };
const QUICK: Entry[] = [
  { key: 'dash', title: 'Dashboard', subtitle: 'Go to', href: '/', icon: <LayoutDashboard className="size-4" /> },
  { key: 'clients', title: 'Clients', subtitle: 'Go to', href: '/clients', icon: <Building2 className="size-4" /> },
  { key: 'assets', title: 'Assets', subtitle: 'Go to', href: '/assets', icon: <Server className="size-4" /> },
  { key: 'kb', title: 'Knowledge base', subtitle: 'Go to', href: '/documents', icon: <BookOpen className="size-4" /> },
];

/** Global Ctrl+K / ⌘K search and navigation. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const go = useGo();
  const results = useSearch(q);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpenChange]);
  useEffect(() => {
    const d = dialog.current;
    if (open && d && !d.open) d.showModal();
    if (!open && d?.open) d.close();
  }, [open]);

  const entries: Entry[] = useMemo(() => {
    if (!q.trim()) return QUICK;
    return (results.data ?? []).map((r: SearchResult) => ({
      key: `${r.type}:${r.id}`,
      title: r.title,
      subtitle: [r.subtitle, r.clientName].filter(Boolean).join(' · ') + (r.snippet ? ` — ${r.snippet}` : ''),
      href: itemHref(r),
      icon: <ItemIcon type={r.type} className="size-7" />,
    }));
  }, [q, results.data]);
  const close = () => {
    onOpenChange(false);
    setQ('');
    setActive(0);
  };
  const choose = (entry?: Entry) => {
    if (!entry) return;
    close();
    go(entry.href);
  };
  return (
    <dialog
      ref={dialog}
      onClose={close}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label="Search Atlas"
      className="animate-dialog mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-2xl overflow-hidden rounded-2xl border border-border bg-surface p-0 text-text shadow-2xl"
    >
      {open && (
        <div>
          <label className="flex items-center gap-3 border-b border-border px-4">
            <Search className="size-5 text-muted" aria-hidden />
            <span className="sr-only">Search</span>
            <input
              autoFocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, entries.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  choose(entries[active]);
                }
              }}
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-results"
              aria-activedescendant={entries[active] ? `palette-${active}` : undefined}
              placeholder="Search clients, assets, documents, contacts…"
              className="h-14 w-full bg-transparent text-base outline-none placeholder:text-muted"
            />
            <kbd className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted">Esc</kbd>
          </label>
          <ul id="palette-results" role="listbox" className="max-h-[55vh] overflow-y-auto p-2">
            {entries.map((entry, i) => (
              <li
                key={entry.key}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(entry)}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5',
                  i === active && 'bg-primary-soft',
                )}
              >
                <span className="grid size-7 shrink-0 place-items-center text-text-2">{entry.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{entry.title}</span>
                  <span className="block truncate text-xs text-muted">{entry.subtitle}</span>
                </span>
                {i === active && <ArrowRight className="size-4 text-primary" aria-hidden />}
              </li>
            ))}
            {q.trim() && !results.isFetching && !entries.length && (
              <li className="px-3 py-10 text-center text-sm text-muted">No results for &ldquo;{q}&rdquo;.</li>
            )}
          </ul>
          <p className="border-t border-border px-4 py-2 text-xs text-muted">
            ↑↓ to move · Enter to open · Results only include what you can access
          </p>
        </div>
      )}
    </dialog>
  );
}
