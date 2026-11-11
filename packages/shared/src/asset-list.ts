import { ASSET_STATUSES, type AssetStatus, type AssetView, type FieldType, type LayoutField } from './docs.js';

// Filtering and sorting for the Assets list. The list loads every asset the person can see, so filters apply in
// the browser as they type. The filters live in the page address, so a filtered list can be bookmarked, shared, or
// saved as a named view.

/** A field filter's search parameter: `f.<field key>`. */
export const FIELD_FILTER_PREFIX = 'f.';
/** Field filter values that test for a missing or present value rather than a match. */
export const NO_VALUE = '(none)';
export const ANY_VALUE = '(any)';

export const UPDATED_WINDOWS = ['7d', '30d', '90d', 'stale'] as const;
export type UpdatedWindow = (typeof UPDATED_WINDOWS)[number];
const DAY = 86_400_000;
export const UPDATED_WINDOW_INFO: Record<UpdatedWindow, { label: string; test: (age: number) => boolean }> = {
  '7d': { label: 'Updated in the last 7 days', test: (age) => age <= 7 * DAY },
  '30d': { label: 'Updated in the last 30 days', test: (age) => age <= 30 * DAY },
  '90d': { label: 'Updated in the last 90 days', test: (age) => age <= 90 * DAY },
  stale: { label: 'Not updated in a year', test: (age) => age > 365 * DAY },
};

/** How a field's filter matches, by the field's type. */
export type FieldMatch = 'contains' | 'choice' | 'choices' | 'yesno';
export const FIELD_MATCH: Record<FieldType, FieldMatch> = {
  text: 'contains',
  textarea: 'contains',
  number: 'contains',
  date: 'contains',
  select: 'choice',
  multiselect: 'choices',
  checkbox: 'yesno',
  url: 'contains',
  email: 'contains',
  phone: 'contains',
  ip: 'contains',
};

/** The Assets list's address: the layout and archive switch it always had, plus the live filters. */
export type AssetListSearch = {
  layout?: string;
  archived?: true;
  q?: string;
  /** Client IDs, comma-separated. */
  client?: string;
  /** Statuses, comma-separated. */
  status?: string;
  updated?: UpdatedWindow;
} & { [field: `${typeof FIELD_FILTER_PREFIX}${string}`]: string | undefined };

/** The search parameters that make up a filter, which a saved view stores. */
export const ASSET_FILTER_PARAMS = ['layout', 'archived', 'q', 'client', 'status', 'updated'] as const;

// The router reads `?f.size=10` as the number 10 and `?q=true` as a boolean, so scalars are read back as text.
const text = (value: unknown, max = 400) =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value).slice(0, max) || undefined
    : undefined;

/** Reads the Assets list's search parameters, dropping anything unknown or malformed. */
export function parseAssetSearch(raw: Record<string, unknown>): AssetListSearch {
  const search: AssetListSearch = {};
  const layout = text(raw.layout, 60);
  if (layout) search.layout = layout;
  if (raw.archived === true || raw.archived === 'true') search.archived = true;
  const q = text(raw.q);
  if (q) search.q = q;
  const client = text(raw.client, 2000);
  if (client) search.client = client;
  const status = text(raw.status, 60);
  if (status) search.status = status;
  const updated = text(raw.updated, 10);
  if (updated && (UPDATED_WINDOWS as readonly string[]).includes(updated)) search.updated = updated as UpdatedWindow;
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith(FIELD_FILTER_PREFIX) || !/^[a-z][a-z0-9_]{0,39}$/.test(key.slice(2))) continue;
    const v = text(value);
    if (v) search[`${FIELD_FILTER_PREFIX}${key.slice(2)}`] = v;
  }
  return search;
}

/** A filter read from the address. */
export interface AssetFilter {
  layout?: string;
  words: string[];
  clients: string[];
  statuses: AssetStatus[];
  updated?: UpdatedWindow;
  /** Field key to the value it must match. */
  fields: Record<string, string>;
}

const list = (value: string | undefined) => (value ?? '').split(',').filter(Boolean);
export function assetFilter(search: AssetListSearch): AssetFilter {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(search))
    if (key.startsWith(FIELD_FILTER_PREFIX) && typeof value === 'string') fields[key.slice(2)] = value;
  return {
    layout: search.layout,
    words: (search.q ?? '').toLowerCase().split(/\s+/).filter(Boolean),
    clients: list(search.client),
    statuses: list(search.status).filter((s): s is AssetStatus => (ASSET_STATUSES as readonly string[]).includes(s)),
    updated: search.updated,
    fields,
  };
}

/** How many filters are narrowing the list, not counting the layout and the archive switch. */
export const activeFilterCount = (f: AssetFilter) =>
  (f.words.length ? 1 : 0) +
  (f.clients.length ? 1 : 0) +
  (f.statuses.length ? 1 : 0) +
  (f.updated ? 1 : 0) +
  Object.keys(f.fields).length;

const isBlank = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
const valueText = (value: unknown) =>
  Array.isArray(value) ? value.map(String).join(' ') : isBlank(value) ? '' : String(value);

