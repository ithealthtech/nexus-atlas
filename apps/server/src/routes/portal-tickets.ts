import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { portalTicketSchema, ticketNoteSchema, type TicketReplies, type TicketView } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { CwPsaClient } from '../services/integrations/cw-psa-client.js';
import { PSA_TICKET_SOURCE } from '../services/integrations/cw-psa-tickets.js';
import {
  addTicketReply,
  openPortalTicket,
  portalTicketsOpen,
  ticketReplies,
} from '../services/integrations/cw-portal-tickets.js';
import { isUuid, Scope } from '../services/scope.js';
import { requestEvent } from '../services/security-log.js';
import type { SettingsService } from '../services/settings.js';

const OFF =
  'Opening tickets from Atlas is off for this client. An administrator turns it on under ConnectWise PSA, with the client linked to its PSA company.';

/**
 * ConnectWise PSA tickets opened from Atlas, mostly by client portal users, and the notes PSA shows the customer.
 * Anyone who can read the client may open one or reply; internal notes never reach this API.
 */
export function registerPortalTicketRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    settings: SettingsService;
    cwPsaFetch?: typeof fetch;
    /** Counts tickets opened per person, so a script or a stuck button can't flood the service board. */
    limiter: { check(key: string): void; fail(key: string): void };
  },
) {
  const { db, authed, settings, limiter } = deps;
  const connection = async (orgId: string, missing: HttpError) => {
    const saved = await settings.cwPsa(orgId);
    if (!saved) throw missing;
    return { saved, client: new CwPsaClient(saved, deps.cwPsaFetch) };
  };

  app.post<{ Params: { id: string } }>('/api/clients/:id/tickets', authed, async (req, reply): Promise<TicketView> => {
    const actor = req.session!.actor;
    if (!isUuid(req.params.id)) throw new HttpError(404, 'Client not found.');
    await new Scope(db, actor).require(req.params.id, 'read', 'Client');
    const input = portalTicketSchema.parse(req.body);
    const { saved, client } = await connection(actor.orgId, new HttpError(403, OFF));
    if (!portalTicketsOpen(saved, req.params.id)) throw new HttpError(403, OFF);
    // Checked and counted together, before anything is awaited, so concurrent requests can't all slip past the
    // limit. An attempt counts even if ConnectWise then refuses it.
    limiter.check(actor.id);
    limiter.fail(actor.id);
    const ticket = await openPortalTicket(db, client, saved, actor, req.params.id, input);
    // The number only: what the client wrote stays in PSA.
    await requestEvent(db, req, 'ConnectWise PSA ticket opened from Atlas', `Ticket ${ticket.number}`);
    reply.status(201);
    return ticket;
  });

  /** A PSA ticket of a client the actor can read, with whether replies can be sent. */
  const ticketFor = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const actor = req.session!.actor;
    const t = schema.tickets;
    const [ticket] = await db
      .select({ id: t.externalId, clientId: t.clientId, number: t.number })
      .from(t)
      .where(and(eq(t.orgId, actor.orgId), eq(t.source, PSA_TICKET_SOURCE), eq(t.externalId, req.params.id)))
      .limit(1);
    if (!ticket) throw new HttpError(404, 'Ticket not found.');
    await new Scope(db, actor).require(ticket.clientId, 'read', 'Ticket');
    const { saved, client } = await connection(actor.orgId, new HttpError(400, 'ConnectWise PSA is not connected.'));
    return { actor, ticket, client, canReply: portalTicketsOpen(saved, ticket.clientId) };
  };
  app.get<{ Params: { id: string } }>('/api/tickets/:id/replies', authed, async (req): Promise<TicketReplies> => {
    const { ticket, client, canReply } = await ticketFor(req);
    return { replies: await ticketReplies(client, ticket.id), canReply };
  });
  // Answers once PSA has the reply; the conversation is read again separately, so a failed refresh can't
  // look like a failed send and tempt a second, duplicate reply.
  app.post<{ Params: { id: string } }>('/api/tickets/:id/replies', authed, async (req) => {
    const { actor, ticket, client, canReply } = await ticketFor(req);
    if (!canReply) throw new HttpError(403, OFF);
    const { text } = ticketNoteSchema.parse(req.body);
    await addTicketReply(client, ticket.id, actor, text);
    await requestEvent(db, req, 'ConnectWise PSA ticket reply added from Atlas', `Ticket ${ticket.number}`);
    return { sent: true };
  });
}
