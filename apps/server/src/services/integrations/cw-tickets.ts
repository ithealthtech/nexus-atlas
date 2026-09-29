import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { HttpError } from '../../errors.js';
import type { ImportRun } from '../importers/common.js';
import type { StoredCwRmm } from '../settings.js';
import { ACCESS_DENIED, listOf, pick, shapeOf, text, type CwRmmClient } from './cw-rmm.js';

type Json = Record<string, unknown>;

/** The `source` of tickets synced from the ConnectWise platform. */
export const TICKET_SOURCE = 'cw-platform';
const DAY = 86_400_000;
/** Closed tickets are kept this long, for the 90-day statistics. */
export const KEEP_CLOSED_DAYS = 90;
const PAGE = 100;
const MAX_PAGES = 200;

type TicketQuery = { label: string; path: (companyId: string, query: string) => string };
// ConnectWise doesn't publish which of these the platform answers; the first that works is kept for the run, as
// for devices.
const TICKET_QUERIES: TicketQuery[] = [
  {
    label: 'tickets by company',
    path: (c, q) => `/api/platform/v1/ticket/companies/${encodeURIComponent(c)}/tickets?${q}`,
  },
  { label: 'ticket list', path: (c, q) => `/api/platform/v1/ticket/tickets?companyId=${encodeURIComponent(c)}&${q}` },
  {
    label: 'service tickets',
    path: (c, q) => `/api/platform/v1/service/companies/${encodeURIComponent(c)}/tickets?${q}`,
  },
];

export interface CwTicket {
  id: string;
  number: string;
  summary: string;
  status: string;
  closed: boolean;
  priority: string;
  openedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date | null;
  url: string | null;
}

/** A time from an ISO string or a Unix time in seconds or milliseconds; null when missing or implausible. */
export function ticketTime(value: unknown, now = Date.now()): Date | null {
  let ms: number;
  if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string' && /^\d{9,13}$/.test(value.trim())) return ticketTime(Number(value), now);
  else if (typeof value === 'string') ms = Date.parse(value);
  else return null;
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > now + DAY) return null;
  return new Date(ms);
}

/** Ticket text is someone else's: control characters are dropped and the length capped. */
// eslint-disable-next-line no-control-regex
const clean = (s: string, max: number) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);

const CLOSED_STATUS = /^(closed|completed?|resolved|cancell?ed)\b/i;

