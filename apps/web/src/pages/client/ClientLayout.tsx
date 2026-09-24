import { AppLink } from '@/components/AppLink';
import { useState } from 'react';
import { Outlet, useParams } from '@tanstack/react-router';
import { ArrowLeft, Pencil, StickyNote } from 'lucide-react';
import { LEVEL_INFO, atLeast } from '@atlas/shared';
import { Badge, Button, Card, EmptyState, Skeleton } from '@/components/ui';
import { useClient } from '@/lib/queries';
import { ClientForm, accessTone, statusTone } from '../Clients';

const TABS = [
  ['', 'Overview'],
  ['/assets', 'Assets'],
  ['/documents', 'Documents'],
  ['/passwords', 'Passwords'],
  ['/contacts', 'Contacts'],
  ['/locations', 'Locations'],
  ['/activity', 'Activity'],
] as const;

export function ClientLayout() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const { data: client, isLoading, error } = useClient(clientId);
  const [editing, setEditing] = useState(false);
  if (isLoading) return <Skeleton className="h-40" />;
  if (error || !client)
    return (
      <Card>
        <EmptyState
          icon={StickyNote}
          title="Client not found"
          description="It may have been removed, or you don't have access to it."
          action={
            <AppLink to="/clients" className="font-semibold text-primary hover:underline">
              Back to clients
            </AppLink>
          }
        />
      </Card>
    );
  return (
    <>
      <AppLink
        to="/clients"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" /> Clients
      </AppLink>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary-soft text-base font-bold text-primary">
            {client.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-center gap-3 text-[26px] leading-tight font-semibold tracking-tight">
              {client.name}
              <Badge tone={statusTone[client.status]} className="capitalize">
                {client.status}
              </Badge>
            </h1>
            <p className="mt-1 text-sm text-muted">
              {client.type} · <Badge tone={accessTone(client.access)}>{LEVEL_INFO[client.access].label}</Badge>
            </p>
          </div>
        </div>
        {atLeast(client.access, 'edit') && (
          <Button variant="secondary" onClick={() => setEditing(true)}>
            <Pencil /> Edit client
          </Button>
        )}
      </div>
      <nav aria-label="Client sections" className="mb-7 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.filter(([path]) => path !== '/passwords' || client.access === 'edit_passwords').map(([path, label]) => (
          <AppLink
            key={label}
            to={`/clients/${clientId}${path}`}
            activeOptions={{ exact: path === '' }}
            className="-mb-px border-b-2 border-transparent px-3.5 py-2.5 text-sm font-medium whitespace-nowrap text-muted hover:text-text data-[status=active]:border-primary data-[status=active]:text-text"
          >
            {label}
          </AppLink>
        ))}
      </nav>
      <Outlet />
      <ClientForm client={client} open={editing} onClose={() => setEditing(false)} />
    </>
  );
}
