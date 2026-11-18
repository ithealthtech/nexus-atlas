import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { HttpError } from '../../errors.js';
import type { ImportRun } from '../importers/common.js';
import type { StoredCwPsa } from '../settings.js';
import type { CwPsaClient } from './cw-psa-client.js';
import { PSA_DENIED } from './cw-psa-client.js';
import { pick, text } from './cw-rmm.js';
import { clean, ticketTime, upsertTickets, type CwTicket } from './cw-tickets.js';

type Json = Record<string, unknown>;

/** The source of tickets read from ConnectWise PSA, beside the RMM's ('cw-rmm'). */
export const PSA_TICKET_SOURCE = 'cw-psa';
/** Closed tickets stay on the dashboard this long, as RMM tickets do. */
const KEEP_CLOSED_DAYS = 90;
const DAY = 86_400_000;
/** Companies per ticket query, so the conditions stay a reasonable length. */
const BATCH = 25;
const TICKET_FIELDS = [
  'id',
  'summary',
  'company/id',
  'board/name',
  'status/name',
  'priority/name',
  'source/name',
  'type/name',
  'closedFlag',
  'closedDate',
  'dateEntered',
  '_info/dateEntered',
  '_info/lastUpdated',
].join(',');

/** The PSA ticket in PSA's own screen. `company` is the company ID people sign in with. */
export function psaTicketUrl(site: string, ticketId: string, company: string) {
  if (!/^\d+$/.test(ticketId)) return null;
  return `${site}/v4_6_release/services/system_io/Service/fv_sr100_request.rails?service_recid=${ticketId}&companyName=${encodeURIComponent(company)}`;
}

/** A PSA service ticket as Atlas keeps it; null without a numeric ID. PSA's record ID is its ticket number. */
export function mapPsaTicket(t: Json, site: string, company: string, now = Date.now()): CwTicket | null {
  const id = text(t, 'id');
  if (!/^\d+$/.test(id)) return null;
  const closed = pick(t, 'closedFlag') === true;
  return {
    id,
    number: id,
    summary: clean(text(t, 'summary'), 500) || '(no summary)',
    status: clean(text(t, 'status.name'), 200) || 'Unknown',
    closed,
    priority: clean(text(t, 'priority.name'), 200),
    openedAt: ticketTime(pick(t, 'dateEntered', '_info.dateEntered'), now),
    closedAt: closed ? ticketTime(pick(t, 'closedDate'), now) : null,
    updatedAt: ticketTime(pick(t, '_info.lastUpdated'), now),
    url: psaTicketUrl(site, id, company),
    board: clean(text(t, 'board.name'), 200),
    origin: clean(text(t, 'source.name'), 200),
    kind: clean(text(t, 'type.name'), 200),
  };
}

/** PSA's date literal in conditions: [2026-11-18T00:00:00Z]. */
export const psaDate = (ms: number) => `[${new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')}]`;

/** A string literal in PSA conditions, with its quotes and backslashes escaped. */
export const psaString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** PSA's active companies, by record ID and name. */
export async function psaCompanies(client: CwPsaClient): Promise<{ id: string; name: string }[]> {
  const { items } = await client.list('/company/companies', {
    conditions: 'deletedFlag=false',
    fields: 'id,identifier,name',
    orderBy: 'name asc',
  });
  return items
    .map((c) => ({ id: text(c, 'id'), name: clean(text(c, 'name') || text(c, 'identifier'), 200) }))
    .filter((c) => /^\d+$/.test(c.id) && c.name);
}

/** The linked companies, as [PSA company ID, Atlas client ID]. */
export const psaLinked = (map: StoredCwPsa['map']) =>
  Object.entries(map).flatMap(([company, m]) => (m.action === 'link' ? [[company, m.clientId] as const] : []));

/**
 * Syncs the service tickets of every linked PSA company: open ones, and those closed in the last 90 days. Read-only.
 * Tickets no longer listed are deleted for the companies read; tickets of unlinked companies are deleted.
 */
export async function runPsaTicketSync(
  db: Database,
  orgId: string,
  client: CwPsaClient,
  run: ImportRun,
  saved: Pick<StoredCwPsa, 'map' | 'site' | 'companyId'>,
  now = Date.now(),
) {
  const t = schema.tickets;
  const linked = psaLinked(saved.map);
  const known = new Set(
    (
      await db
        .select({ id: t.externalId })
        .from(t)
        .where(and(eq(t.orgId, orgId), eq(t.source, PSA_TICKET_SOURCE)))
    ).map((r) => r.id),
  );
  const read: string[] = [];
  const seen: string[] = [];
  for (let i = 0; i < linked.length; i += BATCH) {
    const batch = linked.slice(i, i + BATCH);
    const clientOf = new Map<string, string>(batch);
    let items: Json[];
    let partial: boolean;
    try {
      ({ items, partial } = await client.list('/service/tickets', {
        conditions: `company/id in (${batch.map(([c]) => c).join(',')}) and (closedFlag=false or closedDate>=${psaDate(now - KEEP_CLOSED_DAYS * DAY)})`,
        fields: TICKET_FIELDS,
        orderBy: 'id desc',
      }));
    } catch (error) {
      run.count('tickets', 'failed');
      run.note(`PSA tickets: ${error instanceof HttpError ? error.message : 'could not be read.'}`);
      // Keys PSA refuses fail the same way for every batch.
      if (error instanceof HttpError && error.code === PSA_DENIED) return;
      continue;
    }
    const byCompany = new Map<string, CwTicket[]>();
    for (const item of items) {
      const company = text(item, 'company.id');
      const ticket = mapPsaTicket(item, saved.site, saved.companyId, now);
      if (!ticket || !clientOf.has(company)) continue;
      byCompany.set(company, [...(byCompany.get(company) ?? []), ticket]);
    }
    for (const [company, clientId] of batch) {
      const list = byCompany.get(company) ?? [];
      await upsertTickets(db, orgId, PSA_TICKET_SOURCE, clientId, company, list, now);
      for (const k of list) {
        run.count('tickets', known.has(k.id) ? 'updated' : 'created');
        seen.push(k.id);
      }
      // A batch PSA listed only in part keeps the tickets it didn't list.
      if (!partial) read.push(company);
    }
    if (partial) run.note('PSA tickets: more than 10,000 for some companies; the oldest were not read this time.');
  }
  if (read.length)
    await db
      .delete(t)
      .where(
        and(
          eq(t.orgId, orgId),
          eq(t.source, PSA_TICKET_SOURCE),
          inArray(t.companyId, read),
          ...(seen.length ? [notInArray(t.externalId, seen)] : []),
        ),
      );
  await clearUnlinkedPsaTickets(
    db,
    orgId,
    linked.map(([c]) => c),
  );
}

/** Deletes PSA tickets of companies no longer linked; all of them when none is. */
export async function clearUnlinkedPsaTickets(db: Database, orgId: string, linked: string[]) {
  const t = schema.tickets;
  await db
    .delete(t)
    .where(
      and(
        eq(t.orgId, orgId),
        eq(t.source, PSA_TICKET_SOURCE),
        ...(linked.length ? [notInArray(t.companyId, linked)] : []),
      ),
    );
}