const FIELD_MATCHERS: Record<FieldMatch, (value: unknown, wanted: string) => boolean> = {
  contains: (value, wanted) => valueText(value).toLowerCase().includes(wanted.toLowerCase()),
  choice: (value, wanted) => String(value) === wanted,
  choices: (value, wanted) => Array.isArray(value) && value.map(String).includes(wanted),
  yesno: (value, wanted) => (wanted === 'yes') === (value === true),
};

/** Whether one field value passes its filter. A field the asset's layout lacks counts as having no value. */
export function fieldMatches(field: LayoutField | undefined, value: unknown, wanted: string): boolean {
  const blank = !field || (field.type === 'checkbox' ? value !== true && value !== false : isBlank(value));
  if (wanted === NO_VALUE) return blank;
  if (wanted === ANY_VALUE) return !blank;
  if (!field) return false;
  // An unticked box is a real "no", but a box nobody ever set is treated the same way.
  if (blank && FIELD_MATCH[field.type] !== 'yesno') return false;
  return FIELD_MATCHERS[FIELD_MATCH[field.type]](value, wanted);
}

/** The words a search looks through: name, client, layout, status, and every field value. */
const haystack = (a: AssetView) =>
  [a.name, a.clientName, a.layoutName, a.status, ...Object.values(a.fields).map(valueText)].join('\n').toLowerCase();

export function filterAssets(
  assets: AssetView[],
  filter: AssetFilter,
  layouts: { id: string; fields: LayoutField[] }[],
  now: number = Date.now(),
): AssetView[] {
  const fieldsOf = new Map(layouts.map((l) => [l.id, new Map(l.fields.map((f) => [f.key, f]))]));
  const wanted = Object.entries(filter.fields);
  const window = filter.updated ? UPDATED_WINDOW_INFO[filter.updated].test : undefined;
  return assets.filter((a) => {
    if (filter.layout && a.layoutId !== filter.layout) return false;
    if (filter.clients.length && !filter.clients.includes(a.clientId)) return false;
    if (filter.statuses.length && !filter.statuses.includes(a.status)) return false;
    if (window && !window(now - Date.parse(a.updatedAt))) return false;
    const fields = fieldsOf.get(a.layoutId);
    if (wanted.some(([key, value]) => !fieldMatches(fields?.get(key), a.fields[key], value))) return false;
    if (filter.words.length) {
      const words = haystack(a);
      if (!filter.words.every((w) => words.includes(w))) return false;
    }
    return true;
  });
}

// ---------- sorting ----------
export const ASSET_SORTS = ['name', 'client', 'layout', 'status', 'updated'] as const;
export type AssetBaseSort = (typeof ASSET_SORTS)[number];
/** A built-in sort, or `field:<key>` for one of a layout's columns. */
export type AssetSort = AssetBaseSort | `field:${string}`;
export type SortDirection = 'asc' | 'desc';

export const ASSET_SORT_INFO: Record<AssetBaseSort, { label: string; dir: SortDirection }> = {
  name: { label: 'Name', dir: 'asc' },
  client: { label: 'Client', dir: 'asc' },
  layout: { label: 'Layout', dir: 'asc' },
  status: { label: 'Status', dir: 'asc' },
  // Newest first, as "Recently updated" always sorted.
  updated: { label: 'Recently updated', dir: 'desc' },
};

const collate = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const BASE_COMPARE: Record<AssetBaseSort, (a: AssetView, b: AssetView) => number> = {
  name: (a, b) => collate(a.name, b.name),
  client: (a, b) => collate(a.clientName, b.clientName),
  layout: (a, b) => collate(a.layoutName, b.layoutName),
  status: (a, b) => ASSET_STATUSES.indexOf(a.status) - ASSET_STATUSES.indexOf(b.status),
  updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
};

/** Reads a saved sort, falling back to name for anything this version doesn't know. */
export function readAssetSort(sort: string | undefined, dir: string | undefined): [AssetSort, SortDirection] {
  const key: AssetSort =
    sort && ((ASSET_SORTS as readonly string[]).includes(sort) || /^field:[a-z][a-z0-9_]{0,39}$/.test(sort))
      ? (sort as AssetSort)
      : 'name';
  return [key, dir === 'asc' || dir === 'desc' ? dir : defaultDirection(key)];
}
export const defaultDirection = (sort: AssetSort): SortDirection =>
  sort.startsWith('field:') ? 'asc' : ASSET_SORT_INFO[sort as AssetBaseSort].dir;

/** Sorts by one column. Assets with no value in a field column go last either way; ties sort by name. */
export function sortAssets(assets: AssetView[], sort: AssetSort, dir: SortDirection): AssetView[] {
  const flip = dir === 'desc' ? -1 : 1;
  const byName = BASE_COMPARE.name;
  if (!sort.startsWith('field:')) {
    const compare = BASE_COMPARE[sort as AssetBaseSort];
    return [...assets].sort((a, b) => flip * compare(a, b) || byName(a, b));
  }
  const key = sort.slice('field:'.length);
  const value = (a: AssetView) => a.fields[key];
  return [...assets].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (isBlank(x) || isBlank(y)) return (isBlank(x) ? 1 : 0) - (isBlank(y) ? 1 : 0) || byName(a, b);
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : collate(valueText(x), valueText(y));
    return flip * order || byName(a, b);
  });
}
