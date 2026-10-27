import { useEffect, useRef, useState } from 'react';
import { useGo } from '@/components/AppLink';
import { Dialog } from '@/components/ui';
import { useActor } from '@/lib/session';

/** `g` then a letter goes to a page. */
const GO_TO: { key: string; label: string; to: string; staff?: boolean; admin?: boolean }[] = [
  { key: 'o', label: 'Overview', to: '/' },
  { key: 'c', label: 'Clients', to: '/clients' },
  { key: 'a', label: 'Assets', to: '/assets', staff: true },
  { key: 'd', label: 'Documents', to: '/documents', staff: true },
  { key: 'p', label: 'Passwords', to: '/passwords', staff: true },
  { key: 'r', label: 'Reports', to: '/reports', staff: true },
  { key: 'e', label: 'Expirations', to: '/expirations', staff: true },
  { key: 'u', label: 'People and access', to: '/admin/users', admin: true },
];
/** Ctrl on Windows and Linux, ⌘ on a Mac: what opens search with K. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
/** How long after `g` the second key counts. */
const CHORD_MS = 1500;
/** The account menu opens the sheet with this event. */
export const SHOW_SHORTCUTS = 'atlas:shortcuts';

/** Typing into a field, or a window that's open, takes the keys for itself. */
function busy(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el?.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return true;
  return !!document.querySelector('dialog[open]');
}

const Key = ({ children }: { children: string }) => (
  <kbd className="inline-grid min-w-6 place-items-center rounded border border-border-strong bg-surface-2 px-1.5 py-0.5 font-mono text-xs font-semibold text-text">
    {children}
  </kbd>
);

/**
 * Keys for moving around without the mouse: `?` shows them all, `/` searches, and `g` then a letter goes to a page.
 * Ctrl+K (⌘K) search is the command palette's own.
 */
export function KeyboardShortcuts({ onSearch }: { onSearch: () => void }) {
  const actor = useActor();
  const go = useGo();
  const [open, setOpen] = useState(false);
  const pending = useRef(0);
  const pages = GO_TO.filter((p) => (!p.staff || actor.isStaff) && (!p.admin || actor.isAdmin));

  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || busy(e)) return;
      if (pending.current && Date.now() - pending.current < CHORD_MS) {
        pending.current = 0;
        const page = pages.find((p) => p.key === e.key.toLowerCase());
        if (page) {
          e.preventDefault();
          go(page.to);
        }
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === '/') {
        e.preventDefault();
        onSearch();
      } else if (e.key === 'g') pending.current = Date.now();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(SHOW_SHORTCUTS, show);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(SHOW_SHORTCUTS, show);
    };
  }, [go, onSearch, pages]);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" size="sm">
      <div className="space-y-5 text-sm">
        <section>
          <h3 className="mb-2 font-semibold">Anywhere</h3>
          <dl className="space-y-2">
            {(
              [
                [[MOD, 'K'], 'Search and go to'],
                [['/'], 'Search'],
                [['?'], 'Show these shortcuts'],
              ] as const
            ).map(([keys, label]) => (
              <div key={label} className="flex items-center justify-between gap-4">
                <dt className="text-text-2">{label}</dt>
                <dd className="flex gap-1">
                  {keys.map((k) => (
                    <Key key={k}>{k}</Key>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3 className="mb-2 font-semibold">Go to</h3>
          <dl className="space-y-2">
            {pages.map((p) => (
              <div key={p.key} className="flex items-center justify-between gap-4">
                <dt className="text-text-2">{p.label}</dt>
                <dd className="flex items-center gap-1">
                  <Key>g</Key>
                  <span className="text-xs text-muted">then</span>
                  <Key>{p.key}</Key>
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <p className="text-xs text-muted">Shortcuts don&rsquo;t act while you&rsquo;re typing in a field.</p>
      </div>
    </Dialog>
  );
}
