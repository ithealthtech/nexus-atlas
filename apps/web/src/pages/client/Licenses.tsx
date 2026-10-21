import { useState, type FormEvent } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { atLeast, type ClientLicensesView, type LicenseView, type MicrosoftLicenseView } from '@atlas/shared';
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
  Select,
  Skeleton,
  Textarea,
  useToast,
  Drawer,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useClient } from '@/lib/queries';
import { useActor } from '@/lib/session';
import { AppLink } from '@/components/AppLink';

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);

function LicenseDialog({
  clientId,
  item,
  onClose,
  onSaved,
}: {
  clientId: string;
  item?: LicenseView;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const license = {
      ...Object.fromEntries(form),
      seats: Number(form.get('seats')),
      unitCostCents: Math.round(Number(form.get('unitCost')) * 100),
      assignments: String(form.get('assignments') ?? '')
        .split('\n')
        .map((a) => a.trim())
        .filter(Boolean),
      autoRenew: form.get('autoRenew') === 'on',
      renewalDate: form.get('renewalDate') || null,
    };
    try {
      await api(`/clients/${clientId}/licenses${item ? `/${item.id}` : ''}`, {
        method: item ? 'PUT' : 'POST',
        body: item ? { version: item.version, license } : license,
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const text = (label: string, name: string, value: string | number = '', type = 'text') => (
    <Field label={label} error={error?.fields?.[name] ?? error?.fields?.[`license.${name}`]}>
      {(p) => (
        <Input
          {...p}
          name={name}
          type={type}
          defaultValue={value}
          required={name === 'name' || name === 'seats'}
          min={name === 'seats' ? 1 : 0}
          maxLength={type === 'text' ? 160 : undefined}
          step={name === 'unitCost' ? '0.01' : undefined}
        />
      )}
    </Field>
  );
  return (
    <Drawer
      open
      onClose={onClose}
      title={item ? 'Edit subscription' : 'Add subscription'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="license-form" loading={busy}>
            Save subscription
          </Button>
        </>
      }
    >
      <form id="license-form" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">
          Track software purchased outside the GDAP connection. Keep activation keys and passwords in the vault.
        </p>
        {text('Product / subscription', 'name', item?.name)}
        {text('Vendor', 'vendor', item?.vendor)}
        <div className="grid gap-4 sm:grid-cols-2">
          {text('Purchased seats', 'seats', item?.seats ?? 1, 'number')}
          {text('Cost per seat per billing period', 'unitCost', (item?.unitCostCents ?? 0) / 100, 'number')}
          <Field label="Currency">
            {(p) => (
              <Select {...p} name="currency" defaultValue={item?.currency ?? 'USD'}>
                {['USD', 'CAD', 'EUR', 'GBP', 'AUD'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Billing cycle">
            {(p) => (
              <Select {...p} name="billingCycle" defaultValue={item?.billingCycle ?? 'monthly'}>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
                <option value="one_time">One-time</option>
              </Select>
            )}
          </Field>
          {text('Renewal date', 'renewalDate', item?.renewalDate ?? '', 'date')}
          <Field label="Status">
            {(p) => (
              <Select {...p} name="status" defaultValue={item?.status ?? 'active'}>
                <option value="active">Active</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            )}
          </Field>
        </div>
        <Checkbox name="autoRenew" label="Renews automatically" defaultChecked={item?.autoRenew} />
        <Field
          label="Assigned users or devices"
          help="One name or email per line. Assignments cannot exceed purchased seats."
          error={error?.fields?.assignments ?? error?.fields?.['license.assignments']}
        >
          {(p) => (
            <Textarea
              {...p}
              name="assignments"
              defaultValue={item?.assignments.join('\n')}
              rows={3}
              maxLength={10000}
            />
          )}
        </Field>
        <Field label="Notes">
          {(p) => <Textarea {...p} name="notes" defaultValue={item?.notes} rows={3} maxLength={5000} />}
        </Field>
        <FormError message={error?.message} />
      </form>
    </Drawer>
  );
}

function MicrosoftLicenses({ clientId, name, mode }: { clientId: string; name: string; mode: 'gdap' | 'application' }) {
  const actor = useActor();
  const toast = useToast();
  const cache = useQueryClient();
  const [selectedSku, setSelectedSku] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [filter, setFilter] = useState('');
  const [changing, setChanging] = useState<{
    userId: string;
    skuId: string;
    action: 'assign' | 'remove';
    userName: string;
    skuName: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryKey = ['microsoft-licenses', clientId];
  const query = useQuery({
    queryKey,
    queryFn: () => api<MicrosoftLicenseView>(`/clients/${clientId}/licenses/microsoft`),
    enabled: mode === 'gdap',
    retry: false,
    staleTime: 60_000,
  });
  const data = query.data;
  const change = async () => {
    if (!changing) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/clients/${clientId}/licenses/microsoft/assignments`, {
        method: 'POST',
        body: { userId: changing.userId, skuId: changing.skuId, action: changing.action },
      });
      setChanging(null);
      setSelectedUser('');
      toast('Microsoft confirmed the change. Refreshing assignments.');
      await cache.invalidateQueries({ queryKey });
    } catch (err) {
      setError((err as Error).message);
      await cache.invalidateQueries({ queryKey });
    } finally {
      setBusy(false);
    }
  };
  const sku = data?.skus.find((s) => s.id === selectedSku);
  const user = data?.users.find((u) => u.id === selectedUser);
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
        <div>
          <h2 className="font-semibold">Microsoft 365</h2>
          <p className="text-sm text-muted">
            {name} · {mode === 'gdap' ? 'Managed via GDAP' : 'GDAP connection required'}
          </p>
        </div>
        {mode === 'gdap' && (
          <Button size="sm" variant="secondary" loading={query.isFetching} onClick={() => query.refetch()}>
            <RefreshCw /> Refresh from Microsoft
          </Button>
        )}
      </div>
      <div className="space-y-4 p-5">
        {mode !== 'gdap' ? (
          <p className="text-sm">
            Connect this tenant through GDAP to manage its Microsoft 365 licenses.{' '}
            {actor.isAdmin && (
              <AppLink to="/admin/data" className="text-primary underline">
                Microsoft 365 settings
              </AppLink>
            )}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Seats and assignments come directly from Microsoft through the partner connection. Subscription purchases,
              prices, and renewal dates are managed with your reseller.
            </p>
            {query.isLoading && <Skeleton className="h-24" />}
            {query.error && <FormError message={(query.error as Error).message} />}
            {query.error && data && (
              <p className="text-sm text-warning">
                Showing the last successful result. Changes are disabled until a refresh succeeds.
              </p>
            )}
            {data && (
              <>
                <p className="text-xs text-muted">Last read: {new Date(data.checkedAt).toLocaleString()}</p>
                {!data.skus.length ? (
                  <p className="text-sm">Microsoft reports no subscriptions for this tenant.</p>
                ) : (
                  <>
                    <Field label="Microsoft subscription">
                      {(p) => (
                        <Select
                          {...p}
                          value={selectedSku}
                          onChange={(e) => {
                            setSelectedSku(e.target.value);
                            setSelectedUser('');
                          }}
                        >
                          <option value="">Choose a subscription</option>
                          {data.skus.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} — {s.assigned} assigned / {s.enabled} enabled
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    {sku && (
                      <div className="space-y-4">
                        <div className="flex flex-wrap gap-2">
                          <Badge>{sku.status}</Badge>
                          <Badge>{sku.enabled} enabled seats</Badge>
                          <Badge>{sku.assigned} assigned</Badge>
                          <Badge tone={sku.enabled > sku.assigned ? 'success' : 'warning'}>
                            {Math.max(0, sku.enabled - sku.assigned)} available
                          </Badge>
                        </div>
                        {actor.isAdmin && (
                          <div className="flex flex-wrap items-end gap-3">
                            <Field label="Assign to a user" className="min-w-0 flex-1">
                              {(p) => (
                                <Select {...p} value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)}>
                                  <option value="">Choose an unassigned user</option>
                                  {data.users
                                    .filter((u) => !u.skuIds.includes(sku.id))
                                    .map((u) => (
                                      <option key={u.id} value={u.id}>
                                        {u.name} ({u.upn})
                                      </option>
                                    ))}
                                </Select>
                              )}
                            </Field>
                            <Button
                              disabled={
                                !user ||
                                query.isError ||
                                query.isFetching ||
                                sku.assigned >= sku.enabled ||
                                sku.status !== 'Enabled'
                              }
                              onClick={() => {
                                if (user) {
                                  setError(null);
                                  setChanging({
                                    userId: user.id,
                                    skuId: sku.id,
                                    action: 'assign',
                                    userName: user.name,
                                    skuName: sku.name,
                                  });
                                }
                              }}
                            >
                              Assign license
                            </Button>
                          </div>
                        )}
                        <Field label="Search assigned users">
                          {(p) => (
                            <Input {...p} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
                          )}
                        </Field>
                        <ul className="divide-y divide-border">
                          {data.users
                            .filter(
                              (u) =>
                                u.skuIds.includes(sku.id) &&
                                `${u.name} ${u.upn}`.toLowerCase().includes(filter.toLowerCase()),
                            )
                            .map((u) => (
                              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                                <div className="min-w-0">
                                  <p className="font-medium wrap-anywhere">{u.name}</p>
                                  <p className="text-sm text-muted wrap-anywhere">{u.upn}</p>
                                </div>
                                {u.groupSkuIds.includes(sku.id) ? (
                                  <Badge>Assigned by group</Badge>
                                ) : (
                                  actor.isAdmin && (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      disabled={query.isError || query.isFetching}
                                      onClick={() => {
                                        setError(null);
                                        setChanging({
                                          userId: u.id,
                                          skuId: sku.id,
                                          action: 'remove',
                                          userName: u.name,
                                          skuName: sku.name,
                                        });
                                      }}
                                    >
                                      Remove from {u.name}
                                    </Button>
                                  )
                                )}
                              </li>
                            ))}
                        </ul>
                        <p className="text-xs text-muted">
                          Group-assigned licenses must be managed through group membership in Microsoft Entra. License
                          changes require an Atlas administrator and the partner account’s delegated license
                          permissions.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
      {changing && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setChanging(null);
          }}
          title={changing.action === 'assign' ? 'Assign Microsoft 365 license' : 'Remove Microsoft 365 license'}
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setChanging(null)}>
                Cancel
              </Button>
              <Button loading={busy} onClick={change}>
                Confirm {changing.action === 'assign' ? 'assignment' : 'removal'}
              </Button>
            </>
          }
        >
          <p className="mb-4 text-sm">
            {changing.action === 'assign' ? 'Assign' : 'Remove'} {changing.skuName}{' '}
            {changing.action === 'assign' ? 'to' : 'from'} {changing.userName} in {name}? This changes the user’s access
            in Microsoft 365.
          </p>
          <FormError message={error} />
        </Dialog>
      )}
    </Card>
  );
}

export function ClientLicenses() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId).data;
  const canEdit = atLeast(client?.access ?? 'none', 'edit');
  const cache = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['licenses', clientId],
    queryFn: () => api<ClientLicensesView>(`/clients/${clientId}/licenses`),
  });
  const [editing, setEditing] = useState<LicenseView | 'new' | null>(null);
  const [removing, setRemoving] = useState<LicenseView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [today] = useState(() => Date.parse(new Date().toISOString().slice(0, 10)));
  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['licenses', clientId] }),
      cache.invalidateQueries({ queryKey: ['activity'] }),
    ]);
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/clients/${clientId}/licenses/${removing.id}`, {
        method: 'DELETE',
        body: { version: removing.version },
      });
      await refresh();
      setRemoving(null);
      toast('Subscription deleted.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (query.isLoading) return <Skeleton className="h-40" />;
  if (query.error) return <FormError message={(query.error as Error).message} />;
  const items = query.data?.licenses ?? [];
  const link = query.data?.microsoft;
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">License management</h2>
        <p className="mt-1 text-sm text-muted">
          Subscriptions, seats, assignments, and upcoming renewals for {client?.name}.
        </p>
      </div>
      {link && (
        <MicrosoftLicenses key={clientId} clientId={clientId} name={link.name ?? link.tenantId} mode={link.mode} />
      )}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
          <div>
            <h3 className="font-semibold">{link ? 'Other software subscriptions' : 'Software subscriptions'}</h3>
            <p className="text-sm text-muted">
              Manually tracked · {items.length} {items.length === 1 ? 'subscription' : 'subscriptions'}
            </p>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus /> Add subscription
            </Button>
          )}
        </div>
        {!items.length ? (
          <EmptyState
            icon={CreditCard}
            title="No subscriptions tracked yet"
            description="Add software subscriptions to track seats, costs, assignments, and renewal dates."
          />
        ) : (
          <>
            <div className="p-5">
              <Field label="Search subscriptions">
                {(p) => <Input {...p} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />}
              </Field>
            </div>
            <ul className="divide-y divide-border">
              {items
                .filter((l) => `${l.name} ${l.vendor}`.toLowerCase().includes(search.toLowerCase()))
                .map((l) => {
                  const days = l.renewalDate
                    ? Math.round((Date.parse(l.renewalDate + 'T00:00:00Z') - today) / 86_400_000)
                    : null;
                  return (
                    <li key={l.id} className="space-y-3 p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-semibold wrap-anywhere">{l.name}</p>
                          <p className="text-sm text-muted wrap-anywhere">{l.vendor || 'No vendor specified'}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge tone={l.status === 'active' ? 'success' : 'neutral'}>
                            {l.status === 'active' ? 'Active' : 'Cancelled'}
                          </Badge>
                          {canEdit && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Edit ${l.name}`}
                                onClick={() => setEditing(l)}
                              >
                                <Pencil />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Delete ${l.name}`}
                                onClick={() => {
                                  setError(null);
                                  setRemoving(l);
                                }}
                              >
                                <Trash2 />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="grid gap-3 text-sm sm:grid-cols-3">
                        <p>
                          <span className="block text-xs text-muted">Seat usage</span>
                          {l.assignments.length} / {l.seats} assigned · {l.seats - l.assignments.length} available
                        </p>
                        <p>
                          <span className="block text-xs text-muted">Subscription cost</span>
                          {money(l.unitCostCents * l.seats, l.currency)} /{' '}
                          {l.billingCycle === 'one_time'
                            ? 'one-time purchase'
                            : l.billingCycle === 'annual'
                              ? 'year'
                              : 'month'}
                        </p>
                        <div>
                          <span className="block text-xs text-muted">Renewal</span>
                          {l.renewalDate ?? 'Not recorded'}
                          {l.autoRenew && ' · Auto-renew'}
                          {l.status === 'active' && days !== null && days <= 30 && (
                            <Badge className="ml-2" tone="warning">
                              {days < 0 ? 'Past renewal date' : 'Due within 30 days'}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {!!l.assignments.length && (
                        <p className="text-sm text-muted wrap-anywhere">Assigned: {l.assignments.join(', ')}</p>
                      )}
                      {l.notes && <p className="text-sm whitespace-pre-wrap wrap-anywhere">{l.notes}</p>}
                    </li>
                  );
                })}
            </ul>
          </>
        )}
      </Card>
      {editing && (
        <LicenseDialog
          clientId={clientId}
          item={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {removing && (
        <Dialog
          open
          onClose={() => {
            if (!busy) setRemoving(null);
          }}
          title="Delete tracked subscription"
          footer={
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button loading={busy} onClick={remove}>
                Delete subscription
              </Button>
            </>
          }
        >
          <p className="mb-4 text-sm">
            Delete {removing.name} from Atlas? This removes the tracking record. To cancel the subscription itself,
            contact the vendor.
          </p>
          <FormError message={error} />
        </Dialog>
      )}
    </div>
  );
}
