import { useMemo, useState } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Building2, Check, ChevronsUpDown, Search } from 'lucide-react';
import { useClients } from '@/lib/queries';
import { cn } from '@/lib/cn';

/**
 * Sidebar client switcher. Shows the client you're in (or "All clients") and switches to another client while
 * keeping the section: Harbor's Passwords → Northline's Passwords.
 */
export function ClientPicker({ orgName, onNavigate }: { orgName: string; onNavigate?: () => void }) {
  const { data } = useClients();
  const clients = useMemo(() => data ?? [], [data]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [filter, setFilter] = useState('');
  const match = /^\/clients\/([^/]+)(\/.*)?$/.exec(pathname);
  const currentId = match?.[1];
  const section = match?.[2] ?? '';
  const current = clients.find((c) => c.id === currentId);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (q ? clients.filter((c) => c.name.toLowerCase().includes(q)) : clients).slice(0, 50);
  }, [clients, filter]);
  const item =
    'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-3';

  return (
    <Menu.Root modal={false} onOpenChange={(open) => !open && setFilter('')}>
      <Menu.Trigger
        className="mb-5 flex w-full items-center gap-2.5 rounded-lg border border-sidebar-2 px-3 py-2.5 text-left hover:bg-sidebar-2"
        aria-label={`Client: ${current?.name ?? 'All clients'}. Switch client`}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-sidebar-2 text-[11px] font-bold text-sidebar-accent">
          {(current?.name ?? orgName).slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-sidebar-active">
            {current?.name ?? 'All clients'}
          </span>
          <span className="block truncate text-[11px] text-sidebar-muted">{orgName}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-sidebar-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="z-50 w-(--radix-dropdown-menu-trigger-width) min-w-60 rounded-xl border border-border bg-surface p-1.5 text-text shadow-xl"
        >
          {clients.length > 8 && (
            <label className="relative mb-1 block">
              <span className="sr-only">Find a client</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted"
                aria-hidden
              />
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                // Keep typing in the box instead of the menu's type-to-select.
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowDown' && e.key !== 'Escape') e.stopPropagation();
                }}
                placeholder="Find a client…"
                className="h-9 w-full rounded-md border border-border bg-surface-2 pr-2 pl-8 text-sm outline-none focus:border-primary"
              />
            </label>
          )}
          <Menu.Item asChild className={item}>
            <Link to="/clients" onClick={onNavigate}>
              <Building2 className="size-4 text-muted" aria-hidden />
              <span className="flex-1">All clients</span>
              {!current && <Check className="size-4 text-primary" aria-label="Current" />}
            </Link>
          </Menu.Item>
          <Menu.Separator className="my-1 h-px bg-border" />
          <div className="max-h-72 overflow-y-auto">
            {shown.map((c) => (
              <Menu.Item key={c.id} asChild className={cn(item, c.id === currentId && 'font-semibold')}>
                <Link to={`/clients/${c.id}${section}`} onClick={onNavigate}>
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.id === currentId && <Check className="size-4 text-primary" aria-label="Current" />}
                </Link>
              </Menu.Item>
            ))}
            {!shown.length && <p className="px-2.5 py-2 text-sm text-muted">No clients match.</p>}
          </div>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
