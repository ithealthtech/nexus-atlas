import { describe, expect, it } from 'vitest';
import {
  ANY_VALUE,
  NO_VALUE,
  activeFilterCount,
  assetFilter,
  filterAssets,
  parseAssetSearch,
  readAssetSort,
  sortAssets,
} from '../src/asset-list.js';
import type { AssetView, LayoutField } from '../src/docs.js';

const NOW = Date.parse('2030-06-01T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const field = (key: string, type: LayoutField['type'], options: string[] = []): LayoutField => ({
  key,
  label: key,
  type,
  options,
  required: false,
  help: '',
  showInList: false,
  expires: false,
});
const endpoints = {
  id: 'endpoints',
  fields: [
    field('operating_system', 'text'),
    field('role', 'select', ['Server', 'Workstation']),
    field('tags', 'multiselect', ['Critical', 'Lab']),
    field('managed', 'checkbox'),
    field('ram_gb', 'number'),
  ],
};
const domains = { id: 'domains', fields: [field('registrar', 'text')] };
let n = 0;
const asset = (over: Partial<AssetView>): AssetView => ({
  id: `a${++n}`,
  clientId: 'harbor',
  clientName: 'Harbor Dental',
  layoutId: 'endpoints',
  layoutName: 'Endpoints',
  layoutIcon: 'server',
  name: 'Asset',
  status: 'active',
  fields: {},
  notes: '',
  version: 1,
  archived: false,
  updatedAt: daysAgo(1),
  updatedByName: null,
  ...over,
});
const dc = asset({
  name: 'HD-DC01',
  fields: { operating_system: 'Windows Server 2022', role: 'Server', tags: ['Critical'], managed: true, ram_gb: 64 },
});
const front = asset({
  name: 'HD-FRONT-2',
  clientId: 'pine',
  clientName: 'Pine Legal',
  status: 'inactive',
  updatedAt: daysAgo(400),
  fields: { operating_system: 'Windows 11 Pro', role: 'Workstation', managed: false, ram_gb: 8 },
});
const mac = asset({ name: 'hd-front-10', fields: { operating_system: 'macOS 15' }, updatedAt: daysAgo(20) });
const domain = asset({
  name: 'harbordental.com',
  layoutId: 'domains',
  layoutName: 'Domains',
  fields: { registrar: 'Cloudflare' },
});
const all = [dc, front, mac, domain];
const layouts = [endpoints, domains];
const names = (search: Record<string, unknown>) =>
  filterAssets(all, assetFilter(parseAssetSearch(search)), layouts, NOW).map((a) => a.name);

describe('asset list search parameters', () => {
  it('keeps known filters, reads numbers and booleans back as text, and drops anything else', () => {
    expect(
      parseAssetSearch({
        layout: 'endpoints',
        archived: 'true',
        q: 2022,
        status: 'active,retired',
        updated: 'forever',
        'f.ram_gb': 64,
        'f.Bad-Key': 'x',
        'f.role': { nested: true },
        folder: 'abc',
      }),
    ).toEqual({ layout: 'endpoints', archived: true, q: '2022', status: 'active,retired', 'f.ram_gb': '64' });
  });

  it('counts the filters that narrow the list, not the layout or archive switch', () => {
    const filter = assetFilter(parseAssetSearch({ layout: 'x', archived: true, q: 'dc', status: 'active,bogus' }));
    expect(filter.statuses).toEqual(['active']);
    expect(activeFilterCount(filter)).toBe(2);
  });
});

