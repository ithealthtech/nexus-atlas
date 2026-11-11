import { useState } from 'react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Archive, ArchiveRestore, Bookmark, Columns3, Plus, QrCode, Search, Server } from 'lucide-react';
import {
  ASSET_SORTS,
  ASSET_SORT_INFO,
  FIELD_FILTER_PREFIX,
  MAX_LIST_COLUMNS,
  REPORTABLE_FIELD_TYPES,
  activeFilterCount,
  assetFilter,
  atLeast,
  defaultDirection,
  filterAssets,
  parseAssetSearch,
  readAssetSort,
  sortAssets,
  type AssetListSearch,
  type AssetSort,
  type AssetView,
  type LayoutField,
  type LayoutView,
  type SortDirection,
} from '@atlas/shared';
import { Badge, Button, Card, Checkbox, Dialog, EmptyState, Input, PageHeader, Skeleton } from '@/components/ui';
import { FieldValue } from '@/components/fields';
import { ItemIcon } from '@/components/ItemIcon';
import { useAssets, useClient, useClients, useLayouts } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { useListView } from '@/lib/list-views';
import { AppLink } from '@/components/AppLink';
import {
  AssetFilterBar,
  SavedViewPicker,
  SavedViewsDialog,
  SortControl,
  SortHeader,
  type SearchChange,
} from '@/components/AssetFilters';

import { AssetDialog, statusTone } from '@/pages/assets';

/** Fields that fit a column: short values only, never long text. */
const columnFields = (layout: LayoutView) => layout.fields.filter((f) => REPORTABLE_FIELD_TYPES.includes(f.type));
/** The columns for one layout: the person's choice, or the layout's "show in list" fields. */
function layoutColumns(layout: LayoutView | undefined, chosen: string[] | undefined): LayoutField[] {
  if (!layout) return [];
  if (!chosen) return layout.fields.filter((f) => f.showInList).slice(0, 4);
  const fields = columnFields(layout);
  return chosen.flatMap((key) => fields.filter((f) => f.key === key)).slice(0, MAX_LIST_COLUMNS);
}

/** Choose which of a layout's fields show as columns, for this person. */
function ColumnsDialog({
  layout,
  chosen,
  onSave,
  onClose,
}: {
  layout: LayoutView;
  chosen: LayoutField[];
  onSave: (keys: string[] | undefined) => void;
  onClose: () => void;
}) {
  const [keys, setKeys] = useState(chosen.map((f) => f.key));
  const toggle = (key: string) =>
    setKeys((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${layout.name} columns`}
      description={`Choose up to ${MAX_LIST_COLUMNS}. Only you see this choice.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onSave(undefined)}>
            Use the layout's columns
          </Button>
          <Button onClick={() => onSave(keys)}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {columnFields(layout).map((f) => (
          <Checkbox
            key={f.key}
            label={f.label}
            checked={keys.includes(f.key)}
            disabled={!keys.includes(f.key) && keys.length >= MAX_LIST_COLUMNS}
            onChange={() => toggle(f.key)}
          />
        ))}
      </div>
    </Dialog>
  );
}

