import { Link } from '@tanstack/react-router';
import { ArrowRight, Building2, CheckCircle2, Circle, KeyRound, ShieldCheck, Users } from 'lucide-react';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton, Stat } from '@/components/ui';
import { useActor } from '@/lib/session';
import { useClients, useUsers } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { statusTone } from './Clients';

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function Dashboard() {
  const actor = useActor();
  const clients = useClients();
  const users = useUsers(actor.isAdmin);
  const list = clients.data ?? [];
  const steps = [
    { done: actor.mfa, label: 'Turn on two-step verification', to: '/account' },
    { done: list.length > 0, label: 'Add your first client', to: '/clients' },
    ...(actor.isAdmin ? [{ done: (users.data?.length ?? 0) > 1, label: 'Invite a teammate', to: '/admin/users' }] : []),
  ];
  const remaining = steps.filter((s) => !s.done).length;
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
          value={clients.isLoading ? <Skeleton className="h-8 w-12" /> : list.length}
          hint="You can open"
          icon={Building2}
        />
        <Stat
          label="Active clients"
          value={
            clients.isLoading ? <Skeleton className="h-8 w-12" /> : list.filter((c) => c.status === 'active').length
          }
          hint="Currently supported"
          icon={CheckCircle2}
        />
        {actor.isAdmin && (
          <Stat
            label="People"
            value={users.isLoading ? <Skeleton className="h-8 w-12" /> : (users.data?.length ?? 0)}
            hint="Staff and client accounts"
            icon={Users}
          />
        )}
        <Stat
          label="Your sign-in"
          value={actor.mfa ? 'Protected' : 'Password only'}
          hint={actor.mfa ? 'Two-step verification is on' : 'Turn on two-step verification'}
          icon={ShieldCheck}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader
            title="Recently updated clients"
            actions={
              <Link
                to="/clients"
                className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline"
              >
                All clients <ArrowRight className="size-3.5" />
              </Link>
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
                .slice(0, 6)
                .map((c) => (
                  <li key={c.id}>
                    <Link
                      to="/clients/$clientId"
                      params={{ clientId: c.id }}
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
                    </Link>
                  </li>
                ))}
            </ul>
          )}
        </Card>
        <Card className="h-fit">
          <CardHeader
            title="Get set up"
            description={remaining ? `${remaining} step${remaining === 1 ? '' : 's'} left` : 'All done — nice work.'}
          />
          <ul className="space-y-1 p-3">
            {steps.map((s) => (
              <li key={s.label}>
                <Link to={s.to} className="flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm hover:bg-surface-2">
                  {s.done ? (
                    <CheckCircle2 className="size-5 text-success" aria-label="Done" />
                  ) : (
                    <Circle className="size-5 text-border-strong" aria-label="To do" />
                  )}
                  <span className={s.done ? 'text-muted line-through' : 'font-medium'}>{s.label}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="m-3 mt-0 flex gap-3 rounded-lg bg-surface-2 p-3.5 text-xs text-muted">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            The encrypted password vault and documentation tools arrive in the next milestones.
          </div>
        </Card>
      </div>
    </>
  );
}
