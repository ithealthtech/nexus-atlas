import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { LayoutField, WarrantyAsset, WarrantyCounts, WarrantyFilter, WarrantyReport } from '@atlas/shared';
import type { Scope } from './scope.js';
import type { SettingsService } from './settings.js';

const DAY = 86_400_000;
const MAX_ASSETS = 500;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * A layout's warranty date fields: date fields whose key or label mentions a warranty, the ones about when it ends
 * first. The built-in Configurations layout has "Warranty expires"; imported layouts name it their own way.
 */
export function warrantyFields(fields: LayoutField[]): string[] {
  return fields
    .filter((f) => f.type === 'date' && /warrant/i.test(`${f.key} ${f.label}`))
    .sort((a, b) => Number(/expir|end|until/i.test(b.label)) - Number(/expir|end|until/i.test(a.label)))
    .map((f) => f.key);
}

export const emptyWarranty = (): WarrantyCounts => ({ total: 0, expired: 0, soon: 0, active: 0, unknown: 0 });

export function soonDaysOf(value: unknown, fallback: number) {
  const n = Math.round(Number(value));
  return n > 0 ? Math.min(n, 365) : fallback;
}

type Row = { id: string; name: string; clientId: string; clientName: string; layoutName: string; date: string | null };

/** Where an asset's warranty falls: expired, expiring within soonDays, active, or unknown (no date). */
export function standing(
  date: string | null,
  soonDays: number,
  today = new Date().toISOString().slice(0, 10),
): WarrantyFilter {
  if (!isDate(date)) return 'unknown';
  if (date < today) return 'expired';
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + soonDays * DAY).toISOString().slice(0, 10);
  return date <= soon ? 'soon' : 'active';
}

/** Warranty standing of hardware assets (those whose layout has a warranty date field) in the clients the actor can read. */
export class WarrantyService {
  constructor(private readonly settings: SettingsService) {}

  private async rows(scope: Scope, clientId?: string): Promise<Row[]> {
    const readable = await scope.readableClientIds();
    const ids = clientId ? readable.filter((id) => id === clientId) : readable;
    if (!ids.length) return [];
    const layouts = (
      await scope.db
        .select({ id: schema.assetLayouts.id, fields: schema.assetLayouts.fields })
        .from(schema.assetLayouts)
        .where(eq(schema.assetLayouts.orgId, scope.actor.orgId))
    )
      .map((l) => ({ id: l.id, keys: warrantyFields(l.fields as LayoutField[]) }))
      .filter((l) => l.keys.length);
    if (!layouts.length) return [];
    // The first of a layout's warranty fields that holds a value, read in the database so asset fields aren't loaded.
    const whens: SQL[] = layouts.map(
      (l) =>
        sql`when ${schema.assets.layoutId} = ${l.id} then coalesce(${sql.join(
          l.keys.map((k) => sql`nullif(${schema.assets.fields} ->> ${k}, '')`),
          sql`, `,
        )})`,
    );
    const rows = await scope.db
      .select({
        id: schema.assets.id,
        name: schema.assets.name,
        clientId: schema.assets.clientId,
        clientName: schema.clients.name,
        layoutName: schema.assetLayouts.name,
        date: sql<string | null>`case ${sql.join(whens, sql` `)} end`,
      })
      .from(schema.assets)
      .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
      .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
      .where(
        and(
          eq(schema.assets.orgId, scope.actor.orgId),
          eq(schema.assets.archived, false),
          inArray(schema.assets.clientId, ids),
          inArray(
            schema.assets.layoutId,
            layouts.map((l) => l.id),
          ),
        ),
      );
    return rows.map((r) => ({ ...r, date: isDate(r.date) ? r.date : null }));
  }

  private async soonDays(orgId: string, requested: unknown) {
    return soonDaysOf(requested, (await this.settings.warranty(orgId)).soonDays);
  }

  async report(scope: Scope, opts: { clientId?: string; soonDays?: unknown } = {}): Promise<WarrantyReport> {
    const soonDays = await this.soonDays(scope.actor.orgId, opts.soonDays);
    const totals = emptyWarranty();
    const byClient = new Map<string, { clientId: string; clientName: string; counts: WarrantyCounts }>();
    for (const r of await this.rows(scope, opts.clientId)) {
      const s = standing(r.date, soonDays);
      totals.total++;
      totals[s]++;
      let entry = byClient.get(r.clientId);
      if (!entry)
        byClient.set(r.clientId, (entry = { clientId: r.clientId, clientName: r.clientName, counts: emptyWarranty() }));
      entry.counts.total++;
      entry.counts[s]++;
    }
    const attention = (c: WarrantyCounts) => (c.expired + c.unknown) / c.total;
    const clients = [...byClient.values()].sort(
      (a, b) => attention(b.counts) - attention(a.counts) || a.clientName.localeCompare(b.clientName),
    );
    return { soonDays, totals, clients };
  }

  /** The assets behind one slice: dated ones soonest first, undated ones by name. */
  async assets(
    scope: Scope,
    filter: WarrantyFilter,
    opts: { clientId?: string; soonDays?: unknown } = {},
  ): Promise<WarrantyAsset[]> {
    const soonDays = await this.soonDays(scope.actor.orgId, opts.soonDays);
    const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    return (await this.rows(scope, opts.clientId))
      .filter((r) => standing(r.date, soonDays) === filter)
      .sort(
        (a, b) =>
          (a.date ?? '').localeCompare(b.date ?? '') ||
          a.clientName.localeCompare(b.clientName) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, MAX_ASSETS)
      .map((r) => ({
        assetId: r.id,
        name: r.name,
        clientId: r.clientId,
        clientName: r.clientName,
        layoutName: r.layoutName,
        warrantyExpires: r.date,
        daysLeft: r.date ? Math.round((Date.parse(`${r.date}T00:00:00Z`) - today) / DAY) : null,
      }));
  }
}
