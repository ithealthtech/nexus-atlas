import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor, CwRmmSyncOptions } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { ExpirationService } from '../expirations.js';
import type { ImportRun } from '../importers/common.js';
import { Scope } from '../scope.js';
import type { StoredCwRmm } from '../settings.js';
import { ACCESS_DENIED, listOf, text, type CwRmmClient } from './cw-rmm.js';
import { atlasUrl } from './cw-writeback.js';

/** External refs of this source record which expiry already has a ticket, so each gets one. */
export const EXPIRY_TICKET_SOURCE = 'cw-expiry-ticket';
const TICKETS = '/api/platform/v2/service/ticketing/tickets';
const BOARDS = '/api/platform/v1/service/ticketing/service-boards';
const SOURCES = '/api/platform/v1/service/ticketing/sources';
/** Tickets opened per sync at most, so a first run on a large tenant doesn't flood the board. */
const MAX_PER_SYNC = 50;

type Named = { id: string; name: string };
const named = (list: unknown): Named[] =>
  listOf(list)
    .map((x) => ({ id: text(x, 'id'), name: text(x, 'name') }))
    .filter((x) => x.id);

/** The board by name (any case), else the first one listed. */
export function pickBoard(boards: Named[], wanted: string): Named | null {
  const want = wanted.trim().toLowerCase();
  return (want ? boards.find((b) => b.name.toLowerCase() === want) : boards[0]) ?? null;
}

/** A source that says the ticket came from Atlas or a system, else the first one listed. */
export function pickSource(sources: Named[]): Named | null {
  return (
    sources.find((s) => /atlas/i.test(s.name)) ??
    sources.find((s) => /^(internal|system|automat|other)/i.test(s.name)) ??
    sources[0] ??
    null
  );
}

/**
 * Opens a ConnectWise ticket for each asset date (domain, certificate, license, warranty) of a linked client coming
 * due within the chosen days. Each expiry, by asset, field, and date, gets one ticket: a renewed date gets a new one.
 */
export async function runExpiryTickets(
  db: Database,
  actor: Actor,
  client: CwRmmClient,
  run: ImportRun,
  map: StoredCwRmm['map'],
  options: Pick<CwRmmSyncOptions, 'expiryTicketDays' | 'expiryTicketBoard'>,
  publicUrl: string | undefined,
) {
  const companyOf = new Map(
    Object.entries(map).flatMap(([companyId, m]) => (m.action === 'link' ? [[m.clientId, companyId] as const] : [])),
  );
  if (!companyOf.size) return;
  const due = (await new ExpirationService().list(new Scope(db, actor), options.expiryTicketDays)).filter(
    (e) => e.kind === 'asset' && e.clientId && companyOf.has(e.clientId),
  );
  if (!due.length) return;

  const opened = new Set(
    (
      await db
        .select({ id: schema.externalRefs.externalId })
        .from(schema.externalRefs)
        .where(
          and(eq(schema.externalRefs.orgId, actor.orgId), eq(schema.externalRefs.source, EXPIRY_TICKET_SOURCE)),
        )
    ).map((r) => r.id),
  );
  const key = (e: (typeof due)[number]) => `${e.id}|${e.label}|${e.date}`.slice(0, 500);
  const todo = due.filter((e) => !opened.has(key(e)));
  if (!todo.length) return;

  let board: Named | null;
  let source: Named | null;
  try {
    board = pickBoard(named(await client.get(BOARDS)), options.expiryTicketBoard);
    source = pickSource(named(await client.get(SOURCES)));
  } catch (error) {
    run.count('expiryTickets', 'failed');
    run.note(
      `Expiry tickets: ${error instanceof HttpError && error.code === ACCESS_DENIED ? 'ConnectWise refused to list service boards. Check the key has the Tickets read and create permissions.' : "ConnectWise's service boards couldn't be read."}`,
    );
    return;
  }
  if (!board || !source) {
    run.note(
      options.expiryTicketBoard && !board
        ? `Expiry tickets: ConnectWise has no service board named "${options.expiryTicketBoard}".`
        : 'Expiry tickets: ConnectWise listed no service boards or sources.',
    );
    return;
  }

  for (const e of todo.slice(0, MAX_PER_SYNC)) {
    const when = e.daysLeft < 0 ? `expired on ${e.date}` : e.daysLeft === 0 ? 'expires today' : `expires on ${e.date}`;
    const link = publicUrl ? atlasUrl(publicUrl, 'endpoint', e.id) : '';
    const body = {
      summary: `${e.label.split(' · ')[0]}: ${e.title} ${when}`.slice(0, 200),
      description: [
        `${e.label} for ${e.title} (${e.clientName ?? 'client'}) ${when}.`,
        link && `Open in Atlas: ${link}`,
        '(Opened by Nexus Atlas)',
      ]
        .filter(Boolean)
        .join('\n\n'),
      company: { id: companyOf.get(e.clientId!) },
      serviceBoard: { id: board.id },
      source: { id: source.id },
      dueDate: `${e.date}T00:00:00Z`,
    };
    try {
      await client.post(TICKETS, body);
    } catch (error) {
      run.count('expiryTickets', 'failed');
      run.note(`Expiry ticket for ${e.title}: ${error instanceof HttpError ? error.message : 'could not be opened.'}`);
      // A key without the create permission fails every one the same way.
      if (error instanceof HttpError && error.code === ACCESS_DENIED) return;
      continue;
    }
    await db
      .insert(schema.externalRefs)
      .values({ orgId: actor.orgId, source: EXPIRY_TICKET_SOURCE, kind: 'asset', externalId: key(e), entityId: e.id })
      .onConflictDoNothing();
    run.count('expiryTickets', 'created');
  }
  if (todo.length > MAX_PER_SYNC)
    run.note(`Expiry tickets: ${todo.length - MAX_PER_SYNC} more are left for the next sync.`);
  run.note(`Expiry tickets go on the "${board.name}" board with source "${source.name}".`);
}
