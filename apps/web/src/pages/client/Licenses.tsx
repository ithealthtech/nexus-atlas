import { useState, type FormEvent, type ReactNode } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, KeyRound, Pencil, Plus, RefreshCw, Trash2, UsersRound } from 'lucide-react';
import { atLeast, type ClientLicensesView, type LicenseView, type MicrosoftLicenseView } from '@atlas/shared';
import {
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
  ListHead,
  ListRow,
  ListToolbar,
  MetricTabs,
  PanelHeader,
  RowActions,
  RowTitle,
  StatusPill,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
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

type Changing = { userId: string; skuId: string; action: 'assign' | 'remove'; userName: string; skuName: string };
type MicrosoftSku = MicrosoftLicenseView['skus'][number];
type MicrosoftUser = MicrosoftLicenseView['users'][number];

// Subscriptions: name, status, seats, cost and renewal, actions. Phones keep the name, status and actions.
const SUBSCRIPTION_COLUMNS =
  'grid-cols-[minmax(180px,2fr)_minmax(84px,0.7fr)_minmax(120px,1fr)_minmax(150px,1.2fr)_74px] max-md:grid-cols-[minmax(150px,1fr)_92px_66px] max-sm:grid-cols-[minmax(120px,1fr)_84px_61px]';
// People: name, account, licenses, actions.
const PEOPLE_COLUMNS =
  'grid-cols-[minmax(180px,2fr)_minmax(84px,0.7fr)_minmax(140px,1.6fr)_44px] max-md:grid-cols-[minmax(150px,1fr)_92px_44px]';
const WIDE = 'max-md:hidden';
const initial = (text: string) => text.trim().charAt(0).toUpperCase() || '?';
/** Free and viral products come with thousands of placeholder seats: they have no real limit to count against. */
const unlimited = (sku: MicrosoftSku) => sku.enabled >= 10_000;
const seatText = (sku: MicrosoftSku) =>
  unlimited(sku) ? `${sku.assigned} assigned · no seat limit` : `${sku.assigned} of ${sku.enabled} seats assigned`;

/** Assigned against bought, with a thin bar that turns amber when every seat is taken. */
function SeatUse({ assigned, total }: { assigned: number; total: number }) {
  const full = total > 0 && assigned >= total;
  return (
    <span className={cn('flex min-w-0 flex-col gap-1.5', WIDE)}>
      <span className="text-xs text-text-2 tabular-nums">
        <strong className="font-[650] text-text">{assigned}</strong> / {total} assigned
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-surface-3">
        <span
          className={cn('block h-full rounded-full', full ? 'bg-warning' : 'bg-primary')}
          style={{ width: `${total ? Math.min(100, (assigned / total) * 100) : 0}%` }}
        />
      </span>
    </span>
  );
}

const SKU_STATE: Record<string, { tone: 'good' | 'bad' | 'warn' | 'muted'; label: string }> = {
  Enabled: { tone: 'good', label: 'Enabled' },
  Warning: { tone: 'warn', label: 'Grace period' },
  Suspended: { tone: 'bad', label: 'Suspended' },
  LockedOut: { tone: 'bad', label: 'Locked' },
};

/** Who holds one Microsoft subscription, and (for administrators) assigning it to someone else. */
function SkuDrawer({
  sku,
  data,
  canChange,
  onChange,
  onClose,
}: {
  sku: MicrosoftSku;
  data: MicrosoftLicenseView;
  canChange: boolean;
  onChange: (change: Changing) => void;
  onClose: () => void;
}) {
  const actor = useActor();
  const [selected, setSelected] = useState('');
  const holders = data.users.filter((u) => u.skuIds.includes(sku.id.toLowerCase()));
  const others = data.users.filter((u) => !u.skuIds.includes(sku.id.toLowerCase()));
  const user = others.find((u) => u.id === selected);
  const available = Math.max(0, sku.enabled - sku.assigned);
  return (
    <Drawer
      open
      onClose={onClose}
      title={sku.name}
      description={unlimited(sku) ? seatText(sku) : `${seatText(sku)} · ${available} available`}
    >
      <div className="space-y-5">
        {actor.isAdmin && (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Assign to" className="min-w-0 flex-1 basis-48">
              {(p) => (
                <Select {...p} value={selected} onChange={(e) => setSelected(e.target.value)}>
                  <option value="">Choose someone without it</option>
                  {others.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.upn})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              disabled={!user || !canChange || available === 0 || sku.status !== 'Enabled'}
              onClick={() =>
                user &&
                onChange({ userId: user.id, skuId: sku.id, action: 'assign', userName: user.name, skuName: sku.name })
              }
            >
              Assign license
            </Button>
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-border">
          {holders.length ? (
            holders.map((u) => (
              <ListRow key={u.id} columns="grid-cols-[minmax(0,1fr)_auto]">
                <RowTitle mark={initial(u.name)} title={u.name} detail={u.upn} />
                {u.groupSkuIds.includes(sku.id.toLowerCase()) ? (
                  <StatusPill tone="muted">By group</StatusPill>
                ) : (
                  actor.isAdmin && (
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-label={`Remove from ${u.name}`}
                      disabled={!canChange}
                      onClick={() =>
                        onChange({ userId: u.id, skuId: sku.id, action: 'remove', userName: u.name, skuName: sku.name })
                      }
                    >
                      Remove
                    </Button>
                  )
                )}
              </ListRow>
            ))
          ) : (
            <p className="px-4 py-6 text-center text-sm text-muted">Nobody holds this subscription.</p>
          )}
        </div>
        <p className="text-xs text-muted">
          Group-assigned licenses change through group membership in Microsoft Entra. Changes need an Atlas
          administrator and the partner account’s delegated license permissions.
        </p>
      </div>
    </Drawer>
  );
}

/** One person's Microsoft licenses, each one assignable or removable by an administrator. */
function PersonDrawer({
  person,
  data,
  canChange,
  onChange,
  onClose,
}: {
  person: MicrosoftUser;
  data: MicrosoftLicenseView;
  canChange: boolean;
  onChange: (change: Changing) => void;
  onClose: () => void;
}) {
  const actor = useActor();
  return (
    <Drawer open onClose={onClose} title={person.name} description={person.upn}>
      <div className="space-y-5">
        {!person.enabled && (
          <p className="rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger">
            Sign-in is blocked for this account. If they have left, remove their licenses, or convert the mailbox to a
            shared mailbox, which needs no license under 50 GB.
          </p>
        )}
        <div className="overflow-hidden rounded-lg border border-border">
          {data.skus.map((sku) => {
            const id = sku.id.toLowerCase();
            const has = person.skuIds.includes(id);
            const byGroup = person.groupSkuIds.includes(id);
            return (
              <ListRow key={sku.id} columns="grid-cols-[minmax(0,1fr)_auto]">
                <RowTitle mark={initial(sku.name)} title={sku.name} detail={seatText(sku)} />
                {byGroup ? (
                  <StatusPill tone="muted">By group</StatusPill>
                ) : actor.isAdmin ? (
                  <Button
                    size="sm"
                    variant={has ? 'secondary' : 'primary'}
                    aria-label={`${has ? 'Remove' : 'Assign'} ${sku.name}`}
                    disabled={!canChange || (!has && (sku.assigned >= sku.enabled || sku.status !== 'Enabled'))}
                    onClick={() =>
                      onChange({
                        userId: person.id,
                        skuId: sku.id,
                        action: has ? 'remove' : 'assign',
                        userName: person.name,
                        skuName: sku.name,
                      })
                    }
                  >
                    {has ? 'Remove' : 'Assign'}
                  </Button>
                ) : (
                  <StatusPill tone={has ? 'good' : 'muted'}>{has ? 'Assigned' : 'Not assigned'}</StatusPill>
                )}
              </ListRow>
            );
          })}
        </div>
      </div>
    </Drawer>
  );
}

type SubscriptionView = 'all' | 'available' | 'full' | 'renewing';
type PeopleView = 'all' | 'licensed' | 'unlicensed' | 'blocked';

export function ClientLicenses() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId).data;
  const actor = useActor();
  const canEdit = atLeast(client?.access ?? 'none', 'edit');
  const cache = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['licenses', clientId],
    queryFn: () => api<ClientLicensesView>(`/clients/${clientId}/licenses`),
  });
  const link = query.data?.microsoft;
  const microsoftKey = ['microsoft-licenses', clientId];
  const microsoft = useQuery({
    queryKey: microsoftKey,
    queryFn: () => api<MicrosoftLicenseView>(`/clients/${clientId}/licenses/microsoft`),
    enabled: link?.mode === 'gdap',
    retry: false,
    staleTime: 60_000,
  });
  const [editing, setEditing] = useState<LicenseView | 'new' | null>(null);
  const [removing, setRemoving] = useState<LicenseView | null>(null);
  const [openSku, setOpenSku] = useState<string | null>(null);
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [changing, setChanging] = useState<Changing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subView, setSubView] = useState<SubscriptionView>('all');
  const [subSearch, setSubSearch] = useState('');
  const [peopleView, setPeopleView] = useState<PeopleView>('all');
  const [peopleSearch, setPeopleSearch] = useState('');
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
      toast('Microsoft confirmed the change. Refreshing assignments.');
      await cache.invalidateQueries({ queryKey: microsoftKey });
    } catch (err) {
      setError((err as Error).message);
      await cache.invalidateQueries({ queryKey: microsoftKey });
    } finally {
      setBusy(false);
    }
  };
  if (query.isLoading) return <Skeleton className="h-40" />;
  if (query.error) return <FormError message={(query.error as Error).message} />;

  const tracked = query.data?.licenses ?? [];
  const data = microsoft.data;
  // Changes wait for a fresh read: a failed refresh leaves the last result on screen, read-only.
  const canChange = !microsoft.isError && !microsoft.isFetching;
  const daysTo = (date: string | null) =>
    date ? Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000) : null;

  // One list of subscriptions: Microsoft's, read live, and the ones tracked in Atlas.
  const rows = [
    ...(data?.skus ?? []).map((sku) => ({
      key: `ms-${sku.id}`,
      name: sku.name,
      search: `${sku.name} ${sku.part} microsoft`,
      // A product with no seat limit isn't counted as having seats free.
      assigned: unlimited(sku) ? null : sku.assigned,
      total: sku.enabled,
      renewing: false,
      sku,
      license: null as LicenseView | null,
    })),
    ...tracked.map((l) => {
      const days = daysTo(l.renewalDate ?? null);
      return {
        key: `tracked-${l.id}`,
        name: l.name,
        search: `${l.name} ${l.vendor}`,
        // Without recorded assignments, seat use isn't known.
        assigned: l.assignments.length ? l.assignments.length : null,
        total: l.seats,
        renewing: l.status === 'active' && days !== null && days <= 30,
        sku: null as MicrosoftSku | null,
        license: l,
      };
    }),
  ];
  const hasRoom = (r: (typeof rows)[number]) => r.assigned !== null && r.total > r.assigned;
  const isFull = (r: (typeof rows)[number]) => r.assigned !== null && r.total > 0 && r.assigned >= r.total;
  const shownRows = rows.filter(
    (r) =>
      (subView === 'all' ||
        (subView === 'available' && hasRoom(r)) ||
        (subView === 'full' && isFull(r)) ||
        (subView === 'renewing' && r.renewing)) &&
      r.search.toLowerCase().includes(subSearch.trim().toLowerCase()),
  );
  const seatsFree = rows.reduce((n, r) => n + (hasRoom(r) ? r.total - r.assigned! : 0), 0);

  const people = data?.users ?? [];
  const skuName = new Map(data?.skus.map((s) => [s.id.toLowerCase(), s.name]));
  const isBlockedLicensed = (u: MicrosoftUser) => !u.enabled && u.skuIds.length > 0;
  const shownPeople = people.filter(
    (u) =>
      (peopleView === 'all' ||
        (peopleView === 'licensed' && u.skuIds.length > 0) ||
        (peopleView === 'unlicensed' && !u.skuIds.length) ||
        (peopleView === 'blocked' && isBlockedLicensed(u))) &&
      `${u.name} ${u.upn}`.toLowerCase().includes(peopleSearch.trim().toLowerCase()),
  );
  const sku = data?.skus.find((s) => s.id === openSku);
  const person = people.find((u) => u.id === openPerson);
  const refreshButton = link?.mode === 'gdap' && (
    <Button size="sm" variant="secondary" loading={microsoft.isFetching} onClick={() => microsoft.refetch()}>
      <RefreshCw /> Refresh
    </Button>
  );

  return (
    <div className="space-y-5">
      <Card className="overflow-hidden">
        <PanelHeader
          title="Subscriptions & seats"
          description={[
            link ? (link.mode === 'gdap' ? 'Microsoft 365 via GDAP' : 'Microsoft 365 needs GDAP') : null,
            `${tracked.length} tracked in Atlas`,
            data && `read ${relativeTime(data.checkedAt)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
          actions={
            <>
              {refreshButton}
              {canEdit && (
                <Button size="sm" onClick={() => setEditing('new')}>
                  <Plus /> Add subscription
                </Button>
              )}
            </>
          }
        />
        <MetricTabs
          label="Show subscriptions"
          value={subView}
          onChange={setSubView}
          items={[
            { id: 'all', label: 'All subscriptions', count: rows.length },
            { id: 'available', label: 'Seats available', count: seatsFree },
            { id: 'full', label: 'Fully used', count: rows.filter(isFull).length },
            { id: 'renewing', label: 'Renewing in 30 days', count: rows.filter((r) => r.renewing).length },
          ]}
        />
        {link && link.mode !== 'gdap' && (
          <p className="border-b border-border bg-warning-soft px-[19px] py-3 text-sm text-warning">
            Connect {link.name ?? 'this tenant'} through GDAP to see and manage its Microsoft 365 licenses here.{' '}
            {actor.isAdmin && (
              <AppLink to="/admin/data" className="font-semibold underline">
                Microsoft 365 settings
              </AppLink>
            )}
          </p>
        )}
        {microsoft.error && (
          <div className="border-b border-border px-[19px] py-3">
            <FormError message={(microsoft.error as Error).message} />
            {data && (
              <p className="text-sm text-warning">Showing the last result. Changes wait until a refresh succeeds.</p>
            )}
          </div>
        )}
        <ListToolbar
          query={subSearch}
          onQuery={setSubSearch}
          placeholder="Search subscriptions or vendors"
          shown={shownRows.length}
          total={rows.length}
          noun="subscription"
        />
        <ListHead
          columns={SUBSCRIPTION_COLUMNS}
          labels={[
            'Subscription',
            'Status',
            { label: 'Seats', className: WIDE },
            { label: 'Cost & renewal', className: WIDE },
            '',
          ]}
        />
        {microsoft.isLoading && <Skeleton className="m-4 h-16" />}
        {!rows.length && !microsoft.isLoading ? (
          <EmptyState
            icon={CreditCard}
            title="No subscriptions yet"
            description={
              link?.mode === 'gdap'
                ? 'Microsoft reports none for this tenant. Add other software subscriptions to track seats, costs and renewals.'
                : 'Add software subscriptions to track seats, costs, assignments and renewal dates.'
            }
          />
        ) : !shownRows.length ? (
          <p className="px-5 py-8 text-center text-sm text-muted">No subscriptions match.</p>
        ) : (
          shownRows.map((r) => {
            if (r.sku) {
              const state = SKU_STATE[r.sku.status] ?? { tone: 'muted' as const, label: r.sku.status || 'Unknown' };
              return (
                <ListRow key={r.key} columns={SUBSCRIPTION_COLUMNS}>
                  <RowTitle mark={initial(r.name)} title={r.name} detail={`Microsoft 365 · ${r.sku.part}`} />
                  <StatusPill tone={state.tone}>{state.label}</StatusPill>
                  {unlimited(r.sku) ? (
                    <span className={cn('text-xs text-muted', WIDE)}>{r.sku.assigned} assigned · no seat limit</span>
                  ) : (
                    <SeatUse assigned={r.sku.assigned} total={r.sku.enabled} />
                  )}
                  <span className={cn('flex min-w-0 flex-col gap-1', WIDE)}>
                    <span className="truncate text-xs text-text-2">Billed by your reseller</span>
                    <small className="truncate text-[11px] text-muted">
                      {unlimited(r.sku)
                        ? 'Free or unlimited'
                        : `${Math.max(0, r.sku.enabled - r.sku.assigned)} seats free`}
                    </small>
                  </span>
                  <RowActions>
                    <IconButton label={`Who holds ${r.name}`} onClick={() => setOpenSku(r.sku!.id)}>
                      <UsersRound />
                    </IconButton>
                  </RowActions>
                </ListRow>
              );
            }
            const l = r.license!;
            const days = daysTo(l.renewalDate ?? null);
            const period = l.billingCycle === 'one_time' ? 'one-time' : l.billingCycle === 'annual' ? 'year' : 'month';
            return (
              <ListRow key={r.key} columns={SUBSCRIPTION_COLUMNS}>
                <RowTitle
                  mark={initial(l.name)}
                  title={l.name}
                  detail={[l.vendor || 'Tracked in Atlas', l.assignments.length ? l.assignments.join(', ') : null]
                    .filter(Boolean)
                    .join(' · ')}
                />
                <StatusPill tone={l.status === 'active' ? 'good' : 'muted'}>
                  {l.status === 'active' ? 'Active' : 'Cancelled'}
                </StatusPill>
                {r.assigned === null ? (
                  <span className={cn('text-xs text-muted', WIDE)}>{l.seats} seats · not recorded</span>
                ) : (
                  <SeatUse assigned={r.assigned} total={l.seats} />
                )}
                <span className={cn('flex min-w-0 flex-col gap-1', WIDE)}>
                  <span className="truncate text-xs text-text-2 tabular-nums">
                    {money(l.unitCostCents * l.seats, l.currency)} / {period}
                  </span>
                  <small
                    className={cn(
                      'truncate text-[11px]',
                      l.status === 'active' && days !== null && days <= 30
                        ? 'font-semibold text-warning'
                        : 'text-muted',
                    )}
                  >
                    {l.renewalDate
                      ? days !== null && days < 0
                        ? `Renewal date passed ${l.renewalDate}`
                        : `Renews ${l.renewalDate}${l.autoRenew ? ' · automatically' : ''}`
                      : 'No renewal date'}
                  </small>
                </span>
                <RowActions>
                  {canEdit && (
                    <>
                      <IconButton label={`Edit ${l.name}`} onClick={() => setEditing(l)}>
                        <Pencil />
                      </IconButton>
                      <IconButton
                        label={`Delete ${l.name}`}
                        onClick={() => {
                          setError(null);
                          setRemoving(l);
                        }}
                      >
                        <Trash2 />
                      </IconButton>
                    </>
                  )}
                </RowActions>
              </ListRow>
            );
          })
        )}
      </Card>

      {data && (
        <Card className="overflow-hidden">
          <PanelHeader
            title="People & licenses"
            description={`Microsoft Graph · ${people.length} ${people.length === 1 ? 'account' : 'accounts'} in ${link?.name ?? 'the tenant'}`}
            actions={refreshButton}
          />
          <MetricTabs
            label="Show people"
            value={peopleView}
            onChange={setPeopleView}
            items={[
              { id: 'all', label: 'Total users', count: people.length },
              { id: 'licensed', label: 'Licensed', count: people.filter((u) => u.skuIds.length).length },
              { id: 'unlicensed', label: 'Unlicensed', count: people.filter((u) => !u.skuIds.length).length },
              { id: 'blocked', label: 'Blocked, still licensed', count: people.filter(isBlockedLicensed).length },
            ]}
          />
          <ListToolbar
            query={peopleSearch}
            onQuery={setPeopleSearch}
            placeholder="Search names or email"
            shown={shownPeople.length}
            total={people.length}
            noun="account"
          />
          <ListHead columns={PEOPLE_COLUMNS} labels={['User', 'Account', { label: 'Licenses', className: WIDE }, '']} />
          {!shownPeople.length ? (
            <p className="px-5 py-8 text-center text-sm text-muted">No accounts match.</p>
          ) : (
            shownPeople.map((u) => {
              const names = u.skuIds.map((id) => skuName.get(id)).filter(Boolean);
              return (
                <ListRow key={u.id} columns={PEOPLE_COLUMNS}>
                  <RowTitle mark={initial(u.name)} title={u.name} detail={u.upn} />
                  <StatusPill tone={u.enabled ? 'good' : 'bad'}>{u.enabled ? 'Enabled' : 'Blocked'}</StatusPill>
                  <span className={cn('truncate text-xs', names.length ? 'text-text-2' : 'text-muted', WIDE)}>
                    {names.length ? names.join(', ') : 'No license'}
                  </span>
                  <RowActions>
                    <IconButton label={`Licenses for ${u.name}`} onClick={() => setOpenPerson(u.id)}>
                      <KeyRound />
                    </IconButton>
                  </RowActions>
                </ListRow>
              );
            })
          )}
        </Card>
      )}

      {sku && data && (
        <SkuDrawer
          sku={sku}
          data={data}
          canChange={canChange}
          onChange={setChanging}
          onClose={() => setOpenSku(null)}
        />
      )}
      {person && data && (
        <PersonDrawer
          person={person}
          data={data}
          canChange={canChange}
          onChange={setChanging}
          onClose={() => setOpenPerson(null)}
        />
      )}
      {editing && (
        <LicenseDialog
          clientId={clientId}
          item={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
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
            {changing.action === 'assign' ? 'to' : 'from'} {changing.userName} in {link?.name ?? 'the tenant'}? This
            changes the user’s access in Microsoft 365.
          </p>
          <FormError message={error} />
        </Dialog>
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

/** A row action: an icon with its name for screen readers and as a tooltip. */
function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  );
}
