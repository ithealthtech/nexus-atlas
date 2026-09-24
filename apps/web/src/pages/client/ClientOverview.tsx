import { AppLink } from '@/components/AppLink';
import { useParams } from '@tanstack/react-router';
import { BookOpen, Mail, MapPin, Phone, User } from 'lucide-react';
import { DOCUMENT_STATUS_LABELS } from '@atlas/shared';
import { Card, CardHeader } from '@/components/ui';
import { ActivityFeed } from '@/components/panels';
import { ItemIcon } from '@/components/ItemIcon';
import { useActivity, useAssets, useClient, useContacts, useDocuments, useLayouts, useLocations } from '@/lib/queries';
import { relativeTime } from '@/lib/format';

export function ClientOverview() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId).data;
  const assets = useAssets({ client: clientId }).data ?? [];
  const layouts = useLayouts().data ?? [];
  const docs = useDocuments({ client: clientId }).data ?? [];
  const contact = useContacts(clientId).data?.find((c) => c.primary);
  const location = useLocations(clientId).data?.find((l) => l.primary);
  const activity = useActivity({ client: clientId, limit: '8' }).data;
  const counts = layouts
    .map((l) => ({ ...l, count: assets.filter((a) => a.layoutId === l.id).length }))
    .filter((l) => l.count > 0);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        {client?.notes && (
          <Card className="border-warning/40 bg-warning-soft/40 px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap text-text-2">
            <p className="mb-1 text-xs font-bold tracking-wide text-warning uppercase">Quick notes</p>
            {client.notes}
          </Card>
        )}
        <Card>
          <CardHeader
            title="Assets"
            description={`${assets.length} documented`}
            actions={
              <AppLink
                to={`/clients/${clientId}/assets`}
                className="text-sm font-semibold text-primary hover:underline"
              >
                View all
              </AppLink>
            }
          />
          {counts.length ? (
            <div className="grid grid-cols-2 gap-2 p-4 sm:grid-cols-3">
              {counts.map((l) => (
                <AppLink
                  key={l.id}
                  to={`/clients/${clientId}/assets`}
                  search={{ layout: l.id }}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 hover:bg-surface-2"
                >
                  <ItemIcon type="asset" icon={l.icon} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{l.name}</span>
                    <span className="block text-xs text-muted">{l.count}</span>
                  </span>
                </AppLink>
              ))}
            </div>
          ) : (
            <p className="px-5 py-4 text-sm text-muted">
              No assets yet. Start with the firewall, servers, and the internet circuit.
            </p>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Recently updated documents"
            actions={
              <AppLink
                to={`/clients/${clientId}/documents`}
                className="text-sm font-semibold text-primary hover:underline"
              >
                View all
              </AppLink>
            }
          />
          {docs.length ? (
            <ul className="divide-y divide-border">
              {[...docs]
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 5)
                .map((d) => (
                  <li key={d.id}>
                    <AppLink to={`/documents/${d.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
                      <BookOpen className="size-4 text-primary" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.title}</span>
                      <span className="text-xs text-muted">
                        {DOCUMENT_STATUS_LABELS[d.status]} · {relativeTime(d.updatedAt)}
                      </span>
                    </AppLink>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-muted">No documents yet.</p>
          )}
        </Card>
      </div>
      <div className="space-y-6">
        <Card>
          <CardHeader title="Primary contact" />
          {contact ? (
            <div className="space-y-1.5 px-5 py-4 text-sm">
              <p className="flex items-center gap-2 font-semibold">
                <User className="size-4 text-muted" aria-hidden /> {contact.name}
              </p>
              {contact.title && <p className="text-muted">{contact.title}</p>}
              {contact.email && (
                <a href={`mailto:${contact.email}`} className="flex items-center gap-2 text-primary hover:underline">
                  <Mail className="size-4" aria-hidden /> {contact.email}
                </a>
              )}
              {(contact.phone || contact.mobile) && (
                <a
                  href={`tel:${(contact.phone || contact.mobile).replace(/[^\d+]/g, '')}`}
                  className="flex items-center gap-2 text-primary hover:underline"
                >
                  <Phone className="size-4" aria-hidden /> {contact.phone || contact.mobile}
                </a>
              )}
            </div>
          ) : (
            <p className="px-5 py-4 text-sm text-muted">
              <AppLink to={`/clients/${clientId}/contacts`} className="text-primary underline underline-offset-2">
                Add contacts
              </AppLink>{' '}
              and mark one as primary.
            </p>
          )}
        </Card>
        <Card>
          <CardHeader title="Primary location" />
          {location ? (
            <div className="px-5 py-4 text-sm">
              <p className="flex items-center gap-2 font-semibold">
                <MapPin className="size-4 text-muted" aria-hidden /> {location.name}
              </p>
              <p className="mt-1 whitespace-pre-line text-muted">
                {[
                  location.address,
                  [location.city, location.region, location.postalCode].filter(Boolean).join(', '),
                  location.country,
                ]
                  .filter(Boolean)
                  .join('\n')}
              </p>
            </div>
          ) : (
            <p className="px-5 py-4 text-sm text-muted">No primary location yet.</p>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent activity" />
          <ActivityFeed items={activity} showClient={false} />
        </Card>
      </div>
    </div>
  );
}
