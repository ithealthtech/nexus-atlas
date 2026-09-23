import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { ActivityView, Actor } from '@atlas/shared';
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
  const rows = await scope.db
    .select({ a: schema.activity, clientName: schema.clients.name })
    .from(schema.activity)
    .leftJoin(schema.clients, eq(schema.clients.id, schema.activity.clientId))
    .where(and(...conditions))
    .orderBy(desc(schema.activity.id))
    .limit(Math.min(options.limit ?? 50, 200));
  return rows.map(({ a, clientName }) => ({
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
