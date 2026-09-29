import { and, eq, inArray, or } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { relationSchema, type ItemType, type RelationView, type RelationshipMap } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { requireItem, visibleItems } from './items.js';
import type { Scope } from './scope.js';

const order = (x: { type: string; id: string }, y: { type: string; id: string }) =>
  `${x.type}:${x.id}` < `${y.type}:${y.id}` ? [x, y] : [y, x];

export class RelationService {
  /** Items linked to this one that the actor can see. */
  async list(scope: Scope, type: ItemType, id: string): Promise<RelationView[]> {
    await requireItem(scope, type, id, 'read');
    const rows = await scope.db
      .select()
      .from(schema.relations)
      .where(
        and(
          eq(schema.relations.orgId, scope.actor.orgId),
          or(
            and(eq(schema.relations.aType, type), eq(schema.relations.aId, id)),
            and(eq(schema.relations.bType, type), eq(schema.relations.bId, id)),
          ),
        ),
      );
    const others = rows.map((r) => (r.aId === id ? { type: r.bType, id: r.bId } : { type: r.aType, id: r.aId }));
    const visible = await visibleItems(scope, others);
    const out: RelationView[] = [];
    rows.forEach((r, i) => {
      const ref = visible.get(`${others[i]!.type}:${others[i]!.id}`);
      if (ref) out.push({ ...ref, relationId: r.id, note: r.note });
    });
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
  }

  /**
   * Every link that touches one of the client's items, with the items on both ends. Items the actor can't see
   * (passwords they lack access to, archived items) are left out, along with their links.
   */
  async map(scope: Scope, clientId: string): Promise<RelationshipMap> {
    await scope.require(clientId, 'read', 'Client');
    const orgId = scope.actor.orgId;
    const inClient = (
      await Promise.all([
        scope.db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.clientId, clientId)),
        scope.db
          .select({ id: schema.documents.id })
          .from(schema.documents)
          .where(eq(schema.documents.clientId, clientId)),
        scope.db.select({ id: schema.contacts.id }).from(schema.contacts).where(eq(schema.contacts.clientId, clientId)),
        scope.db
          .select({ id: schema.locations.id })
          .from(schema.locations)
          .where(eq(schema.locations.clientId, clientId)),
        scope.db
          .select({ id: schema.passwords.id })
          .from(schema.passwords)
          .where(eq(schema.passwords.clientId, clientId)),
      ])
    ).flatMap((rows) => rows.map((r) => r.id));
    if (!inClient.length) return { nodes: [], edges: [] };
    const rows = await scope.db
      .select()
      .from(schema.relations)
      .where(
        and(
          eq(schema.relations.orgId, orgId),
          or(inArray(schema.relations.aId, inClient), inArray(schema.relations.bId, inClient)),
        ),
      );
    // Every endpoint's visibility in one pass (a query per type), not a round trip per item.
    const seen = await visibleItems(
      scope,
      rows.flatMap((r) => [
        { type: r.aType, id: r.aId },
        { type: r.bType, id: r.bId },
      ]),
    );
    const edges: RelationshipMap['edges'] = [];
    const used = new Set<string>();
    for (const rel of rows) {
      const [a, b] = [seen.get(`${rel.aType}:${rel.aId}`), seen.get(`${rel.bType}:${rel.bId}`)];
      if (!a || !b) continue;
      edges.push({ id: rel.id, from: `${a.type}:${a.id}`, to: `${b.type}:${b.id}`, note: rel.note });
      used.add(`${a.type}:${a.id}`).add(`${b.type}:${b.id}`);
    }
    const nodes = [...used]
      .map((k) => seen.get(k)!)
      .sort((x, y) => x.type.localeCompare(y.type) || x.title.localeCompare(y.title));
    return { nodes, edges };
  }

  async add(scope: Scope, type: ItemType, id: string, input: unknown): Promise<RelationView[]> {
    const body = relationSchema.parse(input);
    const source = await requireItem(scope, type, id, 'edit');
    const target = await requireItem(scope, body.type, body.id, 'read');
    if (source.id === target.id) throw new HttpError(400, 'An item cannot be linked to itself.');
    // Client items link within their client; MSP knowledge-base articles may link to any client item.
    if (source.clientId && target.clientId && source.clientId !== target.clientId)
      throw new HttpError(400, 'Link items from the same client.');
    const [a, b] = order({ type, id }, { type: body.type, id: body.id });
    await scope.db.transaction(async (tx) => {
      await tx
        .insert(schema.relations)
        .values({
          orgId: scope.actor.orgId,
          aType: a!.type,
          aId: a!.id,
          bType: b!.type,
          bId: b!.id,
          note: body.note,
          createdBy: scope.actor.id,
        })
        .onConflictDoNothing();
      await recordActivity(tx, scope.actor, {
        clientId: source.clientId ?? target.clientId,
        action: 'Linked',
        entityType: type,
        entityId: id,
        title: `${source.title} ↔ ${target.title}`,
      });
    });
    return this.list(scope, type, id);
  }

  async remove(scope: Scope, type: ItemType, id: string, relationId: string): Promise<RelationView[]> {
    const source = await requireItem(scope, type, id, 'edit');
    const deleted = await scope.db
      .delete(schema.relations)
      .where(
        and(
          eq(schema.relations.id, relationId),
          eq(schema.relations.orgId, scope.actor.orgId),
          or(
            and(eq(schema.relations.aType, type), eq(schema.relations.aId, id)),
            and(eq(schema.relations.bType, type), eq(schema.relations.bId, id)),
          ),
        ),
      )
      .returning();
    if (!deleted.length) throw new HttpError(404, 'Link not found.');
    await recordActivity(scope.db, scope.actor, {
      clientId: source.clientId,
      action: 'Unlinked',
      entityType: type,
      entityId: id,
      title: source.title,
    });
    return this.list(scope, type, id);
  }
}
