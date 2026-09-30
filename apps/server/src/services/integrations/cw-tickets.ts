import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { HttpError } from '../../errors.js';
import type { ImportRun } from '../importers/common.js';
import type { StoredCwRmm } from '../settings.js';
import type { CwRmmRegion, TicketNoteView } from '@atlas/shared';
import { ACCESS_DENIED, listOf, pick, shapeOf, text, type CwRmmClient } from './cw-rmm.js';

type Json = Record<string, unknown>;

/** The `source` of tickets synced from the ConnectWise platform. */
export const TICKET_SOURCE = 'cw-platform';
const DAY = 86_400_000;
/** Closed tickets are kept this long, for the 90-day statistics. */
export const KEEP_CLOSED_DAYS = 90;
const PAGE = 100;
const MAX_PAGES = 200;

// The ConnectWise platform's service ticketing API.
const TICKETS = '/api/platform/v2/service/ticketing/tickets';

/** The web app for each API region. Only North America's is known, so other regions get no ticket links. */
const CW_WEB: Partial<Record<CwRmmRegion, string>> = { na: 'https://control.itsupport247.net' };

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
  board: string;
  origin: string;
  kind: string;
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

const CLOSED_STATUS = /^(closed|completed?|resolved|cancell?ed|done|finished)\b/i;
const numeric = (s: string) => /^\d{1,18}$/.test(s);

/**
 * A browser link to a platform ticket, as the web app's own ticket links read (keyed by the plain ticket ID the
 * portal shows, like 5535, and the platform company ID). Dotted numbers ("133023.1533") are not portal IDs: no link.
 */
export function ticketLink(web: string | undefined, number: string, companyNumber: string) {
  const company = /^[\w-]{1,64}$/.test(companyNumber);
  if (!web || !numeric(number) || !company) return null;
  return `${web}/QADashB/QuickAccess/NewDesktops/service-tickets?SSECTION=10020&STAB=10020#??asio_route=/service-tickets/bms-ticket-overview?ticketId=${number}&companyId=${companyNumber}&projectIssue=false&tabId=unified-ticket-detail-screen??`;
}

/**
 * Maps a ticket record onto Atlas's fields, reading whichever names are present; null without an ID. A status
 * whose ID is in `closedStatuses` (ConnectWise's "Closed" category) marks the ticket closed.
 */
export function mapTicket(
  t: Json,
  now = Date.now(),
  closedStatuses: ReadonlySet<string> = new Set(),
  link?: (number: string) => string | null,
): CwTicket | null {
  const id = text(t, 'id', 'ticketId', 'ticketNumber');
  if (!id) return null;
  const status = clean(text(t, 'status.name', 'statusName', 'status', 'state.name', 'state'), 100);
  const closedAt = ticketTime(
    pick(t, 'closedAt', 'closedOn', 'closedDate', 'dateClosed', 'resolvedAt', 'resolvedOn', 'resolvedDate'),
    now,
  );
  const flag = pick(t, 'closedFlag', 'isClosed', 'closed', 'status.closed', 'status.closedStatus');
  const category = text(t, 'status.category', 'statusCategory');
  const closed =
    closedStatuses.has(text(t, 'status.id', 'statusId')) ||
    /^closed$/i.test(category) ||
    (typeof flag === 'boolean' ? flag : !!closedAt || CLOSED_STATUS.test(status));
  // The portal's ticket ID is a plain number; prefer whichever field carries one.
  const numbers = ['number', 'nocTicketId', 'ticketNumber', 'displayId'].map((k) => text(t, k));
  const number = clean(numbers.find(numeric) ?? (numbers.find(Boolean) || id), 100);
  const given = text(t, 'url', 'link', 'webUrl', 'ticketUrl', '_links.self.href');
  // Only a web address; anything else (a script URL, say) is dropped.
  const url = /^https:\/\/[^\s"'<>]+$/i.test(given) ? given : (link?.(number) ?? null);
  const updatedAt = ticketTime(
    pick(t, 'updatedAt', 'updatedOn', 'lastUpdated', 'modifiedAt', 'modifiedDate', 'lastModified', '_info.lastUpdated'),
    now,
  );
  return {
    id: clean(id, 100),
    number,
    summary: clean(text(t, 'summary', 'subject', 'title'), 500),
    status: status || (closed ? 'Closed' : 'Open'),
    closed,
    priority: clean(text(t, 'priority.name', 'priorityName', 'priority'), 100),
    openedAt: ticketTime(
      pick(t, 'createdAt', 'createdOn', 'dateEntered', 'createdDate', 'openedDate', 'dateCreated', '_info.dateEntered'),
      now,
    ),
    // A closed ticket without a closing date was last changed when it closed.
    closedAt: closed ? (closedAt ?? updatedAt) : null,
    updatedAt,
    url: url && url.length <= 1000 ? url : null,
    board: clean(text(t, 'serviceBoard.name', 'board.name', 'boardName'), 200),
    origin: clean(text(t, 'source.name', 'sourceName'), 200),
    kind: clean(text(t, 'type.name', 'typeName'), 200),
  };
}

/**
 * Reads a company's tickets from the ConnectWise platform's v2 service ticketing API, newest first. Only v2 is
 * used: the v1 company and status lookups belong to the legacy PSA.
 */
export class CwTicketReader {
  /** What the last ticket list looked like (field names only), for a job note. */
  lastList = '';
  /** Something worth a job note once per sync. */
  note = '';
  /** Companies with more tickets than one sync lists: their tickets not listed are kept, not deleted. */
  readonly partial = new Set<string>();
  private readonly web: string | undefined;

  constructor(
    private readonly client: CwRmmClient,
    region: CwRmmRegion = 'na',
  ) {
    this.web = CW_WEB[region];
  }

  /** Every open ticket, and those closed in the last 90 days. */
  async tickets(companyId: string, now = Date.now()): Promise<CwTicket[]> {
    // Linked by the company's platform ID, as the RMM device links are.
    const link = (number: string) => ticketLink(this.web, number, companyId);
    let records: Json[];
    try {
      records = await this.pages(`companyIds=${encodeURIComponent(companyId)}`);
      if (records.length >= MAX_PAGES * PAGE) this.partial.add(companyId);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400 || error.code === ACCESS_DENIED) throw error;
      throw new HttpError(
        400,
        `ConnectWise wouldn't list tickets. Check the API key has the Tickets read permission. ${error.message}`.slice(
          0,
          400,
        ),
      );
    }
    const since = now - KEEP_CLOSED_DAYS * DAY;
    const seen = new Set<string>();
    return records
      .map((r) => mapTicket(r, now, new Set(), link))
      .filter((t): t is CwTicket => !!t)
      .filter((t) => !t.closed || ((t.closedAt ?? t.updatedAt ?? t.openedAt)?.getTime() ?? 0) >= since)
      .filter((t) => !seen.has(t.id) && !!seen.add(t.id));
  }

  /** Every page of a ticket list, newest first. */
  private async pages(filter: string): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      let body: unknown;
      try {
        body = await this.client.get(`${TICKETS}?${filter}&pageSize=${PAGE}&pageNum=${page}&sortBy=createdAt&sortDir=desc`);
      } catch (error) {
        // "Not found" is how ConnectWise answers a company with no tickets, or a page past the last.
        if (error instanceof HttpError && error.status === 404 && error.code !== ACCESS_DENIED) {
          if (page === 1) this.lastList ||= 'ticket list: not found';
          break;
        }
        throw error;
      }
      const records = listOf(body);
      out.push(...records);
      if (page === 1) this.lastList = `ticket list: response fields ${shapeOf(body)}; ${records.length} on the first page`;
      const total = Number(pick((body ?? {}) as Json, 'totalCount', 'total', 'count'));
      if (!records.length || (Number.isFinite(total) ? out.length >= total : records.length < PAGE)) break;
    }
    return out;
  }
}

