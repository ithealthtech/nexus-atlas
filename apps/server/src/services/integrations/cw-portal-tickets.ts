import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  cwPsaOptionsSchema,
  type Actor,
  type PortalTicketInput,
  type TicketNoteView,
  type TicketView,
} from '@atlas/shared';
import { HttpError } from '../../errors.js';
import type { StoredCwPsa } from '../settings.js';
import { pickSource } from './cw-expiry-tickets.js';
import type { CwPsaClient } from './cw-psa-client.js';
import { mapPsaTicket, psaDate, psaString, PSA_TICKET_SOURCE } from './cw-psa-tickets.js';
import { listOf, pick, text, UPSTREAM } from './cw-rmm.js';
import { clean, ticketTime, upsertTickets } from './cw-tickets.js';

type Json = Record<string, unknown>;
type Named = { id: string; name: string };

/** Notes shown per ticket, oldest first so the conversation reads down. */
const MAX_REPLIES = 100;
const SETUP = 'Ask your IT provider to check the setup.';

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

/** The PSA company a client is linked to, or null when it isn't linked. */
export function companyFor(map: StoredCwPsa['map'], clientId: string): string | null {
  return Object.entries(map).find(([, m]) => m.action === 'link' && m.clientId === clientId)?.[0] ?? null;
}

/** Whether PSA tickets can be opened for this client: the option is on, a board is named, and the client linked. */
export function portalTicketsOpen(saved: Pick<StoredCwPsa, 'map' | 'options'> | null, clientId: string) {
  if (!saved) return false;
  const options = cwPsaOptionsSchema.parse(saved.options ?? {});
  return options.portalTickets && !!options.portalTicketBoard && !!companyFor(saved.map, clientId);
}

/** Who asked, written into the ticket, so it's there even when the person isn't a PSA contact. */
export function requesterLine(actor: Pick<Actor, 'name' | 'email'>) {
  return `Submitted by ${clean(actor.name, 200)} (${clean(actor.email, 320)}) through Nexus Atlas.`;
}

/** The active board with this name (any case), or a clear error. */
async function boardFor(client: CwPsaClient, name: string): Promise<Named> {
  const { items } = await client.list('/service/boards', {
    conditions: `inactiveFlag=false and name=${psaString(name)}`,
    fields: 'id,name',
  });
  const board = named(items)[0];
  if (!board) throw new HttpError(UPSTREAM, `ConnectWise PSA has no active service board named "${name}". ${SETUP}`);
  return board;
}

/** The person's PSA contact at that company, found by email address, or null when PSA has none. */
async function contactFor(client: CwPsaClient, companyId: string, email: string): Promise<string | null> {
  const { items } = await client.list(
    '/company/contacts',
    {
      conditions: `company/id=${companyId} and inactiveFlag=false`,
      childConditions: `communicationItems/value=${psaString(email)} AND communicationItems/communicationType="Email"`,
      fields: 'id',
    },
    1,
  );
  return items.map((c) => text(c, 'id')).find((id) => /^\d+$/.test(id)) ?? null;
}

/**
 * Opens a ConnectWise PSA service ticket for a linked client, on the chosen board, and saves it with the synced
 * tickets so it shows straight away. The person is the ticket's contact when PSA knows their email address; the
 * ticket's text says who asked either way.
 */
