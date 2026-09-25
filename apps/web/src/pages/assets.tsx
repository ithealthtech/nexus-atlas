import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, ArrowLeft, Pencil, Plus, RefreshCw, Search, Server } from 'lucide-react';
import { ASSET_STATUSES, atLeast, type AssetView, type LayoutField, type LayoutView } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { FieldInput, FieldValue } from '@/components/fields';
import { ItemIcon } from '@/components/ItemIcon';
import { AttachmentsPanel, ItemActivity, RelatedPanel, RevisionsPanel } from '@/components/panels';
import { ApiError, api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { useAsset, useAssets, useClient, useClients, useLayouts } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { AppLink } from '@/components/AppLink';
import { cn } from '@/lib/cn';

const statusTone = { active: 'success', inactive: 'warning', retired: 'neutral' } as const;

// ---------------------------------------------------------------- form
export function AssetDialog({
  clientId,
  asset,
  layoutId,
  onClose,
}: {
  clientId: string;
  asset?: AssetView;
  layoutId?: string;
  onClose: () => void;
}) {
  const layouts = (useLayouts().data ?? []).filter((l) => !l.archived || l.id === asset?.layoutId);
  const [chosen, setChosen] = useState<string | undefined>(asset?.layoutId ?? layoutId);
  const layout = layouts.find((l) => l.id === chosen);
  const [values, setValues] = useState<Record<string, unknown>>(asset?.fields ?? {});
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const body = { name: form.get('name'), status: form.get('status'), notes: form.get('notes'), fields: values };
    try {
      const saved = asset
        ? await api<AssetView>(`/assets/${asset.id}`, { method: 'PATCH', body: { ...body, version: asset.version } })
        : await api<AssetView>(`/clients/${clientId}/assets`, {
            method: 'POST',
            body: { ...body, layoutId: layout!.id },
          });
      client.setQueryData(['asset', saved.id], saved);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['assets'] }),
        client.invalidateQueries({ queryKey: ['revisions', 'assets', saved.id] }),
        client.invalidateQueries({ queryKey: ['activity'] }),
      ]);
      toast(asset ? 'Asset saved.' : `${saved.name} added.`);
      onClose();
      if (!asset) navigate({ to: '/assets/$assetId', params: { assetId: saved.id } });
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (!layout)
    return (
      <Dialog
        open
        onClose={onClose}
        size="lg"
        title="What are you documenting?"
        description="Pick a layout. Administrators can add more under Asset layouts."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {layouts.map((l) => (
            <button
              key={l.id}
              onClick={() => setChosen(l.id)}
              className="flex items-start gap-3 rounded-xl border border-border p-3 text-left hover:border-primary hover:bg-primary-soft/50"
            >
              <ItemIcon type="asset" icon={l.icon} />
              <span>
                <span className="block text-sm font-semibold">{l.name}</span>
                <span className="block text-xs text-muted">{l.description}</span>
              </span>
            </button>
          ))}
        </div>
      </Dialog>
    );
  const fieldError = (key: string) => error?.fields?.[`fields.${key}`];
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={asset ? `Edit ${asset.name}` : `New ${layout.name.replace(/s$/, '').toLowerCase()}`}
      description={layout.description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="asset-form" loading={busy}>
            {asset ? 'Save changes' : 'Create asset'}
          </Button>
        </>
      }
    >
      <form id="asset-form" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <Field
            label={
              <>
                Name<span className="text-danger"> *</span>
              </>
            }
            error={error?.fields?.name}
          >
            {(p) => <Input {...p} name="name" defaultValue={asset?.name} required maxLength={200} autoFocus />}
          </Field>
          <Field label="Status">
            {(p) => (
              <Select {...p} name="status" defaultValue={asset?.status ?? 'active'}>
                {ASSET_STATUSES.map((s) => (
                  <option key={s} value={s} className="capitalize">
                    {s[0]!.toUpperCase() + s.slice(1)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {layout.key === 'domain' && (
          <DomainRefresh
            onFound={(found) => setValues((all) => ({ ...all, ...found }))}
            onError={(message) => toast(message, 'error')}
            fieldKeys={layout.fields.map((f) => f.key)}
          />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {layout.fields.map((f) => (
            <div key={f.key} className={cn((f.type === 'textarea' || f.type === 'multiselect') && 'sm:col-span-2')}>
              <FieldInput
                field={f}
                value={values[f.key]}
                onChange={(v) => setValues((all) => ({ ...all, [f.key]: v }))}
                error={fieldError(f.key)}
              />
            </div>
          ))}
        </div>
        <Field
          label="Notes"
          help="Configuration details, quirks, and history. Keep passwords out; the vault is coming."
        >
          {(p) => <Textarea {...p} name="notes" defaultValue={asset?.notes} rows={4} maxLength={20000} />}
        </Field>
        <FormError
          message={error && !error.fields ? error.message : error?.fields ? 'Check the highlighted fields.' : null}
        />
      </form>
    </Dialog>
  );
}

// Domains: blank fields are filled from the domain when saved; this re-detects all of them now.
function DomainRefresh({
  fieldKeys,
  onFound,
  onError,
}: {
  fieldKeys: string[];
  onFound: (fields: Record<string, string>) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const refresh = async (button: HTMLButtonElement) => {
    const name = (button.form?.elements.namedItem('name') as HTMLInputElement | null)?.value ?? '';
    if (!name.trim()) return onError('Enter the domain as the name first, for example example.com.');
    setBusy(true);
    try {
      const found = await api<Record<string, string>>('/domains/lookup', { method: 'POST', body: { domain: name } });
      const fields = Object.fromEntries(
        Object.entries(found).filter(([k, v]) => k !== 'domain' && v && fieldKeys.includes(k)),
      );
      if (!Object.keys(fields).length) onError(`Nothing was found for ${found.domain}.`);
      else onFound(fields);
    } catch (err) {
      onError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
      <span>Blank fields are filled in from the domain when you save.</span>
      <Button variant="secondary" size="sm" loading={busy} onClick={(e) => void refresh(e.currentTarget)}>
        <RefreshCw /> Refresh from domain
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- list
function AssetTable({ assets, layout, showClient }: { assets: AssetView[]; layout?: LayoutView; showClient: boolean }) {
  const columns: LayoutField[] = layout ? layout.fields.filter((f) => f.showInList).slice(0, 4) : [];
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-2 text-xs text-muted">
          <tr>
            <th className="px-5 py-3 font-medium">Name</th>
            {showClient && <th className="px-5 py-3 font-medium">Client</th>}
            {columns.map((c) => (
              <th key={c.key} className="hidden px-5 py-3 font-medium md:table-cell">
                {c.label}
              </th>
            ))}
            <th className="px-5 py-3 font-medium">Status</th>
            <th className="hidden px-5 py-3 font-medium sm:table-cell">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {assets.map((a) => (
            <tr key={a.id} className="hover:bg-surface-2">
              <td className="px-5 py-3">
                <AppLink to={`/assets/${a.id}`} className="flex items-center gap-3">
                  <ItemIcon type="asset" icon={a.layoutIcon} />
                  <span className="min-w-0">
                    <span className="block font-semibold hover:underline">{a.name}</span>
                    {!layout && <span className="block text-xs text-muted">{a.layoutName}</span>}
                  </span>
                </AppLink>
              </td>
              {showClient && <td className="px-5 py-3 text-text-2">{a.clientName}</td>}
              {columns.map((c) => (
                <td key={c.key} className="hidden max-w-56 truncate px-5 py-3 text-text-2 md:table-cell">
                  <FieldValue field={c} value={a.fields[c.key]} />
                </td>
              ))}
              <td className="px-5 py-3">
                <Badge tone={statusTone[a.status]} className="capitalize">
                  {a.status}
                </Badge>
              </td>
              <td className="hidden px-5 py-3 whitespace-nowrap text-muted sm:table-cell">
                {relativeTime(a.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AssetsView({ clientId }: { clientId?: string }) {
  const search = useSearch({ strict: false }) as { layout?: string; archived?: boolean };
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const layouts = useLayouts().data ?? [];
  const client = useClient(clientId ?? '');
  const canEdit = clientId ? atLeast(client.data?.access ?? 'none', 'edit') : false;
  const all = useAssets({ client: clientId, archived: search.archived });
  const layout = layouts.find((l) => l.id === search.layout);
  const rows = useMemo(
    () =>
      (all.data ?? []).filter(
        (a) =>
          (!search.layout || a.layoutId === search.layout) &&
          `${a.name} ${a.clientName} ${JSON.stringify(a.fields)}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [all.data, search.layout, query],
  );
  const setLayout = (id?: string) =>
    navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, layout: id }) });
  const counts = new Map<string, number>();
  for (const a of all.data ?? []) counts.set(a.layoutId, (counts.get(a.layoutId) ?? 0) + 1);
  const visibleLayouts = layouts.filter((l) => counts.get(l.id) || l.id === search.layout);
  return (
    <>
      {!clientId && (
        <PageHeader
          eyebrow="All clients"
          title="Assets"
          description="Every documented device, service, and subscription you can access."
        />
      )}
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Asset layouts" className="flex gap-1 overflow-x-auto lg:flex-col">
          <button
            onClick={() => setLayout(undefined)}
            aria-current={!search.layout}
            className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-text-2 hover:bg-surface-3 aria-[current=true]:bg-primary-soft aria-[current=true]:font-semibold aria-[current=true]:text-primary"
          >
            All assets <span className="text-xs text-muted">{all.data?.length ?? ''}</span>
          </button>
          {visibleLayouts.map((l) => (
            <button
              key={l.id}
              onClick={() => setLayout(l.id)}
              aria-current={search.layout === l.id}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-text-2 hover:bg-surface-3 aria-[current=true]:bg-primary-soft aria-[current=true]:font-semibold aria-[current=true]:text-primary"
            >
              {l.name} <span className="text-xs text-muted">{counts.get(l.id) ?? 0}</span>
            </button>
          ))}
        </nav>
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">Filter assets</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, IP, serial…"
                className="pl-9"
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate({
                  to: '.',
                  search: (prev: Record<string, unknown>) => ({
                    ...prev,
                    archived: search.archived ? undefined : true,
                  }),
                })
              }
            >
              {search.archived ? <ArchiveRestore /> : <Archive />} {search.archived ? 'Show active' : 'Show archived'}
            </Button>
            {canEdit && (
              <Button onClick={() => setAdding(true)}>
                <Plus /> Add asset
              </Button>
            )}
          </div>
          {all.isLoading ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : rows.length ? (
            <AssetTable assets={rows} layout={layout} showClient={!clientId} />
          ) : (
            <EmptyState
              icon={Server}
              title={
                search.archived ? 'No archived assets' : query || search.layout ? 'Nothing matches' : 'No assets yet'
              }
              description={
                canEdit
                  ? 'Document firewalls, servers, circuits, domains, and more — each with the fields that matter.'
                  : clientId
                    ? 'Nothing has been documented here yet.'
                    : 'Open a client to add assets.'
              }
              action={
                canEdit && !search.archived ? (
                  <Button onClick={() => setAdding(true)}>
                    <Plus /> Add asset
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      </div>
      {adding && clientId && (
        <AssetDialog clientId={clientId} layoutId={search.layout} onClose={() => setAdding(false)} />
      )}
    </>
  );
}

export function ClientAssets() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  return <AssetsView clientId={clientId} />;
}
export function AllAssets() {
  return <AssetsView />;
}

// ---------------------------------------------------------------- detail
export function AssetDetail() {
  const { assetId } = useParams({ strict: false }) as { assetId: string };
  const { data: asset, isLoading, error, refetch } = useAsset(assetId);
  const layouts = useLayouts().data ?? [];
  const clients = useClients().data ?? [];
  const actor = useActor();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  if (isLoading) return <Skeleton className="h-64" />;
  if (error || !asset)
    return (
      <Card>
        <EmptyState
          icon={Server}
          title="Asset not found"
          description="It may have been removed, or you don't have access to it."
        />
      </Card>
    );
  const layout = layouts.find((l) => l.id === asset.layoutId);
  const access = clients.find((c) => c.id === asset.clientId)?.access ?? 'none';
  const canEdit = atLeast(access, 'edit') && !!actor;
  const archive = async () => {
    await api(`/assets/${asset.id}/archive`, { method: 'POST', body: { archived: !asset.archived } });
    await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: ['assets'] })]);
    toast(asset.archived ? 'Asset restored.' : 'Asset archived. You can restore it from the archived list.');
  };
  const known = new Set(layout?.fields.map((f) => f.key));
  return (
    <>
      <AppLink
        to={`/clients/${asset.clientId}/assets`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" /> {asset.clientName} · Assets
      </AppLink>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <ItemIcon type="asset" icon={asset.layoutIcon} className="size-12 rounded-xl [&_svg]:size-6" />
          <div className="min-w-0">
            <p className="text-xs font-bold tracking-[0.14em] text-muted uppercase">{asset.layoutName}</p>
            <h1 className="flex flex-wrap items-center gap-3 text-[26px] leading-tight font-semibold tracking-tight">
              {asset.name}
              <Badge tone={statusTone[asset.status]} className="capitalize">
                {asset.status}
              </Badge>
              {asset.archived && <Badge tone="warning">Archived</Badge>}
            </h1>
            <p className="mt-1 text-sm text-muted">
              Updated {relativeTime(asset.updatedAt)}
              {asset.updatedByName && ` by ${asset.updatedByName}`} · Version {asset.version}
            </p>
          </div>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={archive}>
              {asset.archived ? <ArchiveRestore /> : <Archive />} {asset.archived ? 'Restore' : 'Archive'}
            </Button>
            {!asset.archived && (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Details" />
            <dl className="grid gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-2">
              {layout?.fields.map((f) => (
                <div key={f.key} className={cn('min-w-0', f.type === 'textarea' && 'sm:col-span-2')}>
                  <dt className="text-xs font-medium text-muted">{f.label}</dt>
                  <dd className="mt-0.5 text-sm">
                    <FieldValue field={f} value={asset.fields[f.key]} />
                  </dd>
                </div>
              ))}
              {Object.keys(asset.fields)
                .filter((k) => !known.has(k))
                .map((k) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs font-medium text-muted">{k} (no longer in layout)</dt>
                    <dd className="mt-0.5 text-sm">{String(asset.fields[k])}</dd>
                  </div>
                ))}
            </dl>
          </Card>
          <Card>
            <CardHeader title="Notes" />
            <p className="px-5 py-4 text-sm leading-relaxed whitespace-pre-wrap text-text-2">
              {asset.notes || <span className="text-muted">No notes.</span>}
            </p>
          </Card>
          <ItemActivity id={asset.id} />
        </div>
        <div className="space-y-6">
          <RelatedPanel type="asset" id={asset.id} clientId={asset.clientId} canEdit={canEdit} />
          <AttachmentsPanel type="asset" id={asset.id} canEdit={canEdit} />
          <RevisionsPanel
            kind="assets"
            id={asset.id}
            currentVersion={asset.version}
            canEdit={canEdit && !asset.archived}
            onRestored={() => refetch()}
            toText={(s) => {
              const snap = s as { name: string; status: string; fields: Record<string, unknown>; notes: string };
              const lines = [`Name: ${snap.name}`, `Status: ${snap.status}`];
              for (const f of layout?.fields ?? [])
                if (snap.fields[f.key] !== undefined)
                  lines.push(
                    `${f.label}: ${Array.isArray(snap.fields[f.key]) ? (snap.fields[f.key] as string[]).join(', ') : String(snap.fields[f.key])}`,
                  );
              if (snap.notes) lines.push('', snap.notes);
              return lines.join('\n');
            }}
          />
        </div>
      </div>
      {editing && <AssetDialog clientId={asset.clientId} asset={asset} onClose={() => setEditing(false)} />}
    </>
  );
}