describe('filtering assets', () => {
  it('matches every word of a search against name, client, layout and field values', () => {
    expect(names({ q: 'windows' })).toEqual(['HD-DC01', 'HD-FRONT-2']);
    expect(names({ q: 'windows pine' })).toEqual(['HD-FRONT-2']);
    expect(names({ q: 'cloudflare' })).toEqual(['harbordental.com']);
    expect(names({ q: 'domains' })).toEqual(['harbordental.com']);
    // Field keys are not values.
    expect(names({ q: 'operating_system' })).toEqual([]);
  });

  it('combines layout, client, status and updated filters', () => {
    expect(names({ layout: 'endpoints', status: 'active' })).toEqual(['HD-DC01', 'hd-front-10']);
    expect(names({ client: 'pine,elsewhere' })).toEqual(['HD-FRONT-2']);
    expect(names({ status: 'inactive,retired' })).toEqual(['HD-FRONT-2']);
    expect(names({ updated: '7d' })).toEqual(['HD-DC01', 'harbordental.com']);
    expect(names({ updated: '30d', layout: 'endpoints' })).toEqual(['HD-DC01', 'hd-front-10']);
    expect(names({ updated: 'stale' })).toEqual(['HD-FRONT-2']);
  });

  it('matches each field by its type', () => {
    expect(names({ 'f.operating_system': 'WINDOWS 11' })).toEqual(['HD-FRONT-2']);
    expect(names({ 'f.role': 'Server' })).toEqual(['HD-DC01']);
    expect(names({ 'f.role': 'Serv' })).toEqual([]);
    expect(names({ 'f.tags': 'Critical' })).toEqual(['HD-DC01']);
    expect(names({ 'f.managed': 'yes' })).toEqual(['HD-DC01']);
    // A box nobody ticked counts as "no"; the domain has no such field at all.
    expect(names({ 'f.managed': 'no' })).toEqual(['HD-FRONT-2', 'hd-front-10']);
    expect(names({ 'f.ram_gb': '64' })).toEqual(['HD-DC01']);
    expect(names({ 'f.role': 'Server', 'f.operating_system': 'mac' })).toEqual([]);
  });

  it('finds assets with or without a value, counting a missing field as no value', () => {
    expect(names({ 'f.role': NO_VALUE })).toEqual(['hd-front-10', 'harbordental.com']);
    expect(names({ 'f.role': ANY_VALUE })).toEqual(['HD-DC01', 'HD-FRONT-2']);
    expect(names({ 'f.tags': NO_VALUE, layout: 'endpoints' })).toEqual(['HD-FRONT-2', 'hd-front-10']);
    expect(names({ 'f.managed': ANY_VALUE })).toEqual(['HD-DC01', 'HD-FRONT-2']);
  });
});

describe('sorting assets', () => {
  const sorted = (sort: string, dir?: string) => sortAssets(all, ...readAssetSort(sort, dir)).map((a) => a.name);

  it('sorts names naturally and each column both ways', () => {
    expect(sorted('name')).toEqual(['harbordental.com', 'HD-DC01', 'HD-FRONT-2', 'hd-front-10']);
    expect(sorted('name', 'desc')).toEqual(['hd-front-10', 'HD-FRONT-2', 'HD-DC01', 'harbordental.com']);
    expect(sorted('client')).toEqual(['harbordental.com', 'HD-DC01', 'hd-front-10', 'HD-FRONT-2']);
    expect(sorted('layout')).toEqual(['harbordental.com', 'HD-DC01', 'HD-FRONT-2', 'hd-front-10']);
    expect(sorted('status', 'desc')[0]).toBe('HD-FRONT-2');
  });

  it('keeps "Recently updated" newest first unless reversed', () => {
    expect(readAssetSort('updated', undefined)).toEqual(['updated', 'desc']);
    expect(sorted('updated')).toEqual(['harbordental.com', 'HD-DC01', 'hd-front-10', 'HD-FRONT-2']);
    expect(sorted('updated', 'asc')[0]).toBe('HD-FRONT-2');
  });

  it('sorts field columns by value, numbers as numbers, with blanks last both ways', () => {
    expect(sorted('field:ram_gb')).toEqual(['HD-FRONT-2', 'HD-DC01', 'harbordental.com', 'hd-front-10']);
    expect(sorted('field:ram_gb', 'desc')).toEqual(['HD-DC01', 'HD-FRONT-2', 'harbordental.com', 'hd-front-10']);
    expect(sorted('field:operating_system')).toEqual(['hd-front-10', 'HD-FRONT-2', 'HD-DC01', 'harbordental.com']);
  });

  it('falls back to name for a sort this version does not know', () => {
    expect(readAssetSort('field:Bad Key', 'up')).toEqual(['name', 'asc']);
    expect(readAssetSort(undefined, undefined)).toEqual(['name', 'asc']);
  });
});
