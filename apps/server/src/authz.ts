import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, atLeast, maxLevel, minLevel, type AccessLevel, type Actor } from '@atlas/shared';
import { HttpError } from './errors.js';

/** The level an actor gets on every client before per-client grants: admins get everything; others their baseline, capped by role. */
export function baselineLevel(role: Actor['role'], allClients: AccessLevel): AccessLevel {
  const info = ROLE_INFO[role];
  if (info.admin) return 'edit_passwords';
  return info.staff ? minLevel(allClients, info.cap) : 'none';
}

/**
 * Effective level for each client in the actor's organization.
 * Highest of: baseline, direct grant, group grants — then capped by role.
 */
export async function clientLevels(db: Database, actor: Actor): Promise<Map<string, AccessLevel>> {
  const cap = ROLE_INFO[actor.role].cap;
  const base = baselineLevel(actor.role, actor.allClients);
  const clients = await db
    .select({ id: schema.clients.id })
    .from(schema.clients)
    .where(eq(schema.clients.orgId, actor.orgId));
  const levels = new Map<string, AccessLevel>(clients.map((c) => [c.id, base]));
  if (base === 'edit_passwords') return levels;
  const memberOf = db
    .select({ id: schema.groupMembers.groupId })
    .from(schema.groupMembers)
    .where(eq(schema.groupMembers.userId, actor.id));
  const grants = await db
    .select({ clientId: schema.clientAccess.clientId, level: schema.clientAccess.level })
    .from(schema.clientAccess)
    .where(
      or(
        eq(schema.clientAccess.userId, actor.id),
        and(isNotNull(schema.clientAccess.groupId), inArray(schema.clientAccess.groupId, memberOf)),
      ),
    );
  for (const grant of grants) {
    const current = levels.get(grant.clientId);
    if (current !== undefined) levels.set(grant.clientId, minLevel(maxLevel(current, grant.level as AccessLevel), cap));
  }
  return levels;
}

/**
 * Loads a client the actor may use at the required level.
 * No access at all looks exactly like a missing client (404); read-only access asking to write gets 403.
 */
export async function requireClient(db: Database, actor: Actor, clientId: string, required: AccessLevel) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
    throw new HttpError(404, 'Client not found.');
  const [client] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.id, sql`${clientId}::uuid`), eq(schema.clients.orgId, actor.orgId)));
  const level = client ? ((await clientLevels(db, actor)).get(client.id) ?? 'none') : 'none';
  if (!client || level === 'none') throw new HttpError(404, 'Client not found.');
  if (!atLeast(level, required)) throw new HttpError(403, 'Your access to this client is read-only.');
  return { client, level };
}

export function requireAdmin(actor: Actor) {
  if (!ROLE_INFO[actor.role].admin) throw new HttpError(403, 'Administrator access is required.');
}

/** Creating clients affects everyone's workspace, so it needs edit access to all clients. */
export function requireAllClientsEdit(actor: Actor) {
  if (!atLeast(baselineLevel(actor.role, actor.allClients), 'edit'))
    throw new HttpError(403, 'Adding clients needs edit access to all clients.');
}
