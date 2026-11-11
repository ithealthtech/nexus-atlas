import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Trash2, X } from 'lucide-react';
import {
  ANY_VALUE,
  ASSET_STATUSES,
  FIELD_FILTER_PREFIX,
  FIELD_MATCH,
  MAX_SAVED_VIEWS,
  NO_VALUE,
  UPDATED_WINDOWS,
  UPDATED_WINDOW_INFO,
  defaultDirection,
  type AssetFilter,
  type AssetListSearch,
  type AssetSort,
  type AssetStatus,
  type LayoutField,
  type SavedListView,
  type SortDirection,
  type UpdatedWindow,
} from '@atlas/shared';
import { Button, Dialog, Field, FormError, Input, Select } from '@/components/ui';
import { cn } from '@/lib/cn';

export type SearchChange = Partial<Record<keyof AssetListSearch, string | true | undefined>>;
const fieldParam = (key: string) => `${FIELD_FILTER_PREFIX}${key}` as const;
const capital = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** One field's filter: a choice list for choice and yes/no fields, a "contains" box for the rest. */
function FieldFilter({
  field,
  value,
  onChange,
  onRemove,
}: {
  field: LayoutField;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  onRemove: () => void;
}) {
  const kind = FIELD_MATCH[field.type];
  const presence = value === ANY_VALUE || value === NO_VALUE;
  const [mode, setMode] = useState<'contains' | typeof ANY_VALUE | typeof NO_VALUE>(
    value === ANY_VALUE || value === NO_VALUE ? value : 'contains',
  );
  const options =
    kind === 'yesno'
      ? [
          ['yes', 'Yes'],
          ['no', 'No'],
        ]
      : field.options.map((o) => [o, o]);
  return (
    <div
      role="group"
      aria-label={`${field.label} filter`}
      className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 py-1 pr-1 pl-2.5"
    >
      <span className="text-xs font-semibold whitespace-nowrap text-text-2">{field.label}</span>
      {kind === 'contains' ? (
        <>
          <Select
            aria-label={`How to match ${field.label}`}
            value={mode}
            onChange={(e) => {
              const next = e.target.value as typeof mode;
              setMode(next);
              onChange(next === 'contains' ? undefined : next);
            }}
            className="h-7 w-auto text-xs"
          >
            <option value="contains">contains</option>
            <option value={ANY_VALUE}>has a value</option>
            <option value={NO_VALUE}>is blank</option>
          </Select>
          {mode === 'contains' && (
            <Input
              aria-label={`${field.label} contains`}
              value={presence ? '' : (value ?? '')}
              onChange={(e) => onChange(e.target.value || undefined)}
              className="h-7 w-36 text-xs"
              autoFocus={!value}
            />
          )}
        </>
      ) : (
        <Select
          aria-label={field.label}
          value={value ?? ANY_VALUE}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 w-auto max-w-48 text-xs"
        >
          <option value={ANY_VALUE}>has a value</option>
          <option value={NO_VALUE}>is blank</option>
          {options.map(([v, label]) => (
            <option key={v} value={v}>
              is {label}
            </option>
          ))}
        </Select>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={`Remove ${field.label} filter`}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}

/** The live filters under the Assets toolbar: client, status, last update, and any field. */
export function AssetFilterBar({
  search,
  filter,
  fields,
  clients,
  onChange,
}: {
  search: AssetListSearch;
  filter: AssetFilter;
  /** Fields that can be filtered: the chosen layout's, or every listed layout's. */
  fields: LayoutField[];
  /** Clients to choose from; left out inside a client. */
  clients?: { id: string; name: string }[];
  onChange: (change: SearchChange) => void;
}) {
  // Field filters just added, shown before they have a value.
  const [adding, setAdding] = useState<string[]>([]);
  const shown = fields.filter((f) => filter.fields[f.key] !== undefined || adding.includes(f.key));
  const addable = fields.filter((f) => !shown.includes(f));
  const toggleStatus = (status: AssetStatus) => {
    const next = filter.statuses.includes(status)
      ? filter.statuses.filter((s) => s !== status)
      : [...filter.statuses, status];
    onChange({ status: next.join(',') || undefined });
  };
  const removeField = (key: string) => {
    setAdding((list) => list.filter((k) => k !== key));
    onChange({ [fieldParam(key)]: undefined });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
      {clients && (
        <Select
          aria-label="Client"
          value={filter.clients.length === 1 ? filter.clients[0] : filter.clients.length ? 'several' : ''}
          onChange={(e) => onChange({ client: e.target.value || undefined })}
          className="h-8 w-auto max-w-56 text-[13px]"
        >
          <option value="">All clients</option>
          {filter.clients.length > 1 && (
            <option value="several" disabled>
              {filter.clients.length} clients
            </option>
          )}
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
      <div role="group" aria-label="Status" className="flex rounded-lg border border-border p-0.5">
        {ASSET_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter.statuses.includes(s)}
            onClick={() => toggleStatus(s)}
            className="rounded-md px-2.5 py-1 text-xs font-semibold text-text-2 hover:bg-surface-3 aria-pressed:bg-primary-soft aria-pressed:text-primary"
          >
            {capital(s)}
          </button>
        ))}
      </div>
      <Select
        aria-label="Last updated"
        value={search.updated ?? ''}
        onChange={(e) => onChange({ updated: (e.target.value as UpdatedWindow) || undefined })}
        className="h-8 w-auto text-[13px]"
      >
        <option value="">Updated any time</option>
        {UPDATED_WINDOWS.map((w) => (
          <option key={w} value={w}>
            {UPDATED_WINDOW_INFO[w].label}
          </option>
        ))}
      </Select>
      {shown.map((f) => (
        <FieldFilter
          key={f.key}
          field={f}
          value={filter.fields[f.key]}
          onChange={(value) => {
            // Keep the filter on screen while its box is empty.
            if (value === undefined) setAdding((list) => (list.includes(f.key) ? list : [...list, f.key]));
            onChange({ [fieldParam(f.key)]: value });
          }}
          onRemove={() => removeField(f.key)}
        />
      ))}
      {addable.length > 0 && (
        <Select
          aria-label="Filter by a field"
          value=""
          onChange={(e) => {
            const field = fields.find((f) => f.key === e.target.value);
            if (!field) return;
            if (FIELD_MATCH[field.type] === 'contains') setAdding((list) => [...list, field.key]);
            else onChange({ [fieldParam(field.key)]: ANY_VALUE });
          }}
          className="h-8 w-auto max-w-56 text-[13px]"
        >
          <option value="">+ Filter by field…</option>
          {addable.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

/** A column heading that sorts the list by that column, and reverses it on a second click. */
export function SortHeader({
  label,
  sortKey,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: AssetSort;
  sort: AssetSort;
  dir: SortDirection;
  onSort: (sort: AssetSort) => void;
  className?: string;
}) {
  const active = sort === sortKey;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={cn('px-5 py-3 font-medium', className)}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 rounded whitespace-nowrap hover:text-text',
          active && 'font-semibold text-text',
        )}
      >
        {label}
        <Icon className={cn('size-3.5', !active && 'opacity-60')} aria-hidden />
      </button>
    </th>
  );
}

/** The sort menu and a button that reverses the order. */
export function SortControl({
  sort,
  dir,
  options,
  onChange,
}: {
  sort: AssetSort;
  dir: SortDirection;
  options: readonly (readonly [AssetSort, string])[];
  onChange: (sort: AssetSort, dir: SortDirection) => void;
}) {
  return (
    <div className="flex w-full items-center gap-1 sm:w-auto">
      <label className="flex-1 sm:flex-none">
        <span className="sr-only">Sort</span>
        <Select
          value={sort}
          onChange={(e) => {
            const next = e.target.value as AssetSort;
            onChange(next, defaultDirection(next));
          }}
        >
          {options.map(([key, label]) => (
            <option key={key} value={key}>
              Sort: {label}
            </option>
          ))}
        </Select>
      </label>
      <Button
        variant="ghost"
        size="icon"
        aria-label={dir === 'asc' ? 'Ascending, reverse the order' : 'Descending, reverse the order'}
        onClick={() => onChange(sort, dir === 'asc' ? 'desc' : 'asc')}
      >
        {dir === 'asc' ? <ArrowUp /> : <ArrowDown />}
      </Button>
    </div>
  );
}

/** Opens one of the person's saved views. */
export function SavedViewPicker({ views, onApply }: { views: SavedListView[]; onApply: (name: string) => void }) {
  if (!views.length) return null;
  return (
    <label>
      <span className="sr-only">Saved views</span>
      <Select value="" onChange={(e) => onApply(e.target.value)} className="w-auto">
        <option value="">Saved views…</option>
        {views.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Save the current filters and sort under a name, and remove saved ones. */
export function SavedViewsDialog({
  views,
  onSave,
  onDelete,
  onClose,
}: {
  views: SavedListView[];
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const replacing = views.some((v) => v.name.toLowerCase() === name.trim().toLowerCase());
  const full = views.length >= MAX_SAVED_VIEWS && !replacing;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !full) onSave(name.trim());
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Saved views"
      description="Save these filters and this sort to come back to. Only you see your views."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button type="submit" form="saved-view-form" disabled={!name.trim() || full}>
            <Bookmark /> {replacing ? 'Replace view' : 'Save view'}
          </Button>
        </>
      }
    >
      <form id="saved-view-form" onSubmit={submit} className="space-y-4">
        <Field label="View name" help={replacing ? 'A view with this name will be replaced.' : undefined}>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus />}
        </Field>
        <FormError message={full ? `You can keep up to ${MAX_SAVED_VIEWS} views. Remove one first.` : null} />
      </form>
      {views.length > 0 && (
        <ul className="mt-5 divide-y divide-border rounded-lg border border-border">
          {views.map((v) => (
            <li key={v.name} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="truncate">{v.name}</span>
              <Button variant="ghost" size="icon" aria-label={`Remove ${v.name}`} onClick={() => onDelete(v.name)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
