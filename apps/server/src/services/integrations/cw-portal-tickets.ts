import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  cwRmmSyncOptionsSchema,
  type Actor,
  type CwRmmRegion,
  type PortalTicketInput,
  type TicketNoteView,
  type TicketView,
} from '@atlas/shared';
import { HttpError } from '../../errors.js';
import type { StoredCwRmm } from '../settings.js';
import { pickBoard, pickSource } from './cw-expiry-tickets.js';
import { ACCESS_DENIED, listOf, pick, text, type CwRmmClient } from './cw-rmm.js';
import {
  clean,
  CW_WEB,
  mapNote,
  mapTicket,
  notesPath,
  TICKET_SOURCE,
  ticketLink,
  VISIBLE_TO_ALL,
} from './cw-tickets.js';

type Json = Record<string, unknown>;
type Named = { id: string; name: string };

const TICKETS = '/api/platform/v2/service/ticketing/tickets';
const BOARDS = '/api/platform/v1/service/ticketing/service-boards';
const SOURCES = '/api/platform/v1/service/ticketing/sources';
/** Replies shown per ticket, oldest first so the conversation reads down. */
const MAX_REPLIES = 100;

const named = (list: unknown): Named[] =>
  listOf(list)
    .map((x) => ({ id: text(x, 'id'), name: text(x, 'name') }))
    .filter((x) => x.id);

/** A source that says the ticket came from a portal or the web, else Atlas or a system one, else the first. */
export function pickPortalSource(sources: Named[]): Named | null {
  return (
    sources.find((s) => /portal/i.test(s.name)) ?? sources.find((s) => /\bweb\b/i.test(s.name)) ?? pickSource(sources)
  );
}

/** The ConnectWise company a client is linked to, or null when it isn't linked. */
export function companyFor(map: StoredCwRmm['map'], clientId: string): string | null {
  return Object.entries(map).find(([, m]) => m.action === 'link' && m.clientId === clientId)?.[0] ?? null;
}

/**
 * Whether portal tickets can be opened for this client: they and the ticket sync are on (without the sync, an opened
 * ticket would never show), and the client is linked.
 */
export function portalTicketsOpen(saved: Pick<StoredCwRmm, 'map' | 'options'> | null, clientId: string) {
  if (!saved) return false;
  const options = cwRmmSyncOptionsSchema.parse(saved.options ?? {});
  return options.tickets && options.portalTickets && !!companyFor(saved.map, clientId);
}

/** Who asked, written into the ticket: the platform ticket has no contact field, so the requester goes in the text. */
export function requesterLine(actor: Pick<Actor, 'name' | 'email'>) {
  return `Submitted by ${clean(actor.name, 200)} (${clean(actor.email, 320)}) through Nexus Atlas.`;
}

/**
 * Opens a ConnectWise ticket for a linked client, on the chosen board, and saves it with the synced tickets so it
 * shows straight away. The ticket's text says who asked; the next sync refreshes everything else.
 */
export async function openPortalTicket(
  db: Database,
  client: CwRmmClient,
  saved: Pick<StoredCwRmm, 'map' | 'options'> & { region: CwRmmRegion },
  actor: Actor,
  clientId: string,
  input: PortalTicketInput,
): Promise<TicketView> {
  const companyId = companyFor(saved.map, clientId);
  if (!companyId) throw new HttpError(400, 'This client is not linked to a ConnectWise company.');
  const options = cwRmmSyncOptionsSchema.parse(saved.options ?? {});
  let board: Named | null;
  let source: Named | null;
  try {
    board = pickBoard(named(await client.get(BOARDS)), options.portalTicketBoard);
    source = pickPortalSource(named(await client.get(SOURCES)));
  } catch (error) {
    if (error instanceof HttpError && error.code === ACCESS_DENIED)
      throw new HttpError(502, 'ConnectWise refused to list service boards. Ask your IT provider to check the setup.');
    throw error;
  }
  if (!board || !source)
    throw new HttpError(
      502,
      options.portalTicketBoard && !board
        ? `ConnectWise has no service board named "${options.portalTicketBoard}". Ask your IT provider to check the setup.`
        : 'ConnectWise listed no service boards or sources. Ask your IT provider to check the setup.',
    );
  const body = {
    summary: clean(input.summary, 200),
    description: [clean(input.details, 8000), requesterLine(actor)].join('\n\n'),
    company: { id: companyId },
    serviceBoard: { id: board.id },
    source: { id: source.id },
  };
  let created: unknown;
  try {
    created = await client.post(TICKETS, body);
  } catch (error) {
    if (error instanceof HttpError && error.code === ACCESS_DENIED)
      throw new HttpError(502, 'ConnectWise refused to open the ticket. Ask your IT provider to check the setup.');
    throw error;
  }
  const now = Date.now();
  const web = CW_WEB[saved.region];
  const ticket = mapTicket(
    { status: 'New', createdAt: new Date(now).toISOString(), ...((created ?? {}) as Json), summary: body.summary },
    now,
    (number) => ticketLink(web, number, companyId),
  );
  // ConnectWise answered without an ID: the ticket is there, and the next sync brings it in.
  if (!ticket) throw new HttpError(502, 'ConnectWise opened the ticket but did not say its number. It shows after the next sync.');
  const row = {
    orgId: actor.orgId,
    source: TICKET_SOURCE,
    externalId: ticket.id,
    clientId,
    companyId,
    number: ticket.number,
    summary: ticket.summary,
    status: ticket.status,
    closed: ticket.closed,
    priority: ticket.priority,
    openedAt: ticket.openedAt ?? new Date(now),
    closedAt: ticket.closedAt,
    remoteUpdatedAt: ticket.updatedAt ?? new Date(now),
    url: ticket.url,
    board: ticket.board || board.name,
    origin: ticket.origin || source.name,
    kind: ticket.kind,
    syncedAt: new Date(now),
  };
  await db.insert(schema.tickets).values(row).onConflictDoNothing();
  const [owner] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.orgId, actor.orgId), eq(schema.clients.id, clientId)));
  return {
    id: row.externalId,
    number: row.number,
    summary: row.summary,
    status: row.status,
    closed: row.closed,
    priority: row.priority,
    clientId,
    clientName: owner?.name ?? '',
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    updatedAt: row.remoteUpdatedAt.toISOString(),
    url: row.url,
    board: row.board,
    origin: row.origin,
    kind: row.kind,
  };
}

/**
 * The ticket's replies visible to all, oldest first. Internal notes (any other visibility, or none given) are
 * never returned: these go to client portal users.
 */
export async function ticketReplies(client: CwRmmClient, ticketId: string, now = Date.now()) {
  const replies = listOf(await client.get(notesPath(ticketId)))
    .filter((n) => Number(pick(n, 'visibility')) === VISIBLE_TO_ALL)
    .map((n) => mapNote(n, now))
    .filter((n): n is TicketNoteView => !!n);
  return replies.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')).slice(-MAX_REPLIES);
}

/** Adds a reply visible to all to a ConnectWise ticket, saying who wrote it. */
export async function addTicketReply(client: CwRmmClient, ticketId: string, actor: Actor, reply: string) {
  const detail = clean(reply, 4000);
  if (!detail) throw new HttpError(400, 'Write the reply first.');
  await client.post(notesPath(ticketId), {
    detail: `${detail}\n\n(Reply from ${clean(actor.name, 200)} through Nexus Atlas)`,
    visibility: VISIBLE_TO_ALL,
  });
}