export async function openPortalTicket(
  db: Database,
  client: CwPsaClient,
  saved: Pick<StoredCwPsa, 'map' | 'options' | 'site' | 'companyId'>,
  actor: Actor,
  clientId: string,
  input: PortalTicketInput,
): Promise<TicketView> {
  const companyId = companyFor(saved.map, clientId);
  if (!companyId) throw new HttpError(400, 'This client is not linked to a ConnectWise PSA company.');
  const options = cwPsaOptionsSchema.parse(saved.options ?? {});
  const board = await boardFor(client, options.portalTicketBoard);
  const source = pickPortalSource(named(await client.get('/service/sources?fields=id,name&pageSize=1000')));
  const contact = await contactFor(client, companyId, actor.email);
  const summary = clean(input.summary, 100);
  const body = {
    summary,
    company: { id: Number(companyId) },
    board: { id: Number(board.id) },
    ...(source ? { source: { id: Number(source.id) } } : {}),
    ...(contact
      ? { contact: { id: Number(contact) } }
      : { contactName: clean(actor.name, 62), contactEmailAddress: clean(actor.email, 250) }),
    initialDescription: [clean(input.details, 8000), requesterLine(actor)].join('\n\n'),
  };
  const startedAt = Date.now();
  let created: unknown;
  try {
    created = await client.post('/service/tickets', body);
  } catch (error) {
    if (!(error instanceof HttpError && error.code === 'cw_psa_timeout')) throw error;
    // No answer doesn't mean no ticket: PSA may still have opened it. Look before reporting a failure, so trying
    // again can't open a second one.
    const { items } = await client.list(
      '/service/tickets',
      {
        conditions: `company/id=${companyId} and board/id=${board.id} and summary=${psaString(summary)} and dateEntered>=${psaDate(startedAt - 2 * 60_000)}`,
        orderBy: 'id desc',
      },
      1,
    );
    if (!items[0])
      throw new HttpError(
        UPSTREAM,
        "ConnectWise PSA didn't confirm the ticket in time, and it wasn't found afterwards. Check with your IT provider before trying again.",
      );
    created = items[0];
  }
  const now = Date.now();
  const ticket = mapPsaTicket((created ?? {}) as Json, saved.site, saved.companyId, now);
  if (!ticket) throw new HttpError(UPSTREAM, 'ConnectWise PSA opened the ticket but did not say its number. It shows after the next sync.');
  ticket.board ||= board.name;
  ticket.origin ||= source?.name ?? '';
  ticket.openedAt ??= new Date(now);
  ticket.updatedAt ??= new Date(now);
  await upsertTickets(db, actor.orgId, PSA_TICKET_SOURCE, clientId, companyId, [ticket], now);
  const [owner] = await db
    .select({ name: schema.clients.name })
    .from(schema.clients)
    .where(and(eq(schema.clients.orgId, actor.orgId), eq(schema.clients.id, clientId)));
  return {
    id: ticket.id,
    source: 'cw-psa',
    number: ticket.number,
    summary: ticket.summary,
    status: ticket.status,
    closed: ticket.closed,
    priority: ticket.priority,
    clientId,
    clientName: owner?.name ?? '',
    openedAt: ticket.openedAt.toISOString(),
    closedAt: ticket.closedAt?.toISOString() ?? null,
    updatedAt: ticket.updatedAt.toISOString(),
    url: ticket.url,
    board: ticket.board,
    origin: ticket.origin,
    kind: ticket.kind,
  };
}

/** Who wrote a note, as the client sees it: the contact or the technician by name. */
const authorOf = (n: Json) => clean(text(n, 'contact.name', 'member.name', 'createdBy'), 200);

/**
 * The ticket's notes the customer can see in PSA (Discussion and Resolution), oldest first. Internal notes are
 * never returned: these go to client portal users.
 */
export async function ticketReplies(client: CwPsaClient, ticketId: string, now = Date.now()) {
  if (!/^\d+$/.test(ticketId)) throw new HttpError(404, 'Ticket not found.');
  const { items } = await client.list(`/service/tickets/${ticketId}/notes`, { orderBy: 'id asc' }, 1);
  const replies = items
    .filter((n) => pick(n, 'internalAnalysisFlag') !== true)
    .filter((n) => pick(n, 'detailDescriptionFlag') === true || pick(n, 'resolutionFlag') === true)
    .map((n): TicketNoteView | null => {
      const body = clean(text(n, 'text'), 12_000);
      return body
        ? {
            id: text(n, 'id') || body.slice(0, 40),
            text: body,
            createdAt: ticketTime(pick(n, 'dateCreated', '_info.dateCreated'), now)?.toISOString() ?? null,
            createdBy: authorOf(n),
          }
        : null;
    })
    .filter((n): n is TicketNoteView => !!n);
  return replies.slice(-MAX_REPLIES);
}

/** Adds a Discussion note (one the customer sees) to a PSA ticket, saying who wrote it. */
export async function addTicketReply(client: CwPsaClient, ticketId: string, actor: Actor, reply: string) {
  const detail = clean(reply, 4000);
  if (!detail) throw new HttpError(400, 'Write the reply first.');
  await client.post(`/service/tickets/${ticketId}/notes`, {
    text: `${detail}\n\n(Reply from ${clean(actor.name, 200)} through Nexus Atlas)`,
    detailDescriptionFlag: true,
    internalAnalysisFlag: false,
    resolutionFlag: false,
  });
}
