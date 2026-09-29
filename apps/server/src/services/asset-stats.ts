import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  ASSET_KINDS,
  ASSET_OS,
  ASSET_OS_INFO,
  type AssetKind,
  type AssetKindCounts,
  type AssetOs,
  type AssetStatsAsset,
  type AssetStatsFilter,
  type AssetStatsReport,
  type AssetStatsSettings,
  type LayoutField,
} from '@atlas/shared';
import type { Scope } from './scope.js';
import type { SettingsService } from './settings.js';

const MAX_ASSETS = 500;

const TYPE_LABEL = /^(device |asset |equipment )?type$|^kind$|^category$/;
// Word boundaries keep "BIOS version" out.
const OS_LABEL = /operating system|^os$|\bos version\b/;

/** A layout's Type field (the built-in Configurations "Type", or one named like it), if any. */
export function typeField(fields: LayoutField[]): string | null {
  const f =
    fields.find((f) => f.key === 'type' && ['select', 'text'].includes(f.type)) ??
    fields.find((f) => ['select', 'text'].includes(f.type) && TYPE_LABEL.test(f.label.trim().toLowerCase()));
  return f?.key ?? null;
}

/** A layout's operating system field, if any. */
export function osField(fields: LayoutField[]): string | null {
  const f =
    fields.find((f) => f.key === 'operating_system') ??
    fields.find((f) => ['select', 'text'].includes(f.type) && OS_LABEL.test(f.label.trim().toLowerCase()));
  return f?.key ?? null;
}

/** Which operating system family a recorded OS name belongs to. */
export function osFamily(name: string): AssetOs {
  const s = name.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return 'unknown';
  if (/server|\bsbs\b|small business/.test(s) && /windows|microsoft|\bsbs\b|small business|^server/.test(s)) {
    if (/2025/.test(s)) return 'server-2025';
    if (/2022/.test(s)) return 'server-2022';
    if (/2019/.test(s)) return 'server-2019';
    if (/2016/.test(s)) return 'server-2016';
    if (/2012|2008|2003|2000|\bsbs\b|small business/.test(s)) return 'server-old';
    return 'other';
  }
  if (/windows ?11|\bwin ?11\b/.test(s)) return 'windows-11';
  if (/windows ?10|\bwin ?10\b/.test(s)) return 'windows-10';
  if (/windows ?(8|7|vista|xp)|\bwin ?(8|7)\b/.test(s)) return 'windows-old';
  if (/mac ?os|os ?x\b|darwin/.test(s)) return 'macos';
  if (/linux|ubuntu|debian|centos|red ?hat|rhel|fedora|suse|rocky|alma/.test(s)) return 'linux';
  return 'other';
}

/**
 * What kind of device a Type value (or a layout's name) describes, falling back to the operating system when the
 * type says nothing: a server OS is a server, a desktop OS a workstation.
 */
export function kindOf(type: string, os = ''): AssetKind {
  const t = type.toLowerCase();
  const serverOs = /server/i.test(os);
  if (/virtual|\bvm\b/.test(t)) return serverOs ? 'server' : 'workstation';
  if (/server|hypervisor|storage|\bnas\b|\bsan\b/.test(t)) return 'server';
  if (/laptop|notebook|desktop|workstation|\bpc\b|computer|tablet/.test(t)) return 'workstation';
  if (/switch/.test(t)) return 'switch';
  if (/firewall|router|access ?point|\bap\b|network device|wireless controller|gateway/.test(t)) return 'network';
  if (/printer|copier|\bmfp\b|multifunction|scanner/.test(t)) return 'printer';
  if (/phone|voip|handset/.test(t)) return 'phone';
  if (serverOs) return 'server';
  if (/windows|mac ?os|os ?x\b/i.test(os)) return 'workstation';
  return 'other';
}

type LayoutRule =
  | { id: string; kind: AssetKind; typeKey: null; osKey: string | null }
  | { id: string; kind: null; typeKey: string | null; osKey: string | null };

/**
 * How each layout's assets are counted. An administrator's choice wins; otherwise a layout with a Type field is
 * read asset by asset, a layout named for one kind of device (Printers, Phones) counts as that kind, and a layout
 * with only an operating system field is read from it. Anything else is not a device and isn't counted.
 */
export function layoutRules(
  layouts: { id: string; key: string; name: string; fields: LayoutField[] }[],
  settings: AssetStatsSettings,
): LayoutRule[] {
  const out: LayoutRule[] = [];
  for (const l of layouts) {
    const chosen = settings.layouts[l.id] ?? 'auto';
    if (chosen === 'none') continue;
    const osKey = osField(l.fields);
    if (chosen !== 'auto') {
      out.push({ id: l.id, kind: chosen, typeKey: null, osKey });
      continue;
    }
    const typeKey = typeField(l.fields);
    if (typeKey) {
      out.push({ id: l.id, kind: null, typeKey, osKey });
      continue;
    }
    // The built-in Networks layout holds subnets, not devices.
    const named = l.key === 'network' ? 'other' : kindOf(l.name);
    if (named !== 'other') out.push({ id: l.id, kind: named, typeKey: null, osKey });
    else if (osKey) out.push({ id: l.id, kind: null, typeKey: null, osKey });
  }
  return out;
}

