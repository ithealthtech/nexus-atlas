import { sql, type SQL } from 'drizzle-orm';
import type { ItemRef, SearchResult } from '@atlas/shared';
import type { Scope } from './scope.js';

/** Turns user input into a prefix tsquery ("harb fire" → 'harb':* & 'fire':*), or null if nothing searchable. */
export function prefixQuery(input: string): string | null {
  const tokens = input
    .toLowerCase()
    .normalize('NFKC')
    .match(/[\p{L}\p{N}][\p{L}\p{N}._@-]*/gu);
  if (!tokens?.length) return null;
  return tokens
    .slice(0, 8)
    .map((t) => `'${t.slice(0, 60).replace(/'/g, "''")}':*`)
    .join(' & ');
}

type Row = {
  type: ItemRef['type'];
  id: string;
  title: string;
  subtitle: string;
  client_id: string | null;
  client_name: string | null;
  snippet: string | null;
  rank: number;
};

export async function search(
  scope: Scope,
  input: string,
  options: { clientId?: string; limit?: number } = {},
): Promise<SearchResult[]> {
  const q = input.trim().slice(0, 200);
  const tsq = prefixQuery(q);
  if (!tsq) return [];
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  let ids = await scope.readableClientIds();
  if (options.clientId) {
    await scope.require(options.clientId, 'read', 'Client');
    ids = [options.clientId];
  }
  const global = scope.canReadGlobal && !options.clientId;
  if (!ids.length && !global) return [];
  const inClients = (column: SQL) => (ids.length ? sql`${column} in ${ids}` : sql`false`);
  const query = sql`to_tsquery('simple', ${tsq})`;
  const limit = Math.min(options.limit ?? 30, 50);
  const parts: SQL[] = [
    sql`select 'asset' as type, a.id, a.name as title, l.name as subtitle, a.client_id, c.name as client_name, null as snippet,
        ts_rank(a.search, ${query}) + similarity(a.name, ${q}) * 2 as rank
      from assets a join asset_layouts l on l.id = a.layout_id join clients c on c.id = a.client_id
      where a.org_id = ${scope.actor.orgId} and not a.archived and ${inClients(sql`a.client_id`)}
        and (a.search @@ ${query} or a.name ilike ${like})`,
    sql`select 'document', d.id, d.title, case when d.client_id is null then 'Knowledge base' else 'Document' end, d.client_id, c.name,
        ts_headline('simple', d.content_text, ${query}, 'MaxWords=20, MinWords=8, StartSel="", StopSel="", HighlightAll=false'),
        ts_rank(d.search, ${query}) + similarity(d.title, ${q}) * 2
      from documents d left join clients c on c.id = d.client_id
      where d.org_id = ${scope.actor.orgId} and not d.archived
        and (${inClients(sql`d.client_id`)} ${global ? sql`or d.client_id is null` : sql``})
        and (d.search @@ ${query} or d.title ilike ${like})`,
    sql`select 'contact', p.id, p.name, coalesce(nullif(p.title, ''), 'Contact'), p.client_id, c.name, nullif(concat_ws(' · ', nullif(p.email, ''), nullif(p.phone, '')), ''),
        ts_rank(p.search, ${query})
      from contacts p join clients c on c.id = p.client_id
      where p.org_id = ${scope.actor.orgId} and ${inClients(sql`p.client_id`)} and (p.search @@ ${query} or p.name ilike ${like})`,
    sql`select 'location', l.id, l.name, coalesce(nullif(l.city, ''), 'Location'), l.client_id, c.name, nullif(l.address, ''),
        ts_rank(l.search, ${query})
      from locations l join clients c on c.id = l.client_id
      where l.org_id = ${scope.actor.orgId} and ${inClients(sql`l.client_id`)} and (l.search @@ ${query} or l.name ilike ${like})`,
  ];
  if (!options.clientId && ids.length)
    parts.push(sql`select 'client', c.id, c.name, c.type, c.id, c.name, null, similarity(c.name, ${q}) * 3 + 0.5
      from clients c where c.org_id = ${scope.actor.orgId} and c.id in ${ids} and c.name ilike ${like}`);
  const result = await scope.db.execute(
    sql`${sql.join(parts, sql` union all `)} order by rank desc, title limit ${limit}`,
  );
  return (result.rows as Row[]).map((r) => ({
    type: r.type,
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    clientId: r.client_id,
    clientName: r.type === 'client' ? null : r.client_name,
    snippet: r.snippet ?? '',
  }));
}
