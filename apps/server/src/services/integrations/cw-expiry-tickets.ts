import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor, CwRmmSyncOptions } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { ExpirationService } from '../expirations.js';
import type { ImportRun } from '../importers/common.js';
import { Scope } from '../scope.js';
import type { StoredCwRmm } from '../settings.js';
import { ACCESS_DENIED, listOf, pick, text, type CwRmmClient } from './cw-rmm.js';
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

/** Whether ConnectWise marks a board inactive, in any of the shapes it has been seen to: it refuses tickets on one. */
function inactive(board: Record<string, unknown>) {
  const flag = (key: string) => pick(board, key);
  return (
    flag('inactive') === true ||
    flag('inactiveFlag') === true ||
    flag('isInactive') === true ||
    flag('isActive') === false ||
    flag('active') === false ||
    /inactive|disabled/i.test(String(flag('status') ?? ''))
  );
}

/** The service boards a ticket can go on, in the order listed: inactive ones are left out. */
export const activeBoards = (list: unknown): Named[] =>
  listOf(list)
    .filter((b) => !inactive(b))
    .map((x) => ({ id: text(x, 'id'), name: text(x, 'name') }))
    .filter((x) => x.id);

/** Whether ConnectWise refused a ticket for its board ("serviceBoard is not valid"), so another may be tried. */
export const boardRefused = (error: unknown) =>
  error instanceof HttpError && /serviceBoard is not valid|valid active service board/i.test(error.message);

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

/** A site named main, head office, primary or HQ, else the first one listed. */
export function pickSite(sites: Named[]): Named | null {
  return sites.find((s) => /\b(main|head|primary|hq)\b/i.test(s.name)) ?? sites[0] ?? null;
}

/** The company's site a ticket goes to: ConnectWise refuses a ticket without one ("site is a required field"). */
export async function siteFor(client: CwRmmClient, companyId: string): Promise<Named | null> {
  return pickSite((await client.sites(companyId)).map((s) => ({ id: s.id, name: s.name })));
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
  // By the field's key, not its label, so renaming the field or its layout doesn't open the ticket again.
  const key = (e: (typeof due)[number]) => `${e.id}|${e.fieldKey ?? e.label}|${e.date}`.slice(0, 500);
  const todo = due.filter((e) => !opened.has(key(e)));
  if (!todo.length) return;

  let board: Named | null;
  let source: Named | null;
  try {
    board = pickBoard(activeBoards(await client.get(BOARDS)), options.expiryTicketBoard);
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

  const siteOf = new Map<string, Named | null>();
  for (const e of todo.slice(0, MAX_PER_SYNC)) {
    const companyId = companyOf.get(e.clientId!)!;
    if (!siteOf.has(companyId)) {
      try {
        siteOf.set(companyId, await siteFor(client, companyId));
      } catch (error) {
        run.count('expiryTickets', 'failed');
        run.note(
          `Expiry ticket for ${e.title}: ${error instanceof HttpError && error.code === ACCESS_DENIED ? 'ConnectWise refused to list sites. Check the key has the Sites read permission.' : `ConnectWise's sites for ${e.clientName ?? 'its company'} couldn't be read.`}`,
        );
        continue;
      }
    }
    const site = siteOf.get(companyId);
    if (!site) {
      run.count('expiryTickets', 'failed');
      run.note(`Expiry ticket for ${e.title}: ConnectWise listed no site for ${e.clientName ?? 'its company'}, and a ticket needs one.`);
      continue;
    }
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
      company: { id: companyId },
      site: { id: site.id },
      serviceBoard: { id: board.id },
      source: { id: source.id },
      dueDate: `${e.date}T00:00:00Z`,
    };
    try {
      await client.post(TICKETS, body);
    } catch (error) {
      run.count('expiryTickets', 'failed');
      run.note(`Expiry ticket for ${e.title}: ${error instanceof HttpError ? error.message : 'could not be opened.'}`);
      // The same board fails every one: say how to fix it once and stop.
      if (boardRefused(error)) {
        run.note(`Expiry tickets: ConnectWise won't take tickets on the "${board.name}" board. Name an active board under Expiry tickets.`);
        return;
      }
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
