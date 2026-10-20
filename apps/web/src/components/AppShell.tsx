import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  BookOpen,
  Building2,
  ChevronsUpDown,
  House,
  KeyRound,
  LogOut,
  Menu as MenuIcon,
  PanelLeft,
  Monitor,
  Moon,
  Search,
  Settings2,
  Sun,
  UserCircle,
  type LucideIcon,
} from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { Avatar, Dialog } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { SECTION_TAB } from '@/lib/tabs';
import { useClients } from '@/lib/queries';
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

// Primary areas group the existing routes. Section links are rendered inside their workspace.
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
            { to: '/', label: 'Dashboard', exact: true },
            { to: '/expirations', label: 'Expirations' },
            { to: '/reports', label: 'Reports' },
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
      label: 'Documentation',
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
      label: 'Password Vault',
      title: 'Password Vault',
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
      label: 'Administration',
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
            { to: '/admin/remote-access', label: 'Remote access' },
            { to: '/admin/request-log', label: 'Request log' },
            { to: '/admin/webhooks', label: 'Webhooks' },
            { to: '/admin/updates', label: 'Updates' },
          ],
        },
        {
          title: 'Settings',
          items: [
            { to: '/admin/email', label: 'Email & alerts' },
            { to: '/admin/monitoring', label: 'Monitoring' },
            { to: '/admin/sign-in', label: 'Sign-in' },
            { to: '/admin/api-keys', label: 'API keys' },
            { to: '/admin/theme', label: 'Theme' },
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

/** One primary sidebar; section links live inside the active workspace. */
/** The header's square icon buttons (navigation, sign out). */
const ICON_BUTTON =
  'grid size-[33px] shrink-0 place-items-center rounded-[5px] text-muted hover:bg-surface-2 hover:text-text';

export function AppShell({ children }: { children: ReactNode }) {
  const actor = useActor();
  const signOut = useSignOut();
  const personalVaults = useVaultPolicy().data?.personalVaults !== false;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const clients = useClients().data ?? [];
  const list = areas(actor, personalVaults);
  const area = areaOf(list, pathname);
  const currentClient = clients.find((c) => pathname.startsWith(`/clients/${c.id}`));
  const page = list
    .flatMap((a) => a.groups.flatMap((g) => g.items))
    .filter((p) => pathname === p.to || (p.to !== '/' && pathname.startsWith(`${p.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
  // Areas with many pages list them beside the page instead of in rows of tabs.
  const sideNav = area.id !== 'clients' && area.groups.reduce((n, g) => n + g.items.length, 0) > 8;
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
  const navigation = (compact = false) => (
    <nav aria-label="Main" className="space-y-1">
      {list.map((item) => (
        <Link
          key={item.id}
          to={item.to}
          onClick={() => setOpen(false)}
          aria-current={area.id === item.id ? 'page' : undefined}
          title={compact ? item.label : undefined}
          className={cn(
            'primary-nav-link flex h-10 items-center gap-3 rounded-lg px-[13px] text-[13px] font-[560] text-sidebar-text hover:bg-sidebar-2 hover:text-sidebar-active',
            compact && 'justify-center px-0',
            area.id === item.id && 'bg-sidebar-2 font-[650] text-sidebar-accent hover:text-sidebar-accent',
          )}
        >
          <item.icon className="size-[18px] shrink-0" aria-hidden />
          <span className={compact ? 'sr-only' : ''}>{item.label}</span>
        </Link>
      ))}
    </nav>
  );
  return (
    <div
      data-shell="premium"
      data-collapsed={collapsed}
      className={cn('min-h-screen print:p-0', collapsed ? 'lg:pl-16' : 'lg:pl-(--sidebar-width)')}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-sidebar lg:flex print:hidden',
          collapsed ? 'w-16' : 'w-(--sidebar-width)',
        )}
      >
        <Link
          to="/"
          aria-label="Home page"
          className={cn(
            'flex h-[70px] shrink-0 items-center text-sidebar-active',
            collapsed ? 'justify-center' : 'px-5',
          )}
        >
          <Logo compact={collapsed} />
        </Link>
        <div className={cn('flex-1 overflow-y-auto pt-6 pb-5', collapsed ? 'px-2' : 'px-3')}>
          {!collapsed && (
            <p className="mb-2.5 px-[13px] text-[10px] font-bold tracking-[0.12em] text-sidebar-muted uppercase">
              Workspace
            </p>
          )}
          {navigation(collapsed)}
        </div>
      </aside>
      <header className="sticky top-0 z-20 flex h-[70px] items-center gap-3 border-b border-border bg-surface px-4 sm:px-6 lg:px-10 print:hidden">
        <button className={cn(ICON_BUTTON, 'lg:hidden')} aria-label="Open navigation" onClick={() => setOpen(true)}>
          <MenuIcon className="size-[18px]" aria-hidden />
        </button>
        <button
          className={cn(ICON_BUTTON, 'hidden lg:grid')}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggle}
        >
          <PanelLeft className="size-[18px]" aria-hidden />
        </button>
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
        <button
          onClick={() => setSearching(true)}
          aria-label="Search or switch client"
          className="flex h-9 items-center gap-2.5 rounded-[5px] border border-border bg-surface-2 px-[11px] text-xs text-muted hover:border-border-strong hover:text-text sm:w-64"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="hidden flex-1 truncate text-left whitespace-nowrap sm:inline">Search or switch client</span>
          <kbd className="hidden rounded-[3px] border border-border bg-surface px-1.5 py-px text-[10px] font-medium sm:inline">
            Ctrl K
          </kbd>
        </button>
        <span aria-hidden className="hidden h-7 w-px bg-border sm:block" />
        <UserMenu header side="bottom" />
        <button className={ICON_BUTTON} aria-label="Sign out" title="Sign out" onClick={signOut}>
          <LogOut className="size-4" aria-hidden />
        </button>
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[100rem] min-w-0 px-4 py-5 outline-none sm:px-7 sm:py-6 lg:px-[42px] lg:pt-[37px] lg:pb-16"
      >
        {sideNav ? (
          // Many pages (Administration): a grouped list beside the page, like a settings screen. On a phone it
          // becomes one row that scrolls.
          <div className="lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
            <nav
              aria-label="Workspace"
              className="mb-6 flex gap-x-6 overflow-x-auto border-b border-border pb-2 lg:mb-0 lg:block lg:space-y-5 lg:overflow-visible lg:border-0 lg:pb-0 print:hidden"
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
            <div className="min-w-0">{children}</div>
          </div>
        ) : (
          <>
            {area.id !== 'clients' && (
              <nav
                aria-label="Workspace"
                className="mb-[22px] flex flex-wrap items-center gap-x-[22px] border-b border-border print:hidden"
              >
                {area.groups.map((group, i) => (
                  <div key={group.title ?? i} className="contents">
                    {group.title && (
                      <span className="text-[10px] font-bold tracking-[0.12em] text-muted uppercase">
                        {group.title}
                      </span>
                    )}
                    {group.items.map((item) => (
                      <Link
                        key={item.to}
                        to={item.to}
                        activeOptions={{ exact: item.exact ?? false }}
                        className={SECTION_TAB}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                ))}
              </nav>
            )}
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