/** Maps a ticket record onto Atlas's fields, reading whichever names are present; null without an ID. */
export function mapTicket(t: Json, now = Date.now()): CwTicket | null {
  const id = text(t, 'ticketId', 'id', 'ticketNumber');
  if (!id) return null;
  const status = clean(text(t, 'status.name', 'statusName', 'status', 'state.name', 'state'), 100);
  const closedAt = ticketTime(pick(t, 'closedDate', 'closedAt', 'dateClosed', 'resolvedDate', 'resolvedAt'), now);
  const flag = pick(t, 'closedFlag', 'isClosed', 'closed', 'status.closed', 'status.closedStatus');
  const closed = typeof flag === 'boolean' ? flag : !!closedAt || CLOSED_STATUS.test(status);
  const link = text(t, 'url', 'link', 'webUrl', 'ticketUrl', '_links.self.href');
  return {
    id: clean(id, 100),
    number: clean(text(t, 'ticketNumber', 'number', 'displayId', 'id') || id, 100),
    summary: clean(text(t, 'summary', 'subject', 'title'), 500),
    status: status || (closed ? 'Closed' : 'Open'),
    closed,
    priority: clean(text(t, 'priority.name', 'priorityName', 'priority'), 100),
    openedAt: ticketTime(
      pick(t, 'dateEntered', 'createdDate', 'createdAt', 'openedDate', 'dateCreated', '_info.dateEntered', 'created'),
      now,
    ),
    closedAt: closed ? closedAt : null,
    updatedAt: ticketTime(pick(t, 'lastUpdated', 'updatedAt', 'modifiedDate', 'lastModified', '_info.lastUpdated'), now),
    // Only a web address; anything else (a script URL, say) is dropped.
    url: /^https:\/\/[^\s"'<>]+$/i.test(link) ? link.slice(0, 1000) : null,
  };
}

/** Reads a company's tickets from the ConnectWise platform API, using the first request shape it answers. */
export class CwTicketReader {
  /** What the last ticket list looked like (field names only), for a job note. */
  lastList = '';
  private query: TicketQuery | null = null;

  constructor(private readonly client: CwRmmClient) {}

  /** Every open ticket, and those closed in the last 90 days. */
  async tickets(companyId: string, now = Date.now()): Promise<CwTicket[]> {
    const shapes = this.query ? [this.query] : TICKET_QUERIES;
    const tried: string[] = [];
    let notFound = 0;
    for (const shape of shapes) {
      try {
        const records = await this.pages(companyId, shape);
        this.query = shape;
        const since = now - KEEP_CLOSED_DAYS * DAY;
        return records
          .map((r) => mapTicket(r, now))
          .filter((t): t is CwTicket => !!t)
          .filter((t) => !t.closed || ((t.closedAt ?? t.updatedAt)?.getTime() ?? 0) >= since);
      } catch (error) {
        // A sign-in or permission failure isn't about the request shape: trying the others only signs in again.
        if (!(error instanceof HttpError && (error.status === 400 || error.status === 404)) || error.code === ACCESS_DENIED)
          throw error;
        if (error.status === 404) notFound++;
        const said = /ConnectWise said: (.*)$/.exec(error.message)?.[1] ?? error.message;
        tried.push(`${shape.label}: ${said.slice(0, 100)}`);
      }
    }
    // "Not found" everywhere is a company with no tickets, as it is for devices.
    if (notFound === tried.length) {
      this.lastList = `no tickets (${tried.join('; ')})`.slice(0, 400);
      return [];
    }
    throw new HttpError(
      400,
      `ConnectWise wouldn't list tickets. Check the API key has the Tickets read permission. Tried ${tried.join('; ')}`,
    );
  }

  private async pages(companyId: string, shape: TicketQuery): Promise<Json[]> {
    const out: Json[] = [];
    for (let cursor = 0, page = 0; page < MAX_PAGES; page++) {
      let body: unknown;
      try {
        body = await this.client.get(shape.path(companyId, `limit=${PAGE}&cursor=${cursor}`));
      } catch (error) {
        // Past the last page ConnectWise may answer "not found"; on the first page that's for the caller.
        if (page && error instanceof HttpError && error.status === 404) break;
        throw error;
      }
      const records = listOf(body);
      out.push(...records);
      if (!page) this.lastList = `${shape.label}: response fields ${shapeOf(body)}; ${records.length} on the first page`;
      if (records.length < PAGE) break;
      const next = Number(pick((body ?? {}) as Json, 'nextCursor', 'pageInfo.nextCursor', 'next'));
      cursor = Number.isFinite(next) && next > cursor ? next : cursor + records.length;
    }
    return out;
  }
}

/** Deletes an organization's synced tickets, when ticket syncing is switched off or ConnectWise disconnected. */
export async function clearTickets(db: Database, orgId: string) {
  await db.delete(schema.tickets).where(and(eq(schema.tickets.orgId, orgId), eq(schema.tickets.source, TICKET_SOURCE)));
}

/**
 * Syncs the tickets of every linked company. Read-only: nothing is ever written to ConnectWise. Tickets a company
 * no longer returns are deleted, but only when that company was read; tickets of unlinked companies are deleted.
 */
export async function runTicketSync(
  db: Database,
  orgId: string,
  reader: CwTicketReader,
  run: ImportRun,
  map: StoredCwRmm['map'],
  now = Date.now(),
) {
  const t = schema.tickets;
  const linked = Object.entries(map).flatMap(([companyId, m]) =>
    m.action === 'link' ? [[companyId, m.clientId] as const] : [],
  );
  const known = new Set(
    (
      await db
        .select({ id: t.externalId })
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.source, TICKET_SOURCE)))
    ).map((r) => r.id),
  );
  const read: string[] = [];
  const seen: string[] = [];
  for (const [companyId, clientId] of linked) {
    let list: CwTicket[];
    try {
      list = await reader.tickets(companyId, now);
    } catch (error) {
      run.count('tickets', 'failed');
      run.note(`Tickets for company ${companyId}: ${error instanceof HttpError ? error.message : 'could not be read.'}`);
      // The key can't read tickets at all: the other companies would only sign in and fail again, and ConnectWise
      // locks a key that signs in too often. Nothing is deleted, since nothing was read.
      if (error instanceof HttpError && error.code === ACCESS_DENIED) {
        const rest = linked.length - linked.findIndex(([c]) => c === companyId) - 1;
        if (rest) run.note(`Tickets not read for the other ${rest} compan${rest === 1 ? 'y' : 'ies'}.`);
        return;
      }
      continue;
    }
    try {
      for (let i = 0; i < list.length; i += 500) {
        const rows = list.slice(i, i + 500).map((k) => ({
          orgId,
          source: TICKET_SOURCE,
          externalId: k.id,
          clientId,
          companyId,
          number: k.number,
          summary: k.summary,
          status: k.status,
          closed: k.closed,
          priority: k.priority,
          openedAt: k.openedAt,
          closedAt: k.closedAt,
          remoteUpdatedAt: k.updatedAt,
          url: k.url,
          syncedAt: new Date(now),
        }));
        await db
          .insert(t)
          .values(rows)
          .onConflictDoUpdate({
            target: [t.orgId, t.source, t.externalId],
            set: {
              clientId,
              companyId,
              number: sql`excluded.number`,
              summary: sql`excluded.summary`,
              status: sql`excluded.status`,
              closed: sql`excluded.closed`,
              priority: sql`excluded.priority`,
              openedAt: sql`excluded.opened_at`,
              closedAt: sql`excluded.closed_at`,
              remoteUpdatedAt: sql`excluded.remote_updated_at`,
              url: sql`excluded.url`,
              syncedAt: sql`excluded.synced_at`,
            },
          });
      }
    } catch {
      run.count('tickets', 'failed');
      run.note(`Tickets for company ${companyId} could not be saved. Check the Atlas client it is linked to.`);
      continue;
    }
    for (const k of list) {
      run.count('tickets', known.has(k.id) ? 'updated' : 'created');
      seen.push(k.id);
    }
    read.push(companyId);
  }
  if (linked.length && !seen.length && reader.lastList) run.note(`No tickets listed (${reader.lastList}).`);

  // Tickets the companies that were read no longer return: deleted, or closed more than 90 days ago.
  if (read.length)
    await db
      .delete(t)
      .where(
        and(
          eq(t.orgId, orgId),
          eq(t.source, TICKET_SOURCE),
          inArray(t.companyId, read),
          ...(seen.length ? [notInArray(t.externalId, seen)] : []),
        ),
      );
  // Companies unlinked (or set to not sync) since: their tickets go.
  await db
    .delete(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.source, TICKET_SOURCE),
        ...(linked.length ? [notInArray(t.companyId, linked.map(([c]) => c))] : []),
      ),
    );
}
