import { ArrowRight, BookOpen, Building2, CheckCircle2, Circle, Clock, KeyRound, Server } from 'lucide-react';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui';
import { AppLink } from '@/components/AppLink';
import { ActivityFeed } from '@/components/panels';
import { useActor } from '@/lib/session';
import { useActivity, useAssets, useClients, useDocuments, useUsers } from '@/lib/queries';
import { formatDate, relativeTime } from '@/lib/format';
import { statusTone } from './Clients';

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function Dashboard() {
  const actor = useActor();
  const clients = useClients();
  const users = useUsers(actor.isAdmin);
  const assets = useAssets({});
  const docs = useDocuments({});
  const activity = useActivity({ limit: '8' });
  const list = clients.data ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const review = (docs.data ?? [])
    .filter((d) => d.status === 'needs_review' || (d.reviewDate && d.reviewDate <= today))
    .slice(0, 5);
  const firstClient = list[0]?.id;
  const steps = [
    { done: actor.mfa, label: 'Turn on two-step verification', to: '/account' },
    { done: list.length > 0, label: 'Add your first client', to: '/clients' },
    {
      done: (assets.data?.length ?? 0) > 0,
      label: 'Document an asset',
      to: firstClient ? `/clients/${firstClient}/assets` : '/clients',
    },
    { done: (docs.data?.length ?? 0) > 0, label: 'Write a runbook', to: actor.isStaff ? '/documents' : '/clients' },
    ...(actor.isAdmin ? [{ done: (users.data?.length ?? 0) > 1, label: 'Invite a teammate', to: '/admin/users' }] : []),
  ];
  const remaining = steps.filter((s) => !s.done).length;
  const skeleton = <Skeleton className="h-8 w-12" />;
  return (
    <>
      <PageHeader
        eyebrow={actor.organization.name}
        title={`${greeting()}, ${actor.name.split(' ')[0]}.`}
        description="Here's what's happening across your client workspaces."
      />
      <div className="mb-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
        <Stat
          label="Due for review"
          value={docs.isLoading ? skeleton : review.length}
          hint="Flagged or past their review date"
          icon={Clock}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Recently updated clients"
              actions={
                <AppLink
                  to="/clients"
                  className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
                >
                  All clients <ArrowRight className="size-3.5" />
                </AppLink>
              }
            />
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
              />
            ) : (
              <ul className="divide-y divide-border">
                {[...list]
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .slice(0, 5)
                  .map((c) => (
                    <li key={c.id}>
                      <AppLink
                        to={`/clients/${c.id}`}
                        className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-2"
                      >
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
          <Card>
            <CardHeader title="Recent activity" description="The latest changes you can see." />
            <ActivityFeed items={activity.data} />
          </Card>
        </div>
        <div className="space-y-6">
          {remaining > 0 && (
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
          )}
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
            ) : (
              <p className="px-5 py-4 text-sm text-muted">Nothing is due for review.</p>
            )}
          </Card>
          <div className="flex gap-3 rounded-xl border border-border bg-surface-2 p-4 text-xs text-muted">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            The encrypted password vault arrives in the next milestone. Press Ctrl+K anywhere to search.
          </div>
        </div>
      </div>
    </>
  );
}
