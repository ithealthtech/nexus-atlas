import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  RMM_STALE_DAYS,
  type RmmDeviceKind,
  type RmmHealthCounts,
  type RmmHealthDevice,
  type RmmHealthFilter,
  type RmmHealthReport,
  type RmmProtection,
} from '@atlas/shared';
import type { Scope } from './scope.js';

const DAY = 86_400_000;
const MAX_DEVICES = 500;

type Row = RmmHealthDevice & { lastSeen: Date | null; updatedAt: Date };

export const emptyCounts = (): RmmHealthCounts => ({
  total: 0,
  servers: 0,
  workstations: 0,
  online: 0,
  offline: 0,
  onlineUnknown: 0,
  offlineServers: 0,
  current: 0,
  stale: 0,
  veryStale: 0,
  seenUnknown: 0,
  protectionRunning: 0,
  protectionNotRunning: 0,
  protectionMissing: 0,
  protectionUnknown: 0,
});

type Freshness = 'current' | 'stale' | 'veryStale' | 'seenUnknown';
function freshness(lastSeen: Date | null, staleDays: number, veryStaleDays: number, now: number): Freshness {
  if (!lastSeen) return 'seenUnknown';
  const age = now - lastSeen.getTime();
  if (age >= veryStaleDays * DAY) return 'veryStale';
  if (age >= staleDays * DAY) return 'stale';
  return 'current';
}

function add(c: RmmHealthCounts, r: Row, fresh: Freshness) {
  c.total++;
  if (r.kind === 'server') c.servers++;
  if (r.kind === 'workstation') c.workstations++;
  if (r.online === true) c.online++;
  else if (r.online === false) {
    c.offline++;
    if (r.kind === 'server') c.offlineServers++;
  } else c.onlineUnknown++;
  c[fresh]++;
  if (r.protection === 'running') c.protectionRunning++;
  else if (r.protection === 'not_running') c.protectionNotRunning++;
  else if (r.protection === 'missing') c.protectionMissing++;
  else c.protectionUnknown++;
}

/** Share of devices with a problem: offline, very stale, or unprotected. Sorts clients worst first. */
const trouble = (c: RmmHealthCounts) =>
  c.total ? (c.offline + c.veryStale + c.protectionMissing + c.protectionNotRunning) / c.total : 0;

/** Clamps stale thresholds: 1–365 days, very stale after stale. */
export function thresholds(stale?: unknown, veryStale?: unknown) {
  const days = (v: unknown, fallback: number) => {
    const n = Math.round(Number(v));
    return n > 0 ? n : fallback;
  };
  const s = Math.min(days(stale, RMM_STALE_DAYS.stale), 365);
  const v = Math.min(Math.max(days(veryStale, RMM_STALE_DAYS.veryStale), s + 1), 730);
  return { staleDays: s, veryStaleDays: v };
}

/**
 * Health of the devices RMM syncs report, for the clients the actor can read. Archived assets are left out, so a
 * device the RMM stopped reporting (or one merged away) never counts.
 */
export class RmmHealthService {
  private async rows(scope: Scope, clientId?: string): Promise<Row[]> {
    const readable = await scope.readableClientIds();
    const ids = clientId ? readable.filter((id) => id === clientId) : readable;
    if (!ids.length) return [];
    const s = schema.rmmDeviceStatus;
    const rows = await scope.db
      .select({
        assetId: s.assetId,
        clientId: s.clientId,
        clientName: schema.clients.name,
        name: schema.assets.name,
        kind: s.kind,
        online: s.online,
        lastSeen: s.lastSeenAt,
        protection: s.protection,
        protectionProduct: s.protectionProduct,
        updatedAt: s.updatedAt,
      })
      .from(s)
      .innerJoin(schema.assets, eq(schema.assets.id, s.assetId))
      .innerJoin(schema.clients, eq(schema.clients.id, s.clientId))
      .where(
        and(
          eq(s.orgId, scope.actor.orgId),
          inArray(s.clientId, ids),
          // The device's asset must still be in the client the status names.
          eq(schema.assets.clientId, s.clientId),
          eq(schema.assets.archived, false),
        ),
      );
    return rows.map((r) => ({
      ...r,
      kind: r.kind as RmmDeviceKind,
      protection: r.protection as RmmProtection | null,
      lastSeenAt: r.lastSeen?.toISOString() ?? null,
    }));
  }

  async report(
    scope: Scope,
    opts: { clientId?: string; stale?: unknown; veryStale?: unknown } = {},
  ): Promise<RmmHealthReport> {
    const { staleDays, veryStaleDays } = thresholds(opts.stale, opts.veryStale);
    const now = Date.now();
    const totals = emptyCounts();
    const byClient = new Map<string, { clientId: string; clientName: string; counts: RmmHealthCounts }>();
    let updatedAt: Date | null = null;
    for (const r of await this.rows(scope, opts.clientId)) {
      const fresh = freshness(r.lastSeen, staleDays, veryStaleDays, now);
      add(totals, r, fresh);
      let entry = byClient.get(r.clientId);
      if (!entry)
        byClient.set(r.clientId, (entry = { clientId: r.clientId, clientName: r.clientName, counts: emptyCounts() }));
      add(entry.counts, r, fresh);
      if (!updatedAt || r.updatedAt > updatedAt) updatedAt = r.updatedAt;
    }
    const clients = [...byClient.values()].sort(
      (a, b) => trouble(b.counts) - trouble(a.counts) || a.clientName.localeCompare(b.clientName),
    );
    return { staleDays, veryStaleDays, updatedAt: updatedAt?.toISOString() ?? null, totals, clients };
  }

  /** The devices behind one chart slice, most overdue check-in first. */
  async devices(
    scope: Scope,
    filter: RmmHealthFilter,
    opts: { clientId?: string; stale?: unknown; veryStale?: unknown } = {},
  ): Promise<RmmHealthDevice[]> {
    const { staleDays, veryStaleDays } = thresholds(opts.stale, opts.veryStale);
    const now = Date.now();
    const match: Record<RmmHealthFilter, (r: Row) => boolean> = {
      offline: (r) => r.online === false,
      online_unknown: (r) => r.online === null,
      stale: (r) => freshness(r.lastSeen, staleDays, veryStaleDays, now) === 'stale',
      very_stale: (r) => freshness(r.lastSeen, staleDays, veryStaleDays, now) === 'veryStale',
      seen_unknown: (r) => !r.lastSeen,
      protection_not_running: (r) => r.protection === 'not_running',
      protection_missing: (r) => r.protection === 'missing',
      protection_unknown: (r) => r.protection === null,
    };
    return (await this.rows(scope, opts.clientId))
      .filter(match[filter])
      .sort(
        (a, b) =>
          (a.lastSeen?.getTime() ?? 0) - (b.lastSeen?.getTime() ?? 0) ||
          a.clientName.localeCompare(b.clientName) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, MAX_DEVICES)
      .map(({ assetId, clientId, clientName, name, kind, online, lastSeenAt, protection, protectionProduct }) => ({
        assetId,
        clientId,
        clientName,
        name,
        kind,
        online,
        lastSeenAt,
        protection,
        protectionProduct,
      }));
  }
}
