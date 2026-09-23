import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, BookOpen, KeyRound, Pencil, Server, StickyNote } from 'lucide-react';
import { LEVEL_INFO, atLeast } from '@atlas/shared';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '@/components/ui';
import { useClient } from '@/lib/queries';
import { formatDate } from '@/lib/format';
import { ClientForm, accessTone, statusTone } from './Clients';

export function ClientDetail() {
  const { clientId } = useParams({ from: '/app/clients/$clientId' });
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
            <Link to="/clients" className="font-semibold text-primary hover:underline">
              Back to clients
            </Link>
          }
        />
      </Card>
    );
  const canEdit = atLeast(client.access, 'edit');
  return (
    <>
      <Link
        to="/clients"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" /> Clients
      </Link>
      <PageHeader
        eyebrow={client.type}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {client.name}
            <Badge tone={statusTone[client.status]} className="capitalize">
              {client.status}
            </Badge>
          </span>
        }
        description={`Added ${formatDate(client.createdAt)} · Your access: ${LEVEL_INFO[client.access].label}`}
        actions={
          canEdit && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil /> Edit client
            </Button>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Quick notes" />
          <div className="px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap text-text-2">
            {client.notes || <span className="text-muted">No notes yet.</span>}
          </div>
        </Card>
        <Card>
          <CardHeader title="Your access" />
          <div className="space-y-2 px-5 py-4 text-sm">
            <Badge tone={accessTone(client.access)}>{LEVEL_INFO[client.access].label}</Badge>
            <p className="text-muted">
              {client.access === 'read'
                ? 'You can view this client but not change it.'
                : client.access === 'edit'
                  ? 'You can edit documentation. Passwords need extra access.'
                  : 'You can edit documentation and passwords.'}
            </p>
          </div>
        </Card>
        {[
          [Server, 'Assets', 'Devices, networks, domains, licenses, and more — with layouts you control.'],
          [BookOpen, 'Knowledge base', 'Runbooks and SOPs with revision history, linked to the assets they cover.'],
          [KeyRound, 'Passwords', 'Encrypted credentials with TOTP, access history, and secure sharing.'],
        ].map(([Icon, title, text]) => {
          const I = Icon as typeof Server;
          return (
            <Card key={title as string} className="border-dashed">
              <div className="p-5">
                <I className="mb-3 size-5 text-primary" aria-hidden />
                <h3 className="font-semibold">{title as string}</h3>
                <p className="mt-1 text-sm text-muted">{text as string}</p>
                <Badge className="mt-3">Coming next</Badge>
              </div>
            </Card>
          );
        })}
      </div>
      <ClientForm client={client} open={editing} onClose={() => setEditing(false)} />
    </>
  );
}
