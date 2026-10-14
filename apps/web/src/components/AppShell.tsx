import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  ArrowLeft,
  BookOpen,
  Building2,
  ChevronRight,
  ChevronsUpDown,
  House,
  KeyRound,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Search,
  Settings2,
  Sun,
  UserCircle,
  X,
  type LucideIcon,
} from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { Avatar } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useClients, useFavorites, useWorkspacePrefs } from '@/lib/queries';
import { useActor, useApplySession } from '@/lib/session';
import { useVaultPolicy } from '@/lib/vault';
import { applyTheme, storedTheme, type Theme } from '@/lib/theme';

function NavLink({
  to,
  label,
  exact,
  onNavigate,
}: {
  to: string;
  label: string;
  exact?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      activeOptions={{ exact: !!exact }}
      className="nav-link block truncate rounded-md px-2.5 py-[7px] text-[13.5px] text-sidebar-text transition-colors hover:bg-sidebar-2 data-[status=active]:bg-sidebar-2 data-[status=active]:font-semibold data-[status=active]:text-sidebar-active"
    >
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

function UserMenu({ row, side = 'right' }: { row?: boolean; side?: 'right' | 'top' | 'bottom' }) {
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
        className={cn(
          'rounded-md text-sidebar-text hover:bg-sidebar-2',
          row ? 'flex w-full items-center gap-2.5 p-2 text-left text-[13.5px]' : 'grid size-11 place-items-center',
        )}
        aria-label="Account menu"
        title={row ? undefined : actor.name}
      >
        <Avatar name={actor.name} size="sm" />
        {row && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-sidebar-active">{actor.name}</span>
              <span className="block truncate text-xs text-sidebar-muted">{actor.roleLabel}</span>
            </span>
            <ChevronsUpDown className="size-4 text-sidebar-muted" aria-hidden />
          </>
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          side={side}
          align={side === 'top' ? 'start' : 'end'}
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
          <Menu.Label className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted">Theme</Menu.Label>
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

type NavItem = { to: string; label: string; exact?: boolean };
type NavGroup = { title?: string; items: NavItem[] };
type Area = {
  id: 'home' | 'clients' | 'docs' | 'vault' | 'admin';
  /** The word under the icon on the rail. */
  label: string;
  /** The heading of its panel. */
  title: string;
  icon: LucideIcon;
  /** Where the rail takes you. */
  to: string;
  /** Address prefixes that belong to this area, most specific areas first. */
  paths: string[];
  groups: NavGroup[];
};

// Five areas instead of one long list. The rail shows the areas; the panel beside it shows the pages of the one
// you're in. Administration is an area of its own, so it stays out of the way of daily work.
function areas(actor: { isStaff: boolean; isAdmin: boolean }, personalVaults: boolean): Area[] {
  const list: Area[] = [
    {
      id: 'home',
      label: 'Home',
      title: 'Home',
      icon: House,
      to: '/',
      paths: ['/expirations', '/account'],
      groups: [
        {
          items: [
            { to: '/', label: 'Dashboard', exact: true },
            { to: '/expirations', label: 'Expirations' },
          ],
        },
      ],
    },
    {
      id: 'clients',
      label: 'Clients',
      title: 'Clients',
      icon: Building2,
      to: '/clients',
      paths: ['/clients', '/client-report'],
      groups: [{ items: [{ to: '/clients', label: 'All clients', exact: true }] }],
    },
    {
      id: 'docs',
      label: 'Docs',
      title: 'Documentation',
      icon: BookOpen,
      to: '/assets',
      paths: ['/assets', '/documents', '/checklists', '/checklist-runs'],
      groups: [
        {
          items: [
            { to: '/assets', label: 'Assets' },
            ...(actor.isStaff
              ? [
                  { to: '/documents', label: 'Knowledge base' },
                  { to: '/checklists', label: 'Checklists' },
                ]
              : []),
          ],
        },
      ],
    },
  ];
  if (actor.isStaff)
    list.push({
      id: 'vault',
      label: 'Vault',
      title: 'Passwords',
      icon: KeyRound,
      to: '/passwords',
      paths: ['/passwords', '/my-vault', '/password-health', '/sends', '/admin/rotation', '/admin/bitlocker'],
      groups: [
        {
          items: [
            { to: '/passwords', label: 'Passwords' },
            ...(personalVaults ? [{ to: '/my-vault', label: 'My vault' }] : []),
            { to: '/password-health', label: 'Password health' },
            { to: '/sends', label: 'Send' },
          ],
        },
        ...(actor.isAdmin
          ? [
              {
                title: 'Automation',
                items: [
                  { to: '/admin/rotation', label: 'Password rotation' },
                  { to: '/admin/bitlocker', label: 'BitLocker collector' },
                ],
              },
            ]
          : []),
      ],
    });
  if (actor.isAdmin)
    list.push({
      id: 'admin',
      label: 'Admin',
      title: 'Administration',
      icon: Settings2,
      to: '/admin/users',
      paths: ['/admin'],
      groups: [
        {
          title: 'People and security',
          items: [
            { to: '/admin/users', label: 'People & access' },
            { to: '/admin/groups', label: 'Groups' },
            { to: '/admin/vault-policies', label: 'Vault policies' },
            { to: '/admin/security', label: 'Security log' },
          ],
        },
        {
          title: 'Data',
          items: [
            { to: '/admin/layouts', label: 'Asset layouts' },
            { to: '/admin/data', label: 'Import & export' },
            { to: '/admin/duplicates', label: 'Duplicates' },
          ],
        },
        {
          title: 'System',
          items: [
            { to: '/admin/status', label: 'System status' },
            { to: '/admin/services', label: 'Services' },
            { to: '/admin/certificate', label: 'Certificate' },
            { to: '/admin/request-log', label: 'Request log' },
            { to: '/admin/webhooks', label: 'Webhooks' },
            { to: '/admin/updates', label: 'Updates' },
            { to: '/admin/theme', label: 'Theme' },
            { to: '/admin/settings', label: 'Settings' },
          ],
        },
      ],
    });
  return list;
}

/** The area an address belongs to. The vault claims its two administration pages before Admin does. */
function areaOf(list: Area[], pathname: string): Area {
  const within = (a: Area) => a.paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const order = ['vault', 'admin', 'clients', 'docs', 'home'];
  return (
    order.map((id) => list.find((a) => a.id === id)).find((a) => a && within(a)) ?? list.find((a) => a.id === 'home')!
  );
}

const FAVORITE_PATH = { client: '/clients', asset: '/assets', document: '/documents', password: '/passwords' } as const;

type MenuProps = { onNavigate?: () => void; onSearch: () => void };

/** The areas, the one the current page is in, and the links that go with it. Shared by all three menu styles. */
function useMenu() {
  const actor = useActor();
  // Shown to staff unless the organization turned personal vaults off.
  const policy = useVaultPolicy();
  const personalVaults = actor.isStaff && policy.data?.personalVaults !== false;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const list = areas(actor, personalVaults);
  const area = areaOf(list, pathname);
  const clients = [...(useClients().data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const favorites = useFavorites(actor.isStaff).data ?? [];
  return { actor, pathname, list, area, clients, favorites };
}

function SearchButton({ onSearch, className }: { onSearch: () => void; className?: string }) {
  return (
    <button
      onClick={onSearch}
      className={cn(
        'flex items-center gap-2 rounded-md bg-sidebar-2 px-2.5 py-2 text-left text-[13.5px] text-sidebar-muted hover:text-sidebar-active',
        className,
      )}
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate">Search…</span>
      <kbd className="rounded border border-current/25 px-1.5 text-[10px]">Ctrl K</kbd>
    </button>
  );
}

function Groups({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  return (
    <div className="flex-1 space-y-px overflow-y-auto">
      {groups.map((group, i) => (
        <div key={group.title ?? i} className={cn('space-y-px', i > 0 && 'pt-4')}>
          {group.title && <p className="px-2.5 pb-1 text-xs text-sidebar-muted">{group.title}</p>}
          {group.items.map((item) => (
            <NavLink key={item.to} {...item} onNavigate={onNavigate} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Rail and panel: the areas down the edge, and the pages of the current one beside them. */
function RailMenu({ onNavigate, onSearch }: MenuProps) {
  const { list, area, clients, favorites } = useMenu();
  const groups: NavGroup[] = [
    ...area.groups,
    // Every client is one click away from anywhere in the Clients area.
    ...(area.id === 'clients' && clients.length
      ? [
          {
            title: 'Go to',
            items: clients.slice(0, 60).map((c) => ({ to: `/clients/${c.id}`, label: c.name })),
          },
        ]
      : []),
    ...(area.id === 'home' && favorites.length
      ? [
          {
            title: 'Favourites',
            items: favorites.slice(0, 12).map((f) => ({
              to: `${FAVORITE_PATH[f.type as keyof typeof FAVORITE_PATH] ?? '/clients'}/${f.id}`,
              label: f.name,
            })),
          },
        ]
      : []),
  ];
  return (
    <nav aria-label="Main" className="flex h-full bg-sidebar">
      <div className="flex w-[4.25rem] shrink-0 flex-col items-center gap-1 border-r border-sidebar-2 py-3">
        <Link to="/" onClick={onNavigate} className="mb-3 text-sidebar-active" aria-label="Home page">
          <Logo compact />
        </Link>
        {list.map((a) => (
          <Link
            key={a.id}
            to={a.to}
            aria-current={a.id === area.id ? 'true' : undefined}
            className={cn(
              'flex w-14 flex-col items-center gap-1 rounded-md pt-2 pb-1.5 text-[11px] text-sidebar-muted hover:bg-sidebar-2 hover:text-sidebar-active',
              a.id === area.id && 'bg-sidebar-2 font-semibold text-sidebar-active',
            )}
          >
            <a.icon className={cn('size-[18px]', a.id === area.id && 'text-sidebar-accent')} aria-hidden />
            {a.label}
          </Link>
        ))}
        <div className="mt-auto">
          <UserMenu />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col px-2.5 pt-4 pb-3">
        <SearchButton onSearch={onSearch} className="mb-4 w-full" />
        <p className="mb-2 px-2.5 text-[15px] font-semibold text-sidebar-active">{area.title}</p>
        <Groups groups={groups} onNavigate={onNavigate} />
      </div>
    </nav>
  );
}

/** Pages of an area, as one flat list. */
const pagesOf = (area: Area | undefined) => area?.groups.flatMap((g) => g.items) ?? [];

/**
 * Sidebar: the pages used every day in one short list, then the clients you've starred. Administration replaces
 * the list while you're in it, with a way back.
 */
function SidebarMenu({ onNavigate, onSearch }: MenuProps) {
  const { pathname, list, clients, favorites } = useMenu();
  const find = (id: Area['id']) => list.find((a) => a.id === id);
  const admin = find('admin');
  const vault = find('vault');
  const inAdmin = !!admin && pathname.startsWith('/admin');
  const starred = favorites.filter((f) => f.type === 'client').map((f) => ({ to: `/clients/${f.id}`, label: f.name }));
  const groups: NavGroup[] = inAdmin
    ? [...admin.groups, ...(vault?.groups.slice(1) ?? [])]
    : [
        {
          items: [
            { to: '/', label: 'Dashboard', exact: true },
            { to: '/clients', label: 'Clients', exact: true },
            { to: '/expirations', label: 'Expirations' },
            ...pagesOf(find('docs')),
            ...(vault?.groups[0]?.items ?? []),
          ],
        },
        starred.length
          ? { title: 'Starred clients', items: starred.slice(0, 12) }
          : { title: 'Clients', items: clients.slice(0, 8).map((c) => ({ to: `/clients/${c.id}`, label: c.name })) },
      ].filter((g) => g.items.length);
  const foot =
    'flex items-center gap-2 rounded-md px-2.5 py-[7px] text-[13.5px] text-sidebar-text hover:bg-sidebar-2 hover:text-sidebar-active';
  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-sidebar px-2.5 pt-5 pb-2.5">
      <Link to="/" onClick={onNavigate} className="mb-5 px-2 text-sidebar-active" aria-label="Home page">
        <Logo />
      </Link>
      <SearchButton onSearch={onSearch} className="mb-4 w-full" />
      {inAdmin && (
        <>
          <Link to="/" onClick={onNavigate} className={cn(foot, 'mb-3 text-sidebar-muted')}>
            <ArrowLeft className="size-4" aria-hidden /> Back to Atlas
          </Link>
          <p className="mb-2 px-2.5 text-[15px] font-semibold text-sidebar-active">Administration</p>
        </>
      )}
      <Groups groups={groups} onNavigate={onNavigate} />
      <div className="mt-2 border-t border-sidebar-2 pt-2">
        {admin && !inAdmin && (
          <Link to={admin.to} onClick={onNavigate} className={foot}>
            <span className="flex-1">Administration</span>
            <ChevronRight className="size-4 text-sidebar-muted" aria-hidden />
          </Link>
        )}
        <UserMenu row side="top" />
      </div>
    </nav>
  );
}

/** Top bar: the areas across the top and the current area's pages in a row beneath, leaving the page full width. */
function TopMenu({ onSearch }: { onSearch: () => void }) {
  const { list, area, favorites } = useMenu();
  const starred = favorites.filter((f) => f.type === 'client').map((f) => ({ to: `/clients/${f.id}`, label: f.name }));
  const pages: NavItem[] = [...pagesOf(area), ...(area.id === 'clients' ? starred.slice(0, 8) : [])];
  return (
    <nav aria-label="Main">
      <div className="flex h-14 items-center gap-1 bg-sidebar px-5">
        <Link to="/" className="mr-5 shrink-0 text-sidebar-active" aria-label="Home page">
          <Logo />
        </Link>
        {list.map((a) => (
          <Link
            key={a.id}
            to={a.to}
            aria-current={a.id === area.id ? 'true' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-[13.5px] whitespace-nowrap text-sidebar-text hover:bg-sidebar-2 hover:text-sidebar-active',
              a.id === area.id && 'bg-sidebar-2 font-semibold text-sidebar-active',
            )}
          >
            {a.title}
          </Link>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <SearchButton onSearch={onSearch} className="w-64" />
          <UserMenu side="bottom" />
        </div>
      </div>
      <div className="flex h-10 items-stretch gap-1 overflow-x-auto border-b border-border bg-surface px-5">
        {pages.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeOptions={{ exact: !!item.exact }}
            className="flex items-center border-b-2 border-transparent px-2.5 text-[13.5px] whitespace-nowrap text-text-2 hover:text-text data-[status=active]:border-primary data-[status=active]:font-semibold data-[status=active]:text-text"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  // Each person's own choice (Account). Phones always get a drawer: the rail, or the sidebar list.
  const menu = useWorkspacePrefs().data?.menu ?? 'rail';
  const Drawer = menu === 'rail' ? RailMenu : SidebarMenu;
  return (
    <div className={cn('min-h-screen print:p-0', menu === 'top' ? 'lg:pt-24' : 'lg:pl-(--sidebar-width)')}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:shadow"
      >
        Skip to content
      </a>
      {menu === 'top' ? (
        <div className="fixed inset-x-0 top-0 z-30 hidden lg:block print:hidden">
          <TopMenu onSearch={() => setSearching(true)} />
        </div>
      ) : (
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-(--sidebar-width) lg:block print:hidden">
          <Drawer onSearch={() => setSearching(true)} />
        </aside>
      )}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden print:hidden">
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
            <Drawer
              onNavigate={() => setOpen(false)}
              onSearch={() => {
                setOpen(false);
                setSearching(true);
              }}
            />
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-3 rounded-lg p-2 text-sidebar-muted hover:text-sidebar-active"
              aria-label="Close navigation"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[90rem] px-4 py-7 outline-none sm:px-10 sm:py-10">
        {children}
      </main>
      <CommandPalette open={searching} onOpenChange={setSearching} />
    </div>
  );
}