const emptyKinds = (): AssetKindCounts => ({
  total: 0,
  ...(Object.fromEntries(ASSET_KINDS.map((k) => [k, 0])) as Record<AssetKind, number>),
});
const emptyOs = () => Object.fromEntries(ASSET_OS.map((o) => [o, 0])) as Record<AssetOs, number>;

type Row = Omit<AssetStatsAsset, 'assetId'> & { id: string };

/** Device counts by kind and operating system, for the clients the actor can read. Archived assets are left out. */
export class AssetStatsService {
  constructor(private readonly settings: SettingsService) {}

  private async rows(scope: Scope, clientId?: string): Promise<Row[]> {
    const readable = await scope.readableClientIds();
    const ids = clientId ? readable.filter((id) => id === clientId) : readable;
    if (!ids.length) return [];
    const layouts = await scope.db
      .select({
        id: schema.assetLayouts.id,
        key: schema.assetLayouts.key,
        name: schema.assetLayouts.name,
        fields: schema.assetLayouts.fields,
      })
      .from(schema.assetLayouts)
      .where(eq(schema.assetLayouts.orgId, scope.actor.orgId));
    const rules = new Map(
      layoutRules(
        layouts.map((l) => ({ ...l, fields: l.fields as LayoutField[] })),
        await this.settings.assetStats(scope.actor.orgId),
      ).map((r) => [r.id, r]),
    );
    if (!rules.size) return [];
    // Only each layout's Type and operating system values are read, in the database, so asset fields aren't loaded.
    const pick = (key: 'typeKey' | 'osKey'): SQL<string | null> => {
      const whens = [...rules.values()].flatMap((r) =>
        r[key] ? [sql`when ${schema.assets.layoutId} = ${r.id} then ${schema.assets.fields} ->> ${r[key]}`] : [],
      );
      return whens.length ? sql<string | null>`case ${sql.join(whens, sql` `)} end` : sql<null>`null`;
    };
    const rows = await scope.db
      .select({
        id: schema.assets.id,
        name: schema.assets.name,
        layoutId: schema.assets.layoutId,
        type: pick('typeKey'),
        os: pick('osKey'),
        clientId: schema.assets.clientId,
        clientName: schema.clients.name,
        layoutName: schema.assetLayouts.name,
      })
      .from(schema.assets)
      .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
      .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
      .where(
        and(
          eq(schema.assets.orgId, scope.actor.orgId),
          eq(schema.assets.archived, false),
          inArray(schema.assets.clientId, ids),
          inArray(schema.assets.layoutId, [...rules.keys()]),
        ),
      );
    return rows.map(({ type, os, layoutId, ...r }) => {
      const rule = rules.get(layoutId)!;
      const osName = (os ?? '').trim();
      const kind = rule.kind ?? kindOf((type ?? '').trim(), osName);
      return { ...r, kind, os: osFamily(osName), osName };
    });
  }

  async report(scope: Scope, opts: { clientId?: string } = {}): Promise<AssetStatsReport> {
    const totals = emptyKinds();
    const os = emptyOs();
    const byClient = new Map<string, AssetStatsReport['clients'][number]>();
    for (const r of await this.rows(scope, opts.clientId)) {
      totals.total++;
      totals[r.kind]++;
      os[r.os]++;
      let entry = byClient.get(r.clientId);
      if (!entry)
        byClient.set(
          r.clientId,
          (entry = { clientId: r.clientId, clientName: r.clientName, counts: emptyKinds(), endOfSupport: 0 }),
        );
      entry.counts.total++;
      entry.counts[r.kind]++;
      if (ASSET_OS_INFO[r.os].endOfSupport) entry.endOfSupport++;
    }
    const clients = [...byClient.values()].sort(
      (a, b) => b.counts.total - a.counts.total || a.clientName.localeCompare(b.clientName),
    );
    return { totals, os, clients };
  }

  /** The devices behind a tile or a chart slice, by client and name. */
  async assets(scope: Scope, filter: AssetStatsFilter, opts: { clientId?: string } = {}): Promise<AssetStatsAsset[]> {
    const [what, value] = filter.split(':');
    const match = (r: Row) =>
      what === 'eos' ? ASSET_OS_INFO[r.os].endOfSupport : what === 'kind' ? r.kind === value : r.os === value;
    return (await this.rows(scope, opts.clientId))
      .filter(match)
      .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name))
      .slice(0, MAX_ASSETS)
      .map(({ id, ...r }) => ({ assetId: id, ...r }));
  }
}
