import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  BadgeCheck,
  BookOpen,
  Building2,
  Cable,
  CalendarClock,
  ChartColumn,
  ChevronRight,
  ChevronsUpDown,
  ClipboardCheck,
  Cog,
  Copy,
  Download,
  FileClock,
  Gauge,
  HardDrive,
  HeartPulse,
  House,
  KeyRound,
  KeySquare,
  LayoutDashboard,
  LayoutTemplate,
  Lock,
  LogIn,
  LogOut,
  Mail,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Palette,
  PanelLeft,
  RotateCw,
  ScrollText,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Star,
  Sun,
  UserCircle,
  Users,
  UsersRound,
  Vault,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { MenuStyle } from '@atlas/shared';
import { CommandPalette } from '@/components/CommandPalette';
import { Avatar, Dialog } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { SECTION_TAB } from '@/lib/tabs';
import { useClients, useFavorites, useWorkspacePrefs } from '@/lib/queries';
import { useActor, useApplySession } from '@/lib/session';
import { useVaultPolicy } from '@/lib/vault';
import { applyTheme, storedTheme, type Theme } from '@/lib/theme';

export function useSignOut() {
  const apply = useApplySession();
  return async () => {
    await api('/session', { method: 'DELETE' }).catch(() => undefined);
    // apply(null) also drops every other cached query. Clearing the whole cache here instead would detach the
    // session query the app is watching, leaving the workspace on screen after signing out.
    apply(null);
  };
}

function UserMenu({
  row,
  header,
  side = 'right',
}: {
  row?: boolean;
  header?: boolean;
  side?: 'right' | 'top' | 'bottom';
}) {
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
          header
            ? 'flex items-center gap-2.5 py-1 pr-2 pl-1 text-left hover:bg-surface-2'
            : row
              ? 'flex w-full items-center gap-2.5 p-2 text-left text-[13.5px]'
              : 'grid size-11 place-items-center',
        )}
        aria-label="Account menu"
        title={row || header ? undefined : actor.name}
      >
        <Avatar name={actor.name} size="sm" />
        {header && (
          <span className="hidden min-w-0 leading-tight md:block">
            <span className="block max-w-44 truncate text-xs font-[650] text-text">{actor.name}</span>
            <span className="block max-w-44 truncate text-[11px] text-muted">{actor.email}</span>
          </span>
        )}
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
          className="z-50 w-60 rounded-md border border-border bg-surface p-1.5 text-text"
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

type NavItem = { to: string; label: string; exact?: boolean; icon?: LucideIcon };
type NavGroup = { title?: string; items: NavItem[] };
type Area = {
  id: 'home' | 'clients' | 'docs' | 'vault' | 'admin';
  /** The word under the icon on the rail. */
  label: string;
  /** The heading of its panel and its name everywhere else. */
  title: string;
  icon: LucideIcon;
  /** Where the area's link takes you. */
  to: string;
  /** Address prefixes that belong to this area, most specific areas first. */
  paths: string[];
  groups: NavGroup[];
};