function AssetTable({
  assets,
  layout,
  columns,
  showClient,
  sort,
  dir,
  onSort,
}: {
  assets: AssetView[];
  layout?: LayoutView;
  columns: LayoutField[];
  showClient: boolean;
  sort: AssetSort;
  dir: SortDirection;
  onSort: (sort: AssetSort) => void;
}) {
  const heading = { sort, dir, onSort };
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="bg-surface-2 text-xs text-muted">
          <tr>
            <SortHeader label="Name" sortKey="name" {...heading} />
            {showClient && <SortHeader label="Client" sortKey="client" className="hidden sm:table-cell" {...heading} />}
            {columns.map((c) => (
              <SortHeader
                key={c.key}
                label={c.label}
                sortKey={`field:${c.key}`}
                className="hidden md:table-cell"
                {...heading}
              />
            ))}
            <SortHeader label="Status" sortKey="status" {...heading} />
            <SortHeader label="Updated" sortKey="updated" className="hidden sm:table-cell" {...heading} />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {assets.map((a) => (
            <tr key={a.id} className="hover:bg-surface-2">
              <td className="px-5 py-3">
                <AppLink to={`/assets/${a.id}`} className="flex items-center gap-3">
                  <ItemIcon type="asset" icon={a.layoutIcon} />
                  <span className="min-w-0">
                    <span className="block font-semibold whitespace-nowrap hover:underline">{a.name}</span>
                    {!layout && <span className="block text-xs text-muted">{a.layoutName}</span>}
                    {/* On a phone the client column gives way, so the client shows here. */}
                    {showClient && <span className="block text-xs text-muted sm:hidden">{a.clientName}</span>}
                  </span>
                </AppLink>
              </td>
              {showClient && (
                <td className="hidden px-5 py-3 whitespace-nowrap text-text-2 sm:table-cell">{a.clientName}</td>
              )}
              {columns.map((c) => (
                <td key={c.key} className="hidden max-w-56 truncate px-5 py-3 text-text-2 md:table-cell">
                  <FieldValue field={c} value={a.fields[c.key]} />
                </td>
              ))}
              <td className="px-5 py-3">
                <Badge tone={a.status === 'active' ? 'quiet' : statusTone[a.status]} className="capitalize">
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

/** Fields that can be filtered: the chosen layout's, or those of every listed layout, merged by key. */
function filterFields(layouts: LayoutView[]): LayoutField[] {
  const byKey = new Map<string, LayoutField>();
  for (const f of layouts.flatMap(columnFields)) {
    const seen = byKey.get(f.key);
    byKey.set(f.key, seen ? { ...seen, options: [...new Set([...seen.options, ...f.options])] } : f);
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function AssetsView({ clientId }: { clientId?: string }) {
  const search = parseAssetSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [choosingColumns, setChoosingColumns] = useState(false);
  const [savingView, setSavingView] = useState(false);
  const [view, saveView] = useListView('assets');
  const [sort, dir] = readAssetSort(view.sort, view.dir);
  const layouts = useLayouts().data ?? [];
  const client = useClient(clientId ?? '');
  const clients = useClients().data;
  const canEdit = clientId ? atLeast(client.data?.access ?? 'none', 'edit') : false;
  const all = useAssets({ client: clientId, archived: search.archived });
  const layout = layouts.find((l) => l.id === search.layout);
  const filter = assetFilter(search);
  // Inside a client, every asset is that client's, so a client filter from a saved view doesn't apply.
  if (clientId) filter.clients = [];
  const rows = sortAssets(filterAssets(all.data ?? [], filter, layouts), sort, dir);
  const columns = layoutColumns(layout, layout ? view.columns?.[layout.key] : undefined);
  const saveColumns = (keys: string[] | undefined) => {
    if (!layout) return;
    const rest = { ...view.columns };
    delete rest[layout.key];
    saveView({ columns: keys ? { ...rest, [layout.key]: keys } : rest });
    setChoosingColumns(false);
  };
  const changeSearch = (change: SearchChange) =>
    navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, ...change }),
      replace: true,
    });
  const counts = new Map<string, number>();
  for (const a of all.data ?? []) counts.set(a.layoutId, (counts.get(a.layoutId) ?? 0) + 1);
  const visibleLayouts = layouts.filter((l) => counts.get(l.id) || l.id === search.layout);
  const fields = filterFields(layout ? [layout] : visibleLayouts);
  const setLayout = (id?: string) => {
    // Field filters the new layout doesn't have would hide everything, so they go.
    const keep = new Set(filterFields(id ? layouts.filter((l) => l.id === id) : visibleLayouts).map((f) => f.key));
    const dropped = Object.keys(filter.fields).filter((key) => !keep.has(key));
    navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...Object.fromEntries(dropped.map((key) => [`${FIELD_FILTER_PREFIX}${key}`, undefined])),
        layout: id,
      }),
    });
  };
  const onSort = (next: AssetSort) =>
    saveView(
      next === sort ? { sort, dir: dir === 'asc' ? 'desc' : 'asc' } : { sort: next, dir: defaultDirection(next) },
    );
  const narrowed = activeFilterCount(filter) > 0;
  const clearFilters = () =>
    navigate({ to: '.', search: { layout: search.layout, archived: search.archived }, replace: true });
  const filtersOf = (s: AssetListSearch) =>
    Object.fromEntries(
      Object.entries(s).flatMap(([k, v]) =>
        v === undefined || (clientId && k === 'client') ? [] : [[k, String(v)] as const],
      ),
    );
  const savedViews = view.saved ?? [];
  const applyView = (name: string) => {
    const saved = savedViews.find((v) => v.name === name);
    if (!saved) return;
    const next = parseAssetSearch(saved.filters);
    if (clientId) delete next.client;
    navigate({ to: '.', search: next });
    if (saved.sort) saveView({ sort: saved.sort, dir: saved.dir });
  };
  const keepView = (name: string) => {
    const others = savedViews.filter((v) => v.name.toLowerCase() !== name.toLowerCase());
    saveView({ saved: [...others, { name, filters: filtersOf(search), sort, dir }] });
    setSavingView(false);
  };
  const sortOptions = ASSET_SORTS.filter((s) => s !== 'client' || !clientId).map(
    (s) => [s, ASSET_SORT_INFO[s].label] as const,
  );
  const fieldSort = sort.startsWith('field:') ? columns.find((c) => `field:${c.key}` === sort) : undefined;
  return (
    <>
      {!clientId && (
        <PageHeader
          eyebrow="All clients"
          title="Assets"
          description="Every documented device, service, and subscription you can access."
        />
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
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
                type="search"
                value={search.q ?? ''}
                onChange={(e) => changeSearch({ q: e.target.value || undefined })}
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
            <SortControl
              sort={sort}
              dir={dir}
              options={[...sortOptions, ...(fieldSort ? [[sort, fieldSort.label] as const] : [])]}
              onChange={(next, nextDir) => saveView({ sort: next, dir: nextDir })}
            />
            {layout && columnFields(layout).length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setChoosingColumns(true)}>
                <Columns3 /> Columns
              </Button>
            )}
            <SavedViewPicker views={savedViews} onApply={applyView} />
            <Button variant="ghost" size="sm" onClick={() => setSavingView(true)}>
              <Bookmark /> Save view
            </Button>
            {clientId && !search.archived && (
              <AppLink
                to="/assets/labels"
                search={{ client: clientId, layout: search.layout }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold text-text-2 hover:bg-surface-3 hover:text-text"
              >
                <QrCode className="size-4" aria-hidden /> QR labels
              </AppLink>
            )}
            {canEdit && (
              <Button onClick={() => setAdding(true)}>
                <Plus /> Add asset
              </Button>
            )}
          </div>
          <AssetFilterBar
            search={search}
            filter={filter}
            fields={fields}
            clients={clientId ? undefined : clients}
            onChange={changeSearch}
          />
          <div className="flex items-center justify-between gap-3 px-5 py-2 text-xs text-muted">
            <p aria-live="polite">
              {all.isLoading
                ? 'Loading assets…'
                : narrowed
                  ? `Showing ${rows.length} of ${all.data?.length ?? 0} assets`
                  : `${rows.length} ${rows.length === 1 ? 'asset' : 'assets'}`}
            </p>
            {narrowed && (
              <Button variant="link" size="sm" onClick={clearFilters}>
                Clear filters
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
            <AssetTable
              assets={rows}
              layout={layout}
              columns={columns}
              showClient={!clientId}
              sort={sort}
              dir={dir}
              onSort={onSort}
            />
          ) : (
            <EmptyState
              icon={Server}
              title={
                search.archived ? 'No archived assets' : narrowed || search.layout ? 'Nothing matches' : 'No assets yet'
              }
              description={
                narrowed
                  ? 'Try fewer filters, or clear them to see every asset.'
                  : canEdit
                    ? 'Document firewalls, servers, circuits, domains, and more — each with the fields that matter.'
                    : clientId
                      ? 'Nothing has been documented here yet.'
                      : 'Open a client to add assets.'
              }
              action={
                narrowed ? (
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : canEdit && !search.archived ? (
                  <Button onClick={() => setAdding(true)}>
                    <Plus /> Add asset
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      </div>
      {choosingColumns && layout && (
        <ColumnsDialog
          layout={layout}
          chosen={columns}
          onSave={saveColumns}
          onClose={() => setChoosingColumns(false)}
        />
      )}
      {savingView && (
        <SavedViewsDialog
          views={savedViews}
          onSave={keepView}
          onDelete={(name) => saveView({ saved: savedViews.filter((v) => v.name !== name) })}
          onClose={() => setSavingView(false)}
        />
      )}
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
