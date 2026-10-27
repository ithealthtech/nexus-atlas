import { useParams } from '@tanstack/react-router';
import { Copy, Mail, MapPin, Phone, Router, StickyNote, Users, Wifi } from 'lucide-react';
import type { ContactView, LocationView, PasswordView } from '@atlas/shared';
import { AppLink, useGo } from '@/components/AppLink';
import { BackLink } from '@/components/DetailHeader';
import { Button, Card, CardHeader, EmptyState, Skeleton, useToast } from '@/components/ui';
import { passwordType } from '@/lib/password-categories';
import { useAssets, useClient, useContacts, useLayouts, useLocations } from '@/lib/queries';
import { copySecret, usePasswords, useReveal } from '@/lib/vault';

const primaryFirst = <T extends { primary: boolean; name: string }>(list: T[]) =>
  [...list].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
const tel = (number: string) => `tel:${number.replace(/[^\d+]/g, '')}`;
const address = (l: LocationView) => [l.address, l.city, l.region, l.postalCode].filter(Boolean).join(', ');

/**
 * Everything a technician needs on site, on one screen made for a phone: where to go and how to get in, who to
 * ask, how to get on the Wi-Fi, and who to call about the internet line. Read from the client's own records.
 */
export function SiteVisit() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId);
  const locations = useLocations(clientId);
  const contacts = useContacts(clientId);
  if (client.isLoading) return <Skeleton className="h-64" />;
  if (!client.data)
    return (
      <Card>
        <EmptyState icon={MapPin} title="Client not found" description="It may have been removed." />
      </Card>
    );
  const c = client.data;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <BackLink to={`/clients/${clientId}`}>{c.name}</BackLink>
      <div>
        <h1 className="text-2xl font-semibold">Site visit</h1>
        <p className="text-sm text-muted">
          {c.name}
          {c.hours && ` · Open ${c.hours}`}
        </p>
      </div>

      {c.notes && (
        <Card className="p-5">
          <h2 className="mb-2 flex items-center gap-2 font-semibold">
            <StickyNote className="size-4 text-muted" aria-hidden /> Notes
          </h2>
          <p className="text-sm whitespace-pre-line">{c.notes}</p>
        </Card>
      )}

      <Card>
        <CardHeader title="Getting there and getting in" description="Addresses, and the notes kept with each site." />
        {locations.isLoading ? (
          <Skeleton className="m-5 h-16" />
        ) : !locations.data?.length ? (
          <p className="px-5 pb-5 text-sm text-muted">No locations recorded.</p>
        ) : (
          <ul className="divide-y divide-border">
            {primaryFirst(locations.data).map((l) => (
              <li key={l.id} className="space-y-2 px-5 py-4 text-sm">
                <p className="font-semibold">{l.name}</p>
                {address(l) && (
                  <a
                    className="flex items-start gap-2 text-primary hover:underline"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address(l))}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden /> {address(l)}
                  </a>
                )}
                {l.phone && <Call number={l.phone} />}
                {l.notes && <p className="rounded-md bg-surface-2 p-3 whitespace-pre-line">{l.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="People on site" description="Primary contacts first." />
        {contacts.isLoading ? (
          <Skeleton className="m-5 h-16" />
        ) : !contacts.data?.length ? (
          <p className="px-5 pb-5 text-sm text-muted">No contacts recorded.</p>
        ) : (
          <ul className="divide-y divide-border">
            {primaryFirst(contacts.data)
              .slice(0, 8)
              .map((p) => (
                <ContactRow key={p.id} contact={p} />
              ))}
          </ul>
        )}
      </Card>

      <WifiCard clientId={clientId} />
      <InternetCard clientId={clientId} />
    </div>
  );
}

function Call({ number }: { number: string }) {
  return (
    <a className="flex items-center gap-2 text-primary hover:underline" href={tel(number)}>
      <Phone className="size-4 shrink-0" aria-hidden /> {number}
    </a>
  );
}

function ContactRow({ contact }: { contact: ContactView }) {
  return (
    <li className="space-y-1.5 px-5 py-4 text-sm">
      <p className="font-semibold">
        {contact.name}
        {contact.title && <span className="font-normal text-muted"> · {contact.title}</span>}
      </p>
      {contact.mobile && <Call number={contact.mobile} />}
      {contact.phone && <Call number={contact.phone} />}
      {contact.email && (
        <a className="flex items-center gap-2 text-primary hover:underline" href={`mailto:${contact.email}`}>
          <Mail className="size-4 shrink-0" aria-hidden /> {contact.email}
        </a>
      )}
    </li>
  );
}

/** The client's Wi-Fi passwords: copy one (recorded like any reveal), or open it for the join code. */
function WifiCard({ clientId }: { clientId: string }) {
  const passwords = usePasswords({ client: clientId });
  const wifi = (passwords.data ?? []).filter((p) => passwordType(p) === 'wifi');
  // Someone without password access to this client gets an error here; the card just stays away.
  if (passwords.isError || (!passwords.isLoading && !wifi.length)) return null;
  return (
    <Card>
      <CardHeader title="Wi-Fi" description="Copying a password is recorded in its access history." />
      {passwords.isLoading ? (
        <Skeleton className="m-5 h-16" />
      ) : (
        <ul className="divide-y divide-border">
          {wifi.map((p) => (
            <WifiRow key={p.id} item={p} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function WifiRow({ item }: { item: PasswordView }) {
  const reveal = useReveal();
  const toast = useToast();
  const copy = async () => {
    try {
      const result = await reveal(item, { field: 'secret', copy: true }, 'Why do you need the Wi-Fi password?');
      if (!result) return;
      await copySecret(result.value);
      toast('Password copied. The clipboard clears in 30 seconds.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <li className="flex items-center justify-between gap-3 px-5 py-3 text-sm">
      <span className="flex min-w-0 items-center gap-2">
        <Wifi className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="min-w-0">
          <AppLink to={`/passwords/${item.id}`} className="block truncate font-medium hover:underline">
            {item.username || item.name}
          </AppLink>
          {item.username && item.username !== item.name && (
            <span className="block truncate text-xs text-muted">{item.name}</span>
          )}
        </span>
      </span>
      <Button variant="secondary" size="sm" onClick={() => void copy()}>
        <Copy /> Copy
      </Button>
    </li>
  );
}

/** Internet lines from the Internet / WAN layout: the provider, the circuit, and the number to call. */
function InternetCard({ clientId }: { clientId: string }) {
  const layouts = useLayouts();
  const layout = layouts.data?.find((l) => l.key === 'internet');
  const assets = useAssets({ client: clientId, layout: layout?.id });
  const lines = layout ? (assets.data ?? []).filter((a) => a.layoutId === layout.id) : [];
  if (!lines.length) return null;
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return (
    <Card>
      <CardHeader title="Internet" description="Who to call when the line is down." />
      <ul className="divide-y divide-border">
        {lines.map((a) => (
          <li key={a.id} className="space-y-1.5 px-5 py-4 text-sm">
            <AppLink to={`/assets/${a.id}`} className="flex items-center gap-2 font-semibold hover:underline">
              <Router className="size-4 text-muted" aria-hidden /> {text(a.fields.provider) || a.name}
            </AppLink>
            {text(a.fields.support_phone) && <Call number={text(a.fields.support_phone)} />}
            {[
              ['Circuit', text(a.fields.circuit_id)],
              ['Account', text(a.fields.account_number)],
              ['Bandwidth', text(a.fields.bandwidth)],
            ]
              .filter(([, v]) => v)
              .map(([label, v]) => (
                <p key={label} className="flex gap-2">
                  <span className="w-20 shrink-0 text-muted">{label}</span>
                  <span className="min-w-0 break-words">{v}</span>
                </p>
              ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** For the client header: opens the site visit page. */
export function SiteVisitButton({ clientId }: { clientId: string }) {
  const go = useGo();
  return (
    <Button variant="secondary" size="sm" onClick={() => go(`/visit/${clientId}`)}>
      <Users /> Site visit
    </Button>
  );
}