// Five areas group the routes. Each menu style shows them its own way (see MenuStyle).
function areas(actor: { isStaff: boolean; isAdmin: boolean }, personalVaults: boolean): Area[] {
  const list: Area[] = [
    {
      id: 'home',
      label: 'Overview',
      title: 'Overview',
      icon: House,
      to: '/',
      paths: ['/expirations', '/account', '/reports'],
      groups: [
        {
          items: [
            { to: '/', label: 'Dashboard', exact: true, icon: LayoutDashboard },
            { to: '/expirations', label: 'Expirations', icon: CalendarClock },
            { to: '/reports', label: 'Reports', icon: ChartColumn },
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
      groups: [{ items: [{ to: '/clients', label: 'All clients', exact: true, icon: Building2 }] }],
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
            { to: '/assets', label: 'Assets', icon: HardDrive },
            ...(actor.isStaff
              ? [
                  { to: '/documents', label: 'Knowledge base', icon: BookOpen },
                  { to: '/checklists', label: 'Checklists', icon: ClipboardCheck },
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
      title: 'Password Vault',
      icon: KeyRound,
      to: '/passwords',
      paths: ['/passwords', '/my-vault', '/password-health', '/sends', '/admin/rotation', '/admin/bitlocker'],
      groups: [
        {
          items: [
            { to: '/passwords', label: 'Passwords', icon: KeyRound },
            ...(personalVaults ? [{ to: '/my-vault', label: 'My vault', icon: Vault }] : []),
            { to: '/password-health', label: 'Password health', icon: HeartPulse },
            { to: '/sends', label: 'Send', icon: Send },
          ],
        },
        ...(actor.isAdmin
          ? [
              {
                title: 'Automation',
                items: [
                  { to: '/admin/rotation', label: 'Password rotation', icon: RotateCw },
                  { to: '/admin/bitlocker', label: 'BitLocker collector', icon: Lock },
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
            { to: '/admin/users', label: 'People & access', icon: Users },
            { to: '/admin/groups', label: 'Groups', icon: UsersRound },
            { to: '/admin/vault-policies', label: 'Vault policies', icon: ShieldCheck },
            { to: '/admin/security', label: 'Security log', icon: ScrollText },
          ],
        },
        {
          title: 'Data',
          items: [
            { to: '/admin/layouts', label: 'Asset layouts', icon: LayoutTemplate },
            { to: '/admin/data', label: 'Import & export', icon: ArrowLeftRight },
            { to: '/admin/duplicates', label: 'Duplicates', icon: Copy },
          ],
        },
        {
          title: 'System',
          items: [
            { to: '/admin/status', label: 'System status', icon: Activity },
            { to: '/admin/services', label: 'Services', icon: Cog },
            { to: '/admin/certificate', label: 'Certificate', icon: BadgeCheck },
            { to: '/admin/remote-access', label: 'Remote access', icon: Cable },
            { to: '/admin/request-log', label: 'Request log', icon: FileClock },
            { to: '/admin/webhooks', label: 'Webhooks', icon: Webhook },
            { to: '/admin/updates', label: 'Updates', icon: Download },
          ],
        },
        {
          title: 'Settings',
          items: [
            { to: '/admin/email', label: 'Email & alerts', icon: Mail },
            { to: '/admin/monitoring', label: 'Monitoring', icon: Gauge },
            { to: '/admin/sign-in', label: 'Sign-in', icon: LogIn },
            { to: '/admin/api-keys', label: 'API keys', icon: KeySquare },
            { to: '/admin/theme', label: 'Theme', icon: Palette },
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

/** The header's square icon buttons (navigation, sign out). */
const ICON_BUTTON =
  'grid size-[33px] shrink-0 place-items-center rounded-[5px] text-muted hover:bg-surface-2 hover:text-text';
/** A page link in the rail's panel and the sidebar. */
const MENU_LINK =
  'flex items-center gap-3 rounded-lg px-[13px] text-[13px] font-[560] text-sidebar-text hover:bg-sidebar-2 hover:text-sidebar-active data-[status=active]:bg-sidebar-2 data-[status=active]:font-[650] data-[status=active]:text-sidebar-accent';
const GROUP_LABEL = 'px-[13px] text-[10px] font-bold tracking-[0.12em] text-sidebar-muted uppercase';

/** Grouped page links, as the rail's panel and the sidebar list them. */
function MenuGroups({
  groups,
  icons,
  compact,
  onNavigate,
}: {
  groups: NavGroup[];
  icons?: boolean;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <>
      {groups.map((group, i) => (
        <div key={group.title ?? i} className={cn('space-y-0.5', i > 0 && (compact ? 'mt-3 border-t pt-3' : 'mt-5'))}>
          {group.title && !compact && <p className={cn(GROUP_LABEL, 'mb-2')}>{group.title}</p>}
          {group.items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              activeOptions={{ exact: item.exact ?? false }}
              title={compact ? item.label : undefined}
              className={cn(MENU_LINK, icons ? 'h-10' : 'h-9', compact && 'justify-center px-0')}
            >
              {icons && item.icon && <item.icon className="size-[18px] shrink-0" aria-hidden />}
              <span className={compact ? 'sr-only' : 'truncate'}>{item.label}</span>
            </Link>
          ))}
        </div>
      ))}
    </>
  );
}

type MenuData = {
  list: Area[];
  area: Area;
  pathname: string;
  clients: { id: string; name: string }[];
  favorites: { id: string; type: string; name: string }[];
};

/** Rail and panel: the areas down the edge, and the pages of the one you're in beside them. */
function RailMenu({ list, area, clients, favorites, collapsed }: MenuData & { collapsed: boolean }) {
  const groups: NavGroup[] = [
    ...area.groups,
    // Every client is one click away from anywhere in the Clients area.
    ...(area.id === 'clients' && clients.length
      ? [{ title: 'Go to', items: clients.slice(0, 60).map((c) => ({ to: `/clients/${c.id}`, label: c.name })) }]
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
    <>
      <div className="flex w-17 shrink-0 flex-col items-center border-r border-border">
        <Link to="/" aria-label="Home page" className="flex h-[70px] shrink-0 items-center text-sidebar-active">
          <Logo compact />
        </Link>
        <nav aria-label="Main" className="flex flex-col items-center gap-1 pt-3">
          {list.map((a) => (
            <Link
              key={a.id}
              to={a.to}
              aria-current={a.id === area.id ? 'page' : undefined}
              title={a.title}
              className={cn(
                'flex w-14 flex-col items-center gap-1 rounded-lg pt-2 pb-1.5 text-[10.5px] leading-tight font-[560] text-sidebar-muted hover:bg-sidebar-2 hover:text-sidebar-active',
                a.id === area.id && 'bg-sidebar-2 font-[650] text-sidebar-accent hover:text-sidebar-accent',
              )}
            >
              <a.icon className="size-[18px]" aria-hidden />
              {a.label}
            </Link>
          ))}
        </nav>
      </div>
      {!collapsed && (
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="flex h-[70px] shrink-0 items-center px-[25px] text-[15px] font-bold text-sidebar-active">
            {area.title}
          </p>
          <nav aria-label="Workspace" className="flex-1 overflow-y-auto px-3 pb-5">
            <MenuGroups groups={groups} />
          </nav>
        </div>
      )}
    </>
  );
}

/**
 * Sidebar: the pages used every day in one short list, then the clients you've starred. Administration replaces
 * the list while you're in it, with a way back.
 */
function SidebarMenu({ list, pathname, clients, favorites, collapsed }: MenuData & { collapsed: boolean }) {
  const find = (id: Area['id']) => list.find((a) => a.id === id);
  const admin = find('admin');
  const vault = find('vault');
  const inAdmin = !!admin && pathname.startsWith('/admin') && !vault?.paths.some((p) => pathname.startsWith(p));
  const starred = favorites
    .filter((f) => f.type === 'client')
    .map((f) => ({ to: `/clients/${f.id}`, label: f.name, icon: Star }));
  const pages = (id: Area['id']) => find(id)?.groups[0]?.items ?? [];
  const groups: NavGroup[] = inAdmin
    ? [...admin.groups, ...(vault?.groups.slice(1) ?? [])]
    : [
        {
          items: [
            ...pages('home').slice(0, 1),
            { to: '/clients', label: 'Clients', exact: true, icon: Building2 },
            ...pages('home').slice(1),
            ...pages('docs'),
            ...pages('vault'),
          ],
        },
        ...(collapsed
          ? []
          : [
              starred.length
                ? { title: 'Starred clients', items: starred.slice(0, 12) }
                : {
                    title: 'Clients',
                    items: clients.slice(0, 8).map((c) => ({ to: `/clients/${c.id}`, label: c.name, icon: Building2 })),
                  },
            ]),
      ].filter((g) => g.items.length);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Link
        to="/"
        aria-label="Home page"
        className={cn('flex h-[70px] shrink-0 items-center text-sidebar-active', collapsed ? 'justify-center' : 'px-5')}
      >
        <Logo compact={collapsed} />
      </Link>
      <nav aria-label="Main" className={cn('flex-1 overflow-y-auto pt-4 pb-5', collapsed ? 'px-2' : 'px-3')}>
        {inAdmin ? (
          <>
            <Link
              to="/"
              title={collapsed ? 'Back to Atlas' : undefined}
              className={cn(MENU_LINK, 'mb-3 h-10', collapsed && 'justify-center px-0')}
            >
              <ArrowLeft className="size-[18px] shrink-0" aria-hidden />
              <span className={collapsed ? 'sr-only' : ''}>Back to Atlas</span>
            </Link>
            {!collapsed && <p className="mb-3 px-[13px] text-[15px] font-bold text-sidebar-active">Administration</p>}
          </>
        ) : (
          !collapsed && <p className={cn(GROUP_LABEL, 'mb-2.5')}>Workspace</p>
        )}
        <MenuGroups groups={groups} icons compact={collapsed} />
      </nav>
      {admin && !inAdmin && (
        <div className={cn('border-t border-border py-3', collapsed ? 'px-2' : 'px-3')}>
          <Link
            to={admin.to}
            title={collapsed ? admin.title : undefined}
            className={cn(MENU_LINK, 'h-10', collapsed && 'justify-center px-0')}
          >
            <Settings2 className="size-[18px] shrink-0" aria-hidden />
            <span className={collapsed ? 'sr-only' : 'flex-1'}>{admin.title}</span>
            {!collapsed && <ChevronRight className="size-4 text-sidebar-muted" aria-hidden />}
          </Link>
        </div>
      )}
    </div>
  );
}

/** The areas across the top bar, for the Top bar style. */
function TopAreas({ list, area }: MenuData) {
  return (
    <nav aria-label="Main" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {list.map((a) => (
        <Link
          key={a.id}
          to={a.to}
          aria-current={a.id === area.id ? 'page' : undefined}
          className={cn(
            'flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-[560] whitespace-nowrap text-sidebar-text hover:bg-sidebar-2 hover:text-sidebar-active',
            a.id === area.id && 'bg-sidebar-2 font-[650] text-sidebar-accent hover:text-sidebar-accent',
          )}
        >
          <a.icon className="size-4 shrink-0" aria-hidden />
          {a.title}
        </Link>
      ))}
    </nav>
  );
}

/** An area's pages as one row of tabs, or a grouped list beside the page when there are many (Administration). */
function WorkspaceNav({ area, beside, className }: { area: Area; beside?: boolean; className?: string }) {
  return beside ? (
    <nav
      aria-label="Workspace"
      className={cn(
        'mb-6 flex gap-x-6 overflow-x-auto border-b border-border pb-2 lg:mb-0 lg:block lg:space-y-5 lg:overflow-visible lg:border-0 lg:pb-0 print:hidden',
        className,
      )}
    >
      {area.groups.map((group, i) => (
        <div key={group.title ?? i} className="flex shrink-0 items-center gap-1 lg:block">
          {group.title && (
            <p className="mr-1 px-2.5 text-[10px] font-bold tracking-[0.12em] whitespace-nowrap text-muted uppercase lg:mr-0 lg:mb-1.5">
              {group.title}
            </p>
          )}
          {group.items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact ?? false }}
              className="block rounded-md px-2.5 py-1.5 text-[13px] font-medium whitespace-nowrap text-muted hover:bg-surface-3 hover:text-text data-[status=active]:bg-primary-soft data-[status=active]:font-semibold data-[status=active]:text-primary"
            >
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  ) : (
    <nav
      aria-label="Workspace"
      className={cn('flex flex-wrap items-center gap-x-[22px] border-b border-border print:hidden', className)}
    >
      {area.groups.map((group, i) => (
        <div key={group.title ?? i} className="contents">
          {group.title && (
            <span className="text-[10px] font-bold tracking-[0.12em] text-muted uppercase">{group.title}</span>
          )}
          {group.items.map((item) => (
            <Link key={item.to} to={item.to} activeOptions={{ exact: item.exact ?? false }} className={SECTION_TAB}>
              {item.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

function SearchBox({ onSearch }: { onSearch: () => void }) {
  return (
    <button
      onClick={onSearch}
      aria-label="Search or switch client"
      className="flex h-9 shrink-0 items-center gap-2.5 rounded-[5px] border border-border bg-surface-2 px-[11px] text-xs text-muted hover:border-border-strong hover:text-text sm:w-64"
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="hidden flex-1 truncate text-left whitespace-nowrap sm:inline">Search or switch client</span>
      <kbd className="hidden rounded-[3px] border border-border bg-surface px-1.5 py-px text-[10px] font-medium sm:inline">
        Ctrl K
      </kbd>
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const actor = useActor();
  const signOut = useSignOut();
  const policy = useVaultPolicy();
  const personalVaults = actor.isStaff && policy.data?.personalVaults !== false;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const allClients = useClients().data;
  const favorites = useFavorites(actor.isStaff).data ?? [];
  // Each person's own choice (Account → Menu). Phones always get the slide-out menu.
  const style: MenuStyle = useWorkspacePrefs().data?.menu ?? 'rail';
  const list = areas(actor, personalVaults);
  const area = areaOf(list, pathname);
  const clients = [...(allClients ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const menu: MenuData = { list, area, pathname, clients, favorites };
  const currentClient = clients.find((c) => pathname.startsWith(`/clients/${c.id}`));
  const page = list
    .flatMap((a) => a.groups.flatMap((g) => g.items))
    .filter((p) => pathname === p.to || (p.to !== '/' && pathname.startsWith(`${p.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  // Areas with many pages list them beside the page instead of in rows of tabs.
  const beside = area.groups.reduce((n, g) => n + g.items.length, 0) > 8;
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('atlas-sidebar-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((previous) => {
      try {
        localStorage.setItem('atlas-sidebar-collapsed', String(!previous));
      } catch {
        /* Still works for this visit. */
      }
      return !previous;
    });
  const side = style !== 'top';
  // Whether the menu on a computer already lists the area's pages; if so the page doesn't repeat them.
  const menuHasPages = (style === 'rail' && !collapsed) || style === 'sidebar' || (style === 'top' && !beside);
  const navigation = () => (
    <nav aria-label="Main" className="space-y-1">
      {list.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          onClick={() => setOpen(false)}
          aria-current={area.id === item.id ? 'page' : undefined}
          className={cn(
            'flex h-10 items-center gap-3 rounded-lg px-[13px] text-[13px] font-[560] text-sidebar-text hover:bg-sidebar-2 hover:text-sidebar-active',
            area.id === item.id && 'bg-sidebar-2 font-[650] text-sidebar-accent hover:text-sidebar-accent',
          )}
        >
          <item.icon className="size-[18px] shrink-0" aria-hidden />
          {item.title}
        </Link>
      ))}
    </nav>
  );
  const account = (
    <>
      <span aria-hidden className="hidden h-7 w-px bg-border sm:block" />
      <UserMenu header side="bottom" />
      <button className={ICON_BUTTON} aria-label="Sign out" title="Sign out" onClick={signOut}>
        <LogOut className="size-4" aria-hidden />
      </button>
    </>
  );
  return (
    <div
      data-shell="premium"
      data-menu={style}
      data-collapsed={collapsed}
      className={cn('min-h-screen print:p-0', side && (collapsed ? 'lg:pl-17' : 'lg:pl-(--sidebar-width)'))}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      {side ? (
        <aside
          className={cn(
            'fixed inset-y-0 left-0 z-30 hidden border-r border-border bg-sidebar lg:flex print:hidden',
            collapsed ? 'w-17' : 'w-(--sidebar-width)',
          )}
        >
          {style === 'rail' ? (
            <RailMenu {...menu} collapsed={collapsed} />
          ) : (
            <SidebarMenu {...menu} collapsed={collapsed} />
          )}
        </aside>
      ) : (
        <div className="sticky top-0 z-20 hidden border-b border-border bg-surface lg:block print:hidden">
          <div className="flex h-[70px] items-center gap-3 px-6">
            <Link to="/" aria-label="Home page" className="mr-4 shrink-0 text-sidebar-active">
              <Logo />
            </Link>
            <TopAreas {...menu} />
            <span className="flex-1" />
            <SearchBox onSearch={() => setSearching(true)} />
            {account}
          </div>
          {!beside && <WorkspaceNav area={area} className="border-t border-b-0 px-6" />}
        </div>
      )}
      <header
        className={cn(
          'sticky top-0 z-20 flex h-[70px] items-center gap-3 border-b border-border bg-surface px-4 sm:px-6 lg:px-10 print:hidden',
          !side && 'lg:hidden',
        )}
      >
        <button className={cn(ICON_BUTTON, 'lg:hidden')} aria-label="Open navigation" onClick={() => setOpen(true)}>
          <MenuIcon className="size-[18px]" aria-hidden />
        </button>
        {side && (
          <button
            className={cn(ICON_BUTTON, 'hidden lg:grid')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggle}
          >
            <PanelLeft className="size-[18px]" aria-hidden />
          </button>
        )}
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1 text-xs">
          <ol className="flex min-w-0 items-center gap-2">
            {currentClient || (page && page.label !== area.title) ? (
              <>
                <li className="shrink-0">
                  <Link to={area.to} className="text-muted hover:text-text">
                    {area.title}
                  </Link>
                </li>
                <li aria-hidden className="text-border-strong">
                  /
                </li>
                <li className="truncate font-[650] text-text" aria-current="page">
                  {currentClient?.name ?? page?.label}
                </li>
              </>
            ) : (
              <li className="truncate font-[650] text-text" aria-current="page">
                {area.title}
              </li>
            )}
          </ol>
        </nav>
        <SearchBox onSearch={() => setSearching(true)} />
        {account}
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[100rem] min-w-0 px-4 py-5 outline-none sm:px-7 sm:py-6 lg:px-[42px] lg:pt-[37px] lg:pb-16"
      >
        {/* The page lists its area's pages only where the menu doesn't: always on a phone, and on a computer when the
            chosen menu style leaves them out. A client's own sections are tabs on the client page instead. */}
        {area.id === 'clients' ? (
          children
        ) : beside ? (
          <div className={cn('lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10', menuHasPages && 'lg:block')}>
            <WorkspaceNav area={area} beside className={cn(menuHasPages && 'lg:hidden')} />
            <div className="min-w-0">{children}</div>
          </div>
        ) : (
          <>
            <WorkspaceNav area={area} className={cn('mb-[22px]', menuHasPages && 'lg:hidden')} />
            {children}
          </>
        )}
      </main>
      <Dialog open={open} onClose={() => setOpen(false)} title="Navigation" size="sm">
        {navigation()}
      </Dialog>
      <CommandPalette open={searching} onOpenChange={setSearching} />
    </div>
  );
}
