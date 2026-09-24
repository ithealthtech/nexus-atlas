import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, type ItemRef, type ItemType } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { isUuid, type Scope } from './scope.js';

/** Loads any linkable item's summary within the organization, or null. Access is checked by the caller. */
export async function loadItem(
  db: Database,
  orgId: string,
  type: ItemType,
  id: string,
): Promise<(ItemRef & { archived: boolean }) | null> {
  if (!isUuid(id)) return null;
  const clientName = schema.clients.name;
  if (type === 'password') {
    const [r] = await db
      .select({ p: schema.passwords, clientName })
      .from(schema.passwords)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.passwords.clientId))
      .where(eq(schema.passwords.id, id));
    return r && r.p.orgId === orgId
      ? {
          type,
          id,
          title: r.p.name,
          subtitle: r.p.kind === 'bitlocker' ? 'BitLocker key' : 'Password',
          clientId: r.p.clientId,
          clientName: r.clientName,
          archived: r.p.archived,
        }
      : null;
  }
  if (type === 'asset') {
    const [r] = await db
      .select({ a: schema.assets, layout: schema.assetLayouts.name, clientName })
      .from(schema.assets)
      .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
      .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
      .where(eq(schema.assets.id, id));
    return r && r.a.orgId === orgId
      ? {
          type,
          id,
          title: r.a.name,
          subtitle: r.layout,
          clientId: r.a.clientId,
          clientName: r.clientName,
          archived: r.a.archived,
        }
      : null;
  }
  if (type === 'document') {
    const [r] = await db
      .select({ d: schema.documents, clientName })
      .from(schema.documents)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.documents.clientId))
      .where(eq(schema.documents.id, id));
    return r && r.d.orgId === orgId
      ? {
          type,
          id,
          title: r.d.title,
          subtitle: r.d.clientId ? 'Document' : 'Knowledge base',
          clientId: r.d.clientId,
          clientName: r.clientName,
          archived: r.d.archived,
        }
      : null;
  }
  if (type === 'contact') {
    const [r] = await db
      .select({ c: schema.contacts, clientName })
      .from(schema.contacts)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.contacts.clientId))
      .where(eq(schema.contacts.id, id));
    return r && r.c.orgId === orgId
      ? {
          type,
          id,
          title: r.c.name,
          subtitle: r.c.title || 'Contact',
          clientId: r.c.clientId,
          clientName: r.clientName,
          archived: false,
        }
      : null;
  }
  const [r] = await db
    .select({ l: schema.locations, clientName })
    .from(schema.locations)
    .innerJoin(schema.clients, eq(schema.clients.id, schema.locations.clientId))
    .where(eq(schema.locations.id, id));
  return r && r.l.orgId === orgId
    ? {
        type,
        id,
        title: r.l.name,
        subtitle: r.l.city || 'Location',
        clientId: r.l.clientId,
        clientName: r.clientName,
        archived: false,
      }
    : null;
}

/** Loads an item the actor may use at the given level (404 when missing or not visible). */
export async function requireItem(scope: Scope, type: ItemType, id: string, level: 'read' | 'edit') {
  const item = await loadItem(scope.db, scope.actor.orgId, type, id);
  if (!item || !(await canSee(scope, item))) throw new HttpError(404, 'Item not found.');
  await scope.require(item.clientId, level);
  return item;
}

/**
 * Whether the actor may see an item at all. Passwords need "edit + passwords" access to their client,
 * and restricted ones need an admin or a place on the item's list.
 */
export async function canSee(
  scope: Scope,
  item: { type: ItemRef['type']; id: string; clientId: string | null },
): Promise<boolean> {
  const level = await scope.level(item.clientId);
  if (level === 'none') return false;
  if (item.type !== 'password') return true;
  if (level !== 'edit_passwords') return false;
  const [row] = await scope.db
    .select({ restricted: schema.passwords.restricted })
    .from(schema.passwords)
    .where(eq(schema.passwords.id, item.id));
  if (!row?.restricted || ROLE_INFO[scope.actor.role].admin) return true;
  return (await allowedRestricted(scope, [item.id])).has(item.id);
}

/** Which of these restricted passwords the actor is listed on, directly or through a group. */
export async function allowedRestricted(scope: Scope, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const direct = scope.db
    .select({ id: schema.passwordAccess.passwordId })
    .from(schema.passwordAccess)
    .where(and(inArray(schema.passwordAccess.passwordId, ids), eq(schema.passwordAccess.userId, scope.actor.id)));
  const viaGroup = scope.db
    .select({ id: schema.passwordGroupAccess.passwordId })
    .from(schema.passwordGroupAccess)
    .innerJoin(schema.groupMembers, eq(schema.groupMembers.groupId, schema.passwordGroupAccess.groupId))
    .where(and(inArray(schema.passwordGroupAccess.passwordId, ids), eq(schema.groupMembers.userId, scope.actor.id)));
  const rows = [...(await direct), ...(await viaGroup)];
  return new Set(rows.map((r) => r.id));
}
