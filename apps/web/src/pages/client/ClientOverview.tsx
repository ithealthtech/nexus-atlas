import { AppLink } from '@/components/AppLink';
import { useParams } from '@tanstack/react-router';
import { BookOpen, Clock, Mail, MapPin, Phone, User, Wrench } from 'lucide-react';
import { DOCUMENT_STATUS_LABELS } from '@atlas/shared';
import { Card, CardHeader } from '@/components/ui';
import { ActivityFeed } from '@/components/panels';
import { ItemIcon } from '@/components/ItemIcon';
import { RmmHealthCard } from '@/components/RmmHealth';
import { ClientSecurityCard } from '@/components/CwSecurity';
import { TrackerCard } from '@/components/Trackers';
import { TicketDetails, TicketsCard } from '@/components/Tickets';
import { WarrantyCard } from '@/components/Warranty';
import { SoftwareCard } from '@/components/Inventory';
import { AssetStatsCard } from '@/components/AssetStats';
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
  // The primary contact's number, else the primary location's main line.
  const phone = contact?.phone || contact?.mobile || location?.phone;
  const activity = useActivity({ client: clientId, limit: '8' }).data;
  const counts = layouts
    .map((l) => ({ ...l, count: assets.filter((a) => a.layoutId === l.id).length }))
    .filter((l) => l.count > 0);
  return (
    <div className="space-y-6">
      <Card>
        {/* Every field shows, even when empty, so the gaps are easy to spot and fill. */}
        <dl className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            {
              label: 'Primary contact',
              icon: User,
              value: contact && (
                <AppLink to={`/clients/${clientId}/contacts`} className="hover:underline">
                  {contact.name}
                </AppLink>
              ),
            },
            {
              label: 'Phone',
              icon: Phone,
              value: phone && (
                <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} className="text-primary hover:underline">
                  {phone}
                </a>
              ),
            },
            { label: 'Hours of operation', icon: Clock, value: client?.hours },
            { label: 'Maintenance window', icon: Wrench, value: client?.maintenanceWindow },
          ].map((f) => (
            <div key={f.label} className="min-w-0">
              <dt className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <f.icon className="size-3.5" aria-hidden /> {f.label}
              </dt>
              <dd className="mt-1 truncate text-sm font-medium">
                {f.value || <span className="font-normal text-muted">Not set</span>}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <div className="grid items-stretch gap-6 *:h-full lg:grid-cols-[repeat(auto-fit,minmax(20rem,1fr))]">
        {/* Two columns of layouts only when the card is wide enough to show their names. */}
        <Card className="@container">
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
            <div className="grid grid-cols-1 gap-x-2 gap-y-1 p-3 @sm:grid-cols-2">
              {counts.map((l) => (
                <AppLink
                  key={l.id}
                  to={`/clients/${clientId}/assets`}
                  search={{ layout: l.id }}
                  className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-2"
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
              No assets yet.{' '}
              <AppLink to={`/clients/${clientId}/assets`} className="text-primary underline underline-offset-2">
                Start with the firewall
              </AppLink>
              , servers, and the internet circuit.
            </p>
          )}
        </Card>
        <Card>
          <CardHeader title="Contact and location" />
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
          {location ? (
            <div className="border-t border-border px-5 py-4 text-sm">
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
            <p className="border-t border-border px-5 py-4 text-sm text-muted">
              <AppLink to={`/clients/${clientId}/locations`} className="text-primary underline underline-offset-2">
                Add locations
              </AppLink>{' '}
              and mark one as primary.
            </p>
          )}
        </Card>
        <WarrantyCard clientId={clientId} />
      </div>
      {/* Full width, so its three charts sit side by side instead of stacking. */}
      <RmmHealthCard clientId={clientId} />
      <ClientSecurityCard clientId={clientId} />
      <TrackerCard clientId={clientId} />
      <AssetStatsCard clientId={clientId} />
      <TicketsCard clientId={clientId} />
      <TicketDetails clientId={clientId} />
      <SoftwareCard clientId={clientId} />
      <div className="grid items-stretch gap-6 *:h-full lg:grid-cols-[repeat(auto-fit,minmax(20rem,1fr))]">
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
            <p className="px-5 py-4 text-sm text-muted">
              No documents yet.{' '}
              <AppLink to={`/clients/${clientId}/documents`} className="text-primary underline underline-offset-2">
                Write a runbook
              </AppLink>{' '}
              for this client.
            </p>
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
