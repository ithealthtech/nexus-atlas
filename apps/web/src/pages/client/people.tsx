import { useState, type FormEvent } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Mail, MapPin, Pencil, Phone, Plus, Star, Trash2, User } from 'lucide-react';
import { atLeast, type ContactView, type LocationView } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { ActivityFeed } from '@/components/panels';
import { ApiError, api } from '@/lib/api';
import { useActivity, useClient, useContacts, useLocations } from '@/lib/queries';

function useClientAccess() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId).data;
  return { clientId, canEdit: atLeast(client?.access ?? 'none', 'edit') };
}

type Kind = 'contacts' | 'locations';
function EntityDialog<T extends ContactView | LocationView>({
  kind,
  clientId,
  item,
  onClose,
}: {
  kind: Kind;
  clientId: string;
  item?: T;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = Object.fromEntries(form);
    body.primary = form.get('primary') === 'on';
    setBusy(true);
    try {
      await api(item ? `/${kind}/${item.id}` : `/clients/${clientId}/${kind}`, {
        method: item ? 'PATCH' : 'POST',
        body,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [kind, clientId] }),
        queryClient.invalidateQueries({ queryKey: ['activity'] }),
      ]);
      toast(item ? 'Saved.' : kind === 'contacts' ? 'Contact added.' : 'Location added.');
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const c = item as ContactView | undefined;
  const l = item as LocationView | undefined;
  const text = (label: string, name: string, value?: string, extra: Record<string, unknown> = {}) => (
    <Field label={label} error={error?.fields?.[name]}>
      {(p) => <Input {...p} name={name} defaultValue={value} {...extra} />}
    </Field>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? `Edit ${item.name}` : kind === 'contacts' ? 'Add a contact' : 'Add a location'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="entity-form" loading={busy}>
            {item ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form id="entity-form" onSubmit={submit} className="space-y-4" noValidate>
        {kind === 'contacts' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {text('Name', 'name', c?.name, { required: true, autoFocus: true, maxLength: 120 })}
              {text('Title', 'title', c?.title, { maxLength: 120, placeholder: 'e.g. Office manager' })}
              {text('Email', 'email', c?.email, { type: 'email', maxLength: 254 })}
              {text('Phone', 'phone', c?.phone, { type: 'tel', maxLength: 40 })}
              {text('Mobile', 'mobile', c?.mobile, { type: 'tel', maxLength: 40 })}
            </div>
          </>
        ) : (
          <>
            {text('Name', 'name', l?.name, {
              required: true,
              autoFocus: true,
              maxLength: 120,
              placeholder: 'e.g. Main office',
            })}
            {text('Street address', 'address', l?.address, { maxLength: 300 })}
            <div className="grid gap-4 sm:grid-cols-3">
              {text('City', 'city', l?.city, { maxLength: 120 })}
              {text('State / region', 'region', l?.region, { maxLength: 120 })}
              {text('Postal code', 'postalCode', l?.postalCode, { maxLength: 20 })}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {text('Country', 'country', l?.country, { maxLength: 80 })}
              {text('Phone', 'phone', l?.phone, { type: 'tel', maxLength: 40 })}
            </div>
          </>
        )}
        <Field label="Notes">
          {(p) => <Textarea {...p} name="notes" defaultValue={item?.notes} rows={3} maxLength={5000} />}
        </Field>
        <Checkbox
          name="primary"
          defaultChecked={item?.primary}
          label={kind === 'contacts' ? 'Primary contact' : 'Primary location'}
          description="Shown on the client overview."
        />
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

function useRemove(kind: Kind, clientId: string) {
  const queryClient = useQueryClient();
  const toast = useToast();
  return async (item: { id: string; name: string }) => {
    if (!confirm(`Delete ${item.name}? This can't be undone.`)) return;
    await api(`/${kind}/${item.id}`, { method: 'DELETE' });
    await queryClient.invalidateQueries({ queryKey: [kind, clientId] });
    toast(`${item.name} deleted.`);
  };
}

export function ClientContacts() {
  const { clientId, canEdit } = useClientAccess();
  const { data, isLoading } = useContacts(clientId);
  const [editing, setEditing] = useState<ContactView | 'new' | null>(null);
  const remove = useRemove('contacts', clientId);
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="font-semibold">Contacts</h2>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> Add contact
          </Button>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="m-5 h-24" />
      ) : !data?.length ? (
        <EmptyState
          icon={User}
          title="No contacts yet"
          description="Add the people you work with at this client: decision makers, the office manager, and vendors' contacts."
        />
      ) : (
        <ul className="grid divide-y divide-border sm:grid-cols-2 sm:divide-y-0">
          {data.map((c) => (
            <li key={c.id} className="group border-border p-5 sm:border-b sm:odd:border-r">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-semibold">
                    {c.name}
                    {c.primary && (
                      <Badge tone="primary">
                        <Star /> Primary
                      </Badge>
                    )}
                  </p>
                  {c.title && <p className="text-sm text-muted">{c.title}</p>}
                </div>
                {canEdit && (
                  <div className="flex gap-1 opacity-60 group-hover:opacity-100">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Delete ${c.name}`} onClick={() => remove(c)}>
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-3 space-y-1 text-sm">
                {c.email && (
                  <a href={`mailto:${c.email}`} className="flex items-center gap-2 text-primary hover:underline">
                    <Mail className="size-4" aria-hidden /> {c.email}
                  </a>
                )}
                {[c.phone, c.mobile].filter(Boolean).map((n) => (
                  <a
                    key={n}
                    href={`tel:${n.replace(/[^\d+]/g, '')}`}
                    className="flex items-center gap-2 text-primary hover:underline"
                  >
                    <Phone className="size-4" aria-hidden /> {n}
                  </a>
                ))}
                {c.notes && <p className="pt-1 whitespace-pre-wrap text-text-2">{c.notes}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EntityDialog
          kind="contacts"
          clientId={clientId}
          item={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

export function ClientLocations() {
  const { clientId, canEdit } = useClientAccess();
  const { data, isLoading } = useLocations(clientId);
  const [editing, setEditing] = useState<LocationView | 'new' | null>(null);
  const remove = useRemove('locations', clientId);
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="font-semibold">Locations</h2>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> Add location
          </Button>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="m-5 h-24" />
      ) : !data?.length ? (
        <EmptyState
          icon={MapPin}
          title="No locations yet"
          description="Offices, data centers, and sites. Assets can be linked to where they live."
        />
      ) : (
        <ul className="divide-y divide-border">
          {data.map((l) => (
            <li key={l.id} className="group flex items-start gap-4 p-5">
              <MapPin className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
              <div className="min-w-0 flex-1 text-sm">
                <p className="flex items-center gap-2 font-semibold">
                  {l.name}
                  {l.primary && (
                    <Badge tone="primary">
                      <Star /> Primary
                    </Badge>
                  )}
                </p>
                <p className="mt-1 whitespace-pre-line text-text-2">
                  {[l.address, [l.city, l.region, l.postalCode].filter(Boolean).join(', '), l.country]
                    .filter(Boolean)
                    .join('\n')}
                </p>
                {l.phone && (
                  <a
                    href={`tel:${l.phone.replace(/[^\d+]/g, '')}`}
                    className="mt-1 inline-flex items-center gap-2 text-primary hover:underline"
                  >
                    <Phone className="size-4" aria-hidden /> {l.phone}
                  </a>
                )}
                {l.notes && <p className="mt-2 whitespace-pre-wrap text-muted">{l.notes}</p>}
              </div>
              {canEdit && (
                <div className="flex gap-1 opacity-60 group-hover:opacity-100">
                  <Button variant="ghost" size="icon" aria-label={`Edit ${l.name}`} onClick={() => setEditing(l)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${l.name}`} onClick={() => remove(l)}>
                    <Trash2 />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <EntityDialog
          kind="locations"
          clientId={clientId}
          item={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

export function ClientActivity() {
  const { clientId } = useClientAccess();
  const { data } = useActivity({ client: clientId, limit: '100' });
  return (
    <Card>
      <div className="border-b border-border px-5 py-4">
        <h2 className="font-semibold">Activity</h2>
        <p className="text-sm text-muted">Changes to this client&rsquo;s documentation, newest first.</p>
      </div>
      <ActivityFeed items={data} showClient={false} />
    </Card>
  );
}
