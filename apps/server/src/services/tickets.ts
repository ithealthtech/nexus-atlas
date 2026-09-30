import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  TICKET_DAYS,
  type TicketDays,
  type TicketReport,
  type TicketStatusCount,
  type TicketView,
} from '@atlas/shared';
import type { Scope } from './scope.js';
import type { SettingsService } from './settings.js';

const DAY = 86_400_000;
const MAX_TICKETS = 500;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The period for the statistics: 7, 30, or 90 days, 30 when the request names none of them. */
export const ticketDays = (value: unknown): TicketDays => TICKET_DAYS.find((d) => d === Number(value)) ?? 30;

/** Tickets synced from ConnectWise, for the clients the actor can read. Read-only. */
export class TicketService {
  constructor(private readonly settings: SettingsService) {}

  /** The clients in view: those the actor can read, narrowed to one when asked. */
  private async ids(scope: Scope, clientId?: string) {
    const readable = await scope.readableClientIds();
    return clientId ? readable.filter((id) => id === clientId) : readable;
  }

  /** Whether a ConnectWise company is linked to one of these clients, with tickets switched on. */
  private async linked(orgId: string, ids: string[]) {
    const links = await this.settings.cwRmmLinks(orgId);
    if (!links || links.options?.tickets === false) return false;
    const inView = new Set(ids);
    return Object.values(links.map).some((m) => m.action === 'link' && inView.has(m.clientId));
  }

  async report(scope: Scope, opts: { clientId?: string; days?: unknown } = {}): Promise<TicketReport> {
    const ids = await this.ids(scope, opts.clientId);
    const days = ticketDays(opts.days);
    const now = Date.now();
    // Whole days, today included.
    const start = Date.parse(`${dayOf(now - (days - 1) * DAY)}T00:00:00Z`);
    const trend = new Map(
      Array.from({ length: days }, (_, i) => [
        dayOf(start + i * DAY),
        { day: dayOf(start + i * DAY), opened: 0, closed: 0 },
      ]),
    );
    const t = schema.tickets;
    const rows = ids.length
      ? await scope.db
          .select({
            status: t.status,
            closed: t.closed,
            openedAt: t.openedAt,
            closedAt: t.closedAt,
            updatedAt: t.remoteUpdatedAt,
            syncedAt: t.syncedAt,
          })
          .from(t)
          .where(and(eq(t.orgId, scope.actor.orgId), inArray(t.clientId, ids)))
      : [];
    const statuses = new Map<string, TicketStatusCount>();
    let open = 0;
    let updatedAt: Date | null = null;
    for (const r of rows) {
      if (!updatedAt || r.syncedAt > updatedAt) updatedAt = r.syncedAt;
      if (r.openedAt) {
        const p = trend.get(dayOf(r.openedAt.getTime()));
        if (p) p.opened++;
      }
      if (r.closed && r.closedAt) {
        const p = trend.get(dayOf(r.closedAt.getTime()));
        if (p) p.closed++;
      }
      // Closed tickets count toward their status only within the period.
      const closedWhen = (r.closedAt ?? r.updatedAt)?.getTime() ?? 0;
      if (r.closed && closedWhen < start) continue;
      if (!r.closed) open++;
      let s = statuses.get(r.status);
      if (!s) statuses.set(r.status, (s = { name: r.status, count: 0, closed: r.closed }));
      s.count++;
      // A status some tickets are still open in is an open status.
      if (!r.closed) s.closed = false;
    }
    return {
      linked: await this.linked(scope.actor.orgId, ids),
      updatedAt: updatedAt?.toISOString() ?? null,
      days,
      open,
      statuses: [...statuses.values()].sort(
        (a, b) => Number(a.closed) - Number(b.closed) || b.count - a.count || a.name.localeCompare(b.name),
      ),
      trend: [...trend.values()],
    };
  }

  /**
   * Open tickets, or those in one status (closed ones within the period, as the status counts them), the longest
   * since an update first.
   */
  async list(scope: Scope, opts: { clientId?: string; status?: string; days?: unknown } = {}): Promise<TicketView[]> {
    const ids = await this.ids(scope, opts.clientId);
    if (!ids.length) return [];
    const t = schema.tickets;
    const start = new Date(`${dayOf(Date.now() - (ticketDays(opts.days) - 1) * DAY)}T00:00:00Z`);
    const rows = await scope.db
      .select({
        id: t.externalId,
        number: t.number,
        summary: t.summary,
        status: t.status,
        closed: t.closed,
        priority: t.priority,
        clientId: t.clientId,
        clientName: schema.clients.name,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        updatedAt: t.remoteUpdatedAt,
        url: t.url,
        board: t.board,
        origin: t.origin,
        kind: t.kind,
      })
      .from(t)
      .innerJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .where(
        and(
          eq(t.orgId, scope.actor.orgId),
          inArray(t.clientId, ids),
          opts.status === undefined
            ? eq(t.closed, false)
            : and(
                eq(t.status, opts.status),
                sql`(not ${t.closed} or coalesce(${t.closedAt}, ${t.remoteUpdatedAt}) >= ${start})`,
              ),
        ),
      )
      .orderBy(sql`${t.remoteUpdatedAt} asc nulls first`, asc(t.openedAt), asc(t.number))
      .limit(MAX_TICKETS);
    return rows.map((r) => ({
      ...r,
      openedAt: r.openedAt?.toISOString() ?? null,
      closedAt: r.closedAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
    }));
  }
}