const notesPath = (ticketId: string) =>
  `/api/platform/v1/service/ticketing/tickets/${encodeURIComponent(ticketId)}/notes`;
/** Notes shown per ticket, newest first. */
const MAX_NOTES = 100;

/** A ticket note as Atlas shows it; null without text. */
export function mapNote(n: Json, now = Date.now()): TicketNoteView | null {
  const detail = clean(text(n, 'detail', 'text', 'note'), 12_000);
  if (!detail) return null;
  return {
    id: clean(text(n, 'id') || detail.slice(0, 40), 100),
    text: detail,
    createdAt: ticketTime(pick(n, 'createdAt', 'dateCreated'), now)?.toISOString() ?? null,
    createdBy: clean(text(n, 'createdBy', 'member.name', 'createdByName'), 200),
  };
}

/** A ticket's notes from ConnectWise, newest first. */
export async function ticketNotes(client: CwRmmClient, ticketId: string, now = Date.now()) {
  const notes = listOf(await client.get(notesPath(ticketId)))
    .map((n) => mapNote(n, now))
    .filter((n): n is TicketNoteView => !!n);
  return notes
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, MAX_NOTES);
}

/**
 * Adds an internal note (visible to the partner only, never the end customer) to a ConnectWise ticket. Only the
 * opt-in ticket notes option calls this.
 */
export async function addTicketNote(client: CwRmmClient, ticketId: string, detail: string) {
  const body = clean(detail, 12_000);
  if (!body) throw new HttpError(400, 'Write the note first.');
  await client.post(notesPath(ticketId), { detail: body, visibility: 2 });
}

/** The ticket number a reveal reason names ("#1234", "ticket 1234", "T1234"), if any. */
export function ticketNumberIn(reason: string): string | null {
  return /(?:#|\bticket\s*(?:no\.?|number)?\s*#?\s*|\bT)(\d{1,18})\b/i.exec(reason)?.[1] ?? null;
}

/** Deletes an organization's synced tickets, when ticket syncing is switched off or ConnectWise disconnected. */
export async function clearTickets(db: Database, orgId: string) {
  await db.delete(schema.tickets).where(and(eq(schema.tickets.orgId, orgId), eq(schema.tickets.source, TICKET_SOURCE)));
}

/**
 * Syncs the tickets of every linked company. Read-only: the sync never writes to ConnectWise. Tickets a company
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
          board: k.board,
          origin: k.origin,
          kind: k.kind,
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
              board: sql`excluded.board`,
              origin: sql`excluded.origin`,
              kind: sql`excluded.kind`,
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
    // A company listed only in part keeps the tickets it didn't list.
    if (!reader.partial.has(companyId)) read.push(companyId);
  }
  if (reader.note) run.note(reader.note);
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
