import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import * as Menu from '@radix-ui/react-dropdown-menu';
import {
  BookOpen,
  Building2,
  ChevronsUpDown,
  House,
  KeyRound,
  LogOut,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Monitor,
  Moon,
  Search,
  Settings2,
  Sun,
  UserCircle,
  type LucideIcon,
} from 'lucide-react';
import { CommandPalette } from '@/components/CommandPalette';
import { Avatar, Button, Dialog } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
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
export function AppShell({ children }: { children: ReactNode }) {
  const actor = useActor();
  const personalVaults = useVaultPolicy().data?.personalVaults !== false;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const clients = useClients().data ?? [];
  const list = areas(actor, personalVaults);
  const area = areaOf(list, pathname);
  const currentClient = clients.find((c) => pathname.startsWith(`/clients/${c.id}`));
  const page = list
    .flatMap((a) => a.groups.flatMap((g) => g.items))
    .filter((p) => pathname === p.to || (p.to !== '/' && pathname.startsWith(`${p.to}/`)))
    .sort((a, b) => b.to.length - a.to.length)[0];
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
            'primary-nav-link flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-sidebar-text hover:bg-sidebar-2',
            compact && 'justify-center px-0',
            area.id === item.id && 'bg-sidebar-2 text-sidebar-accent',
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
            'flex h-16 shrink-0 items-center border-b border-border text-sidebar-active',
            collapsed ? 'justify-center' : 'px-5',
          )}
        >
          <Logo compact={collapsed} />
        </Link>
        <div className={cn('flex-1 overflow-y-auto py-5', collapsed ? 'px-2' : 'px-3')}>{navigation(collapsed)}</div>
        <div className="border-t border-border p-3">
          <button
            onClick={toggle}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            className="flex min-h-9 w-full items-center justify-center gap-3 rounded-md text-sm text-sidebar-text hover:bg-sidebar-2"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4" />
            ) : (
              <>
                <PanelLeftClose className="size-4" />
                <span>Collapse sidebar</span>
              </>
            )}
          </button>
        </div>
      </aside>
      <header className="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6 print:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Open navigation"
          onClick={() => setOpen(true)}
        >
          <MenuIcon />
        </Button>
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1 text-sm">
          <ol className="flex min-w-0 items-center gap-2">
            <li className="hidden shrink-0 text-muted sm:block">Atlas</li>
            <li aria-hidden className="hidden text-muted sm:block">
              /
            </li>
            <li>
              <Link to={area.to} className="font-medium hover:text-primary">
                {area.title}
              </Link>
            </li>
            {(currentClient || (page && page.label !== area.title)) && (
              <>
                <li aria-hidden className="text-muted">
                  /
                </li>
                <li className="truncate text-muted" aria-current="page">
                  {currentClient?.name ?? page?.label}
                </li>
              </>
            )}
          </ol>
        </nav>
        {currentClient && (
          <label className="hidden max-w-52 md:block">
            <span className="sr-only">Switch client</span>
            <select
              value={currentClient.id}
              onChange={(e) => void navigate({ to: `/clients/${e.target.value}` })}
              className="h-9 w-full rounded-md border border-border bg-surface px-2 text-sm"
            >
              {[...clients]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <button
          onClick={() => setSearching(true)}
          aria-label="Search"
          className="flex h-9 items-center gap-2 rounded-md border border-border px-2.5 text-sm text-muted hover:bg-surface-2 sm:w-56"
        >
          <Search className="size-4 shrink-0" aria-hidden />
          <span className="hidden flex-1 text-left sm:inline">Search Atlas</span>
          <kbd className="hidden text-[11px] sm:inline">Ctrl K</kbd>
        </button>
        <UserMenu side="bottom" />
      </header>
      <main
        id="main"
        tabIndex={-1}
        className="mx-auto w-full max-w-[100rem] min-w-0 px-4 py-6 outline-none sm:px-6 sm:py-7"
      >
        {area.id !== 'clients' && (
          <nav aria-label="Workspace" className="mb-6 space-y-2 border-b border-border pb-3 print:hidden">
            {area.groups.map((group, i) => (
              <div key={group.title ?? i} className="flex flex-wrap items-center gap-1">
                {group.title && <span className="mr-2 text-xs font-medium text-muted">{group.title}</span>}
                {group.items.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    activeOptions={{ exact: item.exact ?? false }}
                    className="rounded-md px-3 py-2 text-[13px] font-medium text-text-2 hover:bg-surface-3 data-[status=active]:bg-primary-soft data-[status=active]:text-primary"
                  >
                    {item.label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        )}
        {children}
      </main>
      <Dialog open={open} onClose={() => setOpen(false)} title="Navigation" size="sm">
        {navigation()}
      </Dialog>
      <CommandPalette open={searching} onOpenChange={setSearching} />
    </div>
  );
}
