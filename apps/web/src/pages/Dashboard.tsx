import { Fragment, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Building2,
  CheckCircle2,
  Circle,
  Clock,
  Info,
  LayoutGrid,
  Server,
  ShieldCheck,
} from 'lucide-react';
import {
  DASHBOARD_WIDGET_INFO,
  DEFAULT_WORKSPACE,
  type DashboardArea,
  type DashboardWidget,
  type PasswordHealthReport,
  type WorkspacePrefs,
} from '@atlas/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useBranding } from '@/lib/branding';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  PageHeader,
  Skeleton,
  Stat,
  useToast,
} from '@/components/ui';
import { AppLink } from '@/components/AppLink';
import { FavoritesCard } from '@/components/Favorites';
import { ActivityFeed } from '@/components/panels';
import { RmmHealthCard } from '@/components/RmmHealth';
import { WarrantyCard } from '@/components/Warranty';
import { useActor } from '@/lib/session';
import { ExpiryRow } from './Expirations';
import {
  useActivity,
  useAssets,
  useClients,
  useDocuments,
  useExpirations,
  useLayouts,
  useUsers,
  useWorkspacePrefs,
} from '@/lib/queries';
import { formatDate, relativeTime } from '@/lib/format';
import { statusTone } from './Clients';

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

// Layouts whose expiry dates the Domains and SSL card shows.
const DOMAIN_LAYOUTS = ['domain', 'ssl_certificate'];

const moreLink = (to: string, label: string, search?: Record<string, string>) => (
  <AppLink
    to={to}
    search={search}
    className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
  >
    {label} <ArrowRight className="size-3.5" />
  </AppLink>
);

/** A one-line empty state for the narrow cards: what is missing, and a link to where it gets filled in. */
function Missing({ children, to, label }: { children: ReactNode; to?: string; label?: string }) {
  return (
    <p className="px-5 py-4 text-sm text-muted">
      {children}
      {to && label && (
        <>
          {' '}
          <AppLink to={to} className="font-medium text-primary underline underline-offset-2">
            {label}
          </AppLink>
        </>
      )}
    </p>
  );
}

