import { and, desc, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { ActivityView, Actor } from '@atlas/shared';
import { canSee } from './items.js';
import type { Scope } from './scope.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export async function recordActivity(
  db: Database | Tx,
  actor: Actor,
  entry: { clientId: string | null; action: string; entityType: string; entityId: string | null; title: string },
) {
  await db.insert(schema.activity).values({
    orgId: actor.orgId,
    actorId: actor.id,
    actorName: actor.name,
    ...entry,
    title: entry.title.slice(0, 200),
  });
}

export async function listActivity(
  scope: Scope,
  options: { clientId?: string; entityId?: string; limit?: number } = {},
): Promise<ActivityView[]> {
  const conditions: SQL[] = [eq(schema.activity.orgId, scope.actor.orgId)];
  if (options.clientId) {
    await scope.require(options.clientId, 'read', 'Client');
    conditions.push(eq(schema.activity.clientId, options.clientId));
  } else {
    const ids = await scope.readableClientIds();
    const visible = [
      ids.length ? inArray(schema.activity.clientId, ids) : undefined,
      scope.canReadGlobal ? isNull(schema.activity.clientId) : undefined,
    ].filter(Boolean) as SQL[];
    if (!visible.length) return [];
    conditions.push(or(...visible)!);
  }
  if (options.entityId) conditions.push(eq(schema.activity.entityId, options.entityId));
  // Password entries (even their names) only show to people who can use that client's vault.
  const vaultIds = [...(await scope.levels())].filter(([, level]) => level === 'edit_passwords').map(([id]) => id);
  conditions.push(
    vaultIds.length
      ? or(ne(schema.activity.entityType, 'password'), inArray(schema.activity.clientId, vaultIds))!
      : ne(schema.activity.entityType, 'password'),
  );
  const rows = await scope.db
    .select({ a: schema.activity, clientName: schema.clients.name })
    .from(schema.activity)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.activity.clientId))
    .where(and(...conditions))
    .orderBy(desc(schema.activity.id))
    .limit(Math.min(options.limit ?? 50, 200));
  // Restricted passwords are left out for people not on their list.
  const visible = [];
  for (const row of rows)
    if (
      row.a.entityType !== 'password' ||
      !row.a.entityId ||
      (await canSee(scope, { type: 'password', id: row.a.entityId, clientId: row.a.clientId }))
    )
      visible.push(row);
  return visible.map(({ a, clientName }) => ({
    id: String(a.id),
    clientId: a.clientId,
    clientName,
    actorName: a.actorName,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    title: a.title,
    createdAt: a.createdAt.toISOString(),
  }));
}
