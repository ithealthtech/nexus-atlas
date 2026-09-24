import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowDownUp,
  ArrowUpCircle,
  Gauge,
  BookOpen,
  KeyRound,
  Building2,
  ChevronsUpDown,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  CalendarClock,
  ScrollText,
  Settings2,
  UsersRound,
  Search,
  Server,
  Sun,
  UserCircle,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { Avatar } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useActor, useApplySession } from '@/lib/session';
import { applyTheme, storedTheme, type Theme } from '@/lib/theme';

function NavLink({
  to,
  icon: Icon,
  label,
  exact,
  onNavigate,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  exact?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      activeOptions={{ exact: !!exact }}
      className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-sidebar-text transition-colors hover:bg-sidebar-2 data-[status=active]:bg-sidebar-2 data-[status=active]:font-semibold data-[status=active]:text-white"
    >
      <Icon className="size-[18px] text-sidebar-muted group-data-[status=active]:text-accent" aria-hidden />
      {label}
    </Link>
  );
}

export function useSignOut() {
  const apply = useApplySession();
  return async () => {
    await api('/session', { method: 'DELETE' }).catch(() => undefined);
    // apply(null) also drops every other cached query. Clearing the whole cache here instead would detach the
    // session query the app is watching, leaving the workspace on screen after signing out.
    apply(null);
  };
}

function UserMenu() {
  const actor = useActor();
  const signOut = useSignOut();
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const choose = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };
  const item =
    'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-3 [&_svg]:size-4 [&_svg]:text-muted';
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        className="flex w-full items-center gap-3 rounded-lg p-2 text-left text-sm text-sidebar-text hover:bg-sidebar-2"
        aria-label="Account menu"
      >
        <Avatar name={actor.name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-white">{actor.name}</span>
          <span className="block truncate text-xs text-sidebar-muted">{actor.roleLabel}</span>
        </span>
        <ChevronsUpDown className="size-4 text-sidebar-muted" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-60 rounded-xl border border-border bg-surface p-1.5 text-text shadow-xl"
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-semibold">{actor.name}</p>
            <p className="truncate text-xs text-muted">{actor.email}</p>
          </div>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item asChild className={item}>
            <Link to="/account">
              <UserCircle /> Your account
            </Link>
          </Menu.Item>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Label className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
            Theme
          </Menu.Label>
          <Menu.RadioGroup value={theme} onValueChange={(v) => choose(v as Theme)}>
            {(
              [
                ['light', 'Light', Sun],
                ['dark', 'Dark', Moon],
                ['system', 'Match system', Monitor],
              ] as const
            ).map(([value, label, Icon]) => (
              <Menu.RadioItem
                key={value}
                value={value}
                className={cn(item, 'data-[state=checked]:font-semibold data-[state=checked]:text-primary')}
              >
                <Icon /> {label}
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
          <Menu.Separator className="my-1 h-px bg-border" />
          <Menu.Item className={item} onSelect={signOut}>
            <LogOut /> Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Sidebar({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch: () => void }) {
  const actor = useActor();
  return (
    <div className="flex h-full flex-col bg-sidebar px-3 pt-5 pb-3">
      <Link to="/" onClick={onNavigate} className="mb-6 px-2 text-white">
        <Logo />
      </Link>
      <div className="mb-5 flex items-center gap-2.5 rounded-lg border border-sidebar-2 px-3 py-2.5">
        <span className="grid size-7 place-items-center rounded-md bg-sidebar-2 text-[11px] font-bold text-accent">
          {actor.organization.name.slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-white">{actor.organization.name}</span>
      </div>
      <button
        onClick={onSearch}
        className="mb-4 flex w-full items-center gap-2.5 rounded-lg bg-sidebar-2 px-3 py-2.5 text-left text-sm text-sidebar-muted hover:text-white"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1">Search…</span>
        <kbd className="rounded border border-white/10 px-1.5 text-[10px]">Ctrl K</kbd>
      </button>
      <nav aria-label="Main" className="flex-1 space-y-1 overflow-y-auto">
        <p className="px-3 pt-1 pb-2 text-[11px] font-semibold tracking-[0.12em] text-sidebar-muted uppercase">
          Workspace
        </p>
        <NavLink to="/" exact icon={LayoutDashboard} label="Dashboard" onNavigate={onNavigate} />
        <NavLink to="/clients" icon={Building2} label="Clients" onNavigate={onNavigate} />
        <NavLink to="/assets" icon={Server} label="Assets" onNavigate={onNavigate} />
        {actor.isStaff && <NavLink to="/documents" icon={BookOpen} label="Knowledge base" onNavigate={onNavigate} />}
        {actor.isStaff && <NavLink to="/passwords" icon={KeyRound} label="Passwords" onNavigate={onNavigate} />}
        <NavLink to="/expirations" icon={CalendarClock} label="Expirations" onNavigate={onNavigate} />
        {actor.isAdmin && (
          <>
            <p className="px-3 pt-5 pb-2 text-[11px] font-semibold tracking-[0.12em] text-sidebar-muted uppercase">
              Administration
            </p>
            <NavLink to="/admin/users" icon={Users} label="People & access" onNavigate={onNavigate} />
            <NavLink to="/admin/groups" icon={UsersRound} label="Groups" onNavigate={onNavigate} />
            <NavLink to="/admin/layouts" icon={LayoutTemplate} label="Asset layouts" onNavigate={onNavigate} />
            <NavLink to="/admin/security" icon={ScrollText} label="Security log" onNavigate={onNavigate} />
            <NavLink to="/admin/data" icon={ArrowDownUp} label="Import & export" onNavigate={onNavigate} />
            <NavLink to="/admin/status" icon={Gauge} label="System status" onNavigate={onNavigate} />
            <NavLink to="/admin/updates" icon={ArrowUpCircle} label="Updates" onNavigate={onNavigate} />
            <NavLink to="/admin/settings" icon={Settings2} label="Settings" onNavigate={onNavigate} />
          </>
        )}
      </nav>
      <div className="border-t border-sidebar-2 pt-3">
        <UserMenu />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  return (
    <div className="min-h-screen lg:pl-64">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <Sidebar onSearch={() => setSearching(true)} />
      </aside>
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg p-2 hover:bg-surface-3"
          aria-label="Open navigation"
        >
          <MenuIcon className="size-5" />
        </button>
        <Logo compact />
        <button
          onClick={() => setSearching(true)}
          className="ml-auto rounded-lg p-2 hover:bg-surface-3"
          aria-label="Search"
        >
          <Search className="size-5" />
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <button
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          />
          <div className="relative h-full w-72 max-w-[85vw]">
            <Sidebar
              onNavigate={() => setOpen(false)}
              onSearch={() => {
                setOpen(false);
                setSearching(true);
              }}
            />
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-3 rounded-lg p-2 text-sidebar-muted hover:text-white"
              aria-label="Close navigation"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-7 outline-none sm:px-8 sm:py-9">
        {children}
      </main>
      <CommandPalette open={searching} onOpenChange={setSearching} />
    </div>
  );
}