export function Dashboard() {
  const actor = useActor();
  const clients = useClients();
  const users = useUsers(actor.isAdmin);
  const assets = useAssets({});
  const docs = useDocuments({});
  const layouts = useLayouts();
  const health = useQuery({
    queryKey: ['password-health'],
    queryFn: () => api<PasswordHealthReport>('/password-health'),
    enabled: actor.isStaff,
  });
  const activity = useActivity({ limit: '8' });
  const expiring = useExpirations(30);
  const domains = useExpirations(90);
  const prefs = useWorkspacePrefs();
  const [customizing, setCustomizing] = useState(false);
  const branding = useBranding().data;
  const list = clients.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const review = (docs.data ?? [])
    .filter((d) => d.status === 'needs_review' || (d.reviewDate && d.reviewDate <= today))
    .slice(0, 5);
  const firstClient = list[0]?.id;
  const assetsHref = firstClient ? `/clients/${firstClient}/assets` : '/clients';
  const steps = [
    { done: actor.mfa, label: 'Turn on two-step verification', to: '/account' },
    { done: list.length > 0, label: 'Add your first client', to: '/clients' },
    { done: (assets.data?.length ?? 0) > 0, label: 'Document an asset', to: assetsHref },
    { done: (docs.data?.length ?? 0) > 0, label: 'Write a runbook', to: actor.isStaff ? '/documents' : '/clients' },
    ...(actor.isAdmin ? [{ done: (users.data?.length ?? 0) > 1, label: 'Invite a teammate', to: '/admin/users' }] : []),
  ];
  const remaining = steps.filter((s) => !s.done).length;
  const skeleton = <Skeleton className="h-8 w-12" />;
  const domainLayouts = (layouts.data ?? []).filter((l) => DOMAIN_LAYOUTS.includes(l.key));
  const domainAssets = (assets.data ?? []).filter((a) => domainLayouts.some((l) => l.id === a.layoutId)).length;
  const domainItems = (domains.data ?? []).filter((i) => i.layoutKey && DOMAIN_LAYOUTS.includes(i.layoutKey));

  const cards: Record<DashboardWidget, ReactNode> = {
    stats: (
      <div className={cn('grid gap-4 sm:grid-cols-2', actor.isStaff ? 'xl:grid-cols-5' : 'xl:grid-cols-4')}>
        <Stat
          label="Client workspaces"
          value={clients.isLoading ? skeleton : list.length}
          hint={`${list.filter((c) => c.status === 'active').length} active`}
          icon={Building2}
        />
        <Stat
          label="Assets"
          value={assets.isLoading ? skeleton : (assets.data?.length ?? 0)}
          hint="Documented across clients"
          icon={Server}
        />
        <Stat
          label="Documents"
          value={docs.isLoading ? skeleton : (docs.data?.length ?? 0)}
          hint="Runbooks, checklists, references"
          icon={BookOpen}
        />
        {actor.isStaff && (
          <AppLink to="/password-health" className="block">
            <Stat
              label="Password health"
              value={
                health.isLoading
                  ? skeleton
                  : health.data?.score === null || !health.data
                    ? '—'
                    : `${health.data.score}%`
              }
              hint={health.data ? `${health.data.items.length} need attention` : 'Weak, reused, breached'}
              icon={ShieldCheck}
            />
          </AppLink>
        )}
        <Stat
          label="Due for review"
          value={docs.isLoading ? skeleton : review.length}
          hint="Flagged or past their review date"
          icon={Clock}
        />
      </div>
    ),
    'rmm-health': <RmmHealthCard />,
    favorites: <FavoritesCard />,
    'recent-clients': (
      <Card>
        <CardHeader title="Recently updated clients" actions={moreLink('/clients', 'All clients')} />
        {clients.isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No clients yet"
            description={
              actor.canEditAll
                ? 'Add a client to start documenting their environment.'
                : 'Ask an administrator to give you access to a client.'
            }
            action={
              actor.canEditAll ? (
                <AppLink to="/clients" className="text-sm font-semibold text-primary hover:underline">
                  Add a client
                </AppLink>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {[...list]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .slice(0, 5)
              .map((c) => (
                <li key={c.id}>
                  <AppLink to={`/clients/${c.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-2">
                    <span className="grid size-9 place-items-center rounded-lg bg-primary-soft text-xs font-bold text-primary">
                      {c.name.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{c.name}</span>
                      <span className="block text-xs text-muted">Updated {relativeTime(c.updatedAt)}</span>
                    </span>
                    <Badge tone={statusTone[c.status]} className="capitalize">
                      {c.status}
                    </Badge>
                  </AppLink>
                </li>
              ))}
          </ul>
        )}
      </Card>
    ),
    activity: (
      <Card>
        <CardHeader title="Recent activity" description="The latest changes you can see." />
        {activity.data?.length === 0 ? (
          <Missing
            to={list.length ? assetsHref : '/clients'}
            label={list.length ? 'Document an asset' : 'Add a client'}
          >
            Nothing has changed yet. Changes to clients, assets, documents, and passwords show here.
          </Missing>
        ) : (
          <ActivityFeed items={activity.data} />
        )}
      </Card>
    ),
    setup:
      remaining > 0 ? (
        <Card>
          <CardHeader title="Get set up" description={`${remaining} step${remaining === 1 ? '' : 's'} left`} />
          <ul className="space-y-1 p-3">
            {steps.map((s) => (
              <li key={s.label}>
                <AppLink
                  to={s.to}
                  className="flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm hover:bg-surface-2"
                >
                  {s.done ? (
                    <CheckCircle2 className="size-5 text-success" aria-label="Done" />
                  ) : (
                    <Circle className="size-5 text-border-strong" aria-label="To do" />
                  )}
                  <span className={s.done ? 'text-muted line-through' : 'font-medium'}>{s.label}</span>
                </AppLink>
              </li>
            ))}
          </ul>
        </Card>
      ) : null,
    review: (
      <Card>
        <CardHeader title="Review queue" description="Keep knowledge current." />
        {review.length ? (
          <ul className="divide-y divide-border">
            {review.map((d) => (
              <li key={d.id}>
                <AppLink to={`/documents/${d.id}`} className="block px-5 py-3 hover:bg-surface-2">
                  <span className="block truncate text-sm font-medium">{d.title}</span>
                  <span className="block text-xs text-muted">
                    {d.clientName ?? 'Knowledge base'}
                    {d.reviewDate && ` · Review ${formatDate(`${d.reviewDate}T12:00:00`)}`}
                  </span>
                </AppLink>
              </li>
            ))}
          </ul>
        ) : (docs.data?.length ?? 0) === 0 ? (
          <Missing to={actor.isStaff ? '/documents/new' : '/clients'} label={actor.isStaff ? 'Write one' : undefined}>
            No documents yet, so nothing to review.
          </Missing>
        ) : (
          <Missing to={actor.isStaff ? '/documents' : undefined} label="Set review dates">
            Nothing is due for review.
          </Missing>
        )}
      </Card>
    ),
    'coming-up': (
      <Card>
        <CardHeader
          title="Coming up"
          description="Expiring or due in the next 30 days."
          actions={moreLink('/expirations', 'All')}
        />
        {expiring.data?.length ? (
          <ul className="divide-y divide-border">
            {expiring.data.slice(0, 6).map((i) => (
              <li key={`${i.kind}-${i.id}-${i.label}`}>
                <ExpiryRow item={i} />
              </li>
            ))}
          </ul>
        ) : expiring.isLoading ? (
          <Missing>Loading…</Missing>
        ) : (
          <Missing to="/expirations" label="See the next 90 days">
            Nothing is due in the next 30 days.
          </Missing>
        )}
      </Card>
    ),
    domains: (
      <Card>
        <CardHeader
          title="Domains and SSL"
          description="Expiring in the next 90 days."
          actions={moreLink('/expirations', 'All')}
        />
        {domainItems.length ? (
          <ul className="divide-y divide-border">
            {domainItems.slice(0, 6).map((i) => (
              <li key={`${i.id}-${i.label}`}>
                <ExpiryRow item={i} />
              </li>
            ))}
          </ul>
        ) : domains.isLoading || assets.isLoading ? (
          <Missing>Loading…</Missing>
        ) : domainAssets === 0 ? (
          <Missing to={assetsHref} label="Add a domain">
            No domains or SSL certificates are documented yet.
          </Missing>
        ) : (
          <Missing to="/assets" label="Check their expiry dates">
            No domains or certificates expire in the next 90 days.
          </Missing>
        )}
      </Card>
    ),
    warranty: <WarrantyCard />,
  };

  const shown = (prefs.data ?? DEFAULT_WORKSPACE).widgets.filter((w) => w.visible);
  const area = (a: DashboardArea) =>
    shown
      .filter((w) => DASHBOARD_WIDGET_INFO[w.id].area === a && cards[w.id])
      .map((w) => <Fragment key={w.id}>{cards[w.id]}</Fragment>);
  const top = area('top');
  const main = area('main');
  const side = area('side');

  return (
    <>
      <PageHeader
        eyebrow={actor.organization.name}
        title={`${greeting()}, ${actor.name.split(' ')[0]}.`}
        description={
          actor.isStaff
            ? "Here's what's happening across your client workspaces."
            : 'Your documentation, kept by our team.'
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => setCustomizing(true)}>
            <LayoutGrid /> Customize
          </Button>
        }
      />
      {!actor.isStaff && branding?.portalWelcome && (
        <Card className="mb-7 flex items-start gap-4 p-5">
          <Info className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
          <p className="text-sm whitespace-pre-line text-text-2">{branding.portalWelcome}</p>
        </Card>
      )}
      {top.length > 0 && <div className="mb-7 space-y-6">{top}</div>}
      {main.length + side.length > 0 ? (
        <div className={cn('grid gap-6', main.length && side.length && 'lg:grid-cols-[minmax(0,1fr)_340px]')}>
          {main.length > 0 && <div className="space-y-6">{main}</div>}
          {side.length > 0 && (
            <div className={cn(main.length ? 'space-y-6' : 'grid items-start gap-6 md:grid-cols-2 xl:grid-cols-3')}>
              {side}
            </div>
          )}
        </div>
      ) : (
        top.length === 0 && (
          <Card>
            <EmptyState
              icon={LayoutGrid}
              title="Every card is hidden"
              description="Choose which cards to show on your dashboard."
              action={<Button onClick={() => setCustomizing(true)}>Customize</Button>}
            />
          </Card>
        )
      )}
      <p className="mt-6 px-1 text-xs text-muted">Tip: press Ctrl+K anywhere to search.</p>
      {/* Mounted only while open, so it starts from the saved layout each time. */}
      {customizing && prefs.data && <CustomizeDashboard prefs={prefs.data} onClose={() => setCustomizing(false)} />}
    </>
  );
}

const AREAS: [DashboardArea, string][] = [
  ['top', 'Across the top'],
  ['main', 'Main column'],
  ['side', 'Side column'],
];

/** Choose which dashboard cards show and their order within each column. Saved for this person only. */
function CustomizeDashboard({ prefs, onClose }: { prefs: WorkspacePrefs; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [widgets, setWidgets] = useState(prefs.widgets);
  const [saving, setSaving] = useState(false);

  const move = (id: DashboardWidget, step: -1 | 1) =>
    setWidgets((list) => {
      const areaOf = (w: DashboardWidget) => DASHBOARD_WIDGET_INFO[w].area;
      const i = list.findIndex((w) => w.id === id);
      // The next card in the same column, skipping cards in other columns.
      let j = i + step;
      while (j >= 0 && j < list.length && areaOf(list[j]!.id) !== areaOf(id)) j += step;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const save = async (body: WorkspacePrefs | null) => {
    setSaving(true);
    try {
      const saved = await api<WorkspacePrefs>('/account/workspace', {
        method: body ? 'PUT' : 'DELETE',
        ...(body ? { body } : {}),
      });
      queryClient.setQueryData(['workspace'], saved);
      toast(body ? 'Dashboard saved.' : 'Dashboard reset to the default.');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Customize your dashboard"
      description="Choose which cards show and in what order. This changes only your dashboard."
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => void save(null)} disabled={saving}>
            Reset to default
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save({ widgets, hiddenSections: prefs.hiddenSections })} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {AREAS.map(([area, label]) => {
          const inArea = widgets.filter((w) => DASHBOARD_WIDGET_INFO[w.id].area === area);
          return (
            <fieldset key={area}>
              <legend className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">{label}</legend>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {inArea.map((w, index) => {
                  const info = DASHBOARD_WIDGET_INFO[w.id];
                  return (
                    <li key={w.id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <Checkbox
                          label={info.label}
                          description={info.description}
                          checked={w.visible}
                          onChange={(e) =>
                            setWidgets((list) =>
                              list.map((x) => (x.id === w.id ? { ...x, visible: e.currentTarget.checked } : x)),
                            )
                          }
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${info.label} up`}
                        disabled={index === 0}
                        onClick={() => move(w.id, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Move ${info.label} down`}
                        disabled={index === inArea.length - 1}
                        onClick={() => move(w.id, 1)}
                      >
                        <ArrowDown />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })}
        <p className="text-xs text-muted">To hide sections of client workspaces, use Customize on any client.</p>
      </div>
    </Dialog>
  );
}
