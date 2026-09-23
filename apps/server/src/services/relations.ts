import { and, eq, or } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { relationSchema, type ItemType, type RelationView } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { loadItem, requireItem } from './items.js';
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
    const out: RelationView[] = [];
    for (const r of rows) {
      const [otherType, otherId] = r.aId === id ? [r.bType, r.bId] : [r.aType, r.aId];
      const item = await loadItem(scope.db, scope.actor.orgId, otherType as ItemType, otherId);
      if (!item || item.archived || (await scope.level(item.clientId)) === 'none') continue;
      const { archived: _archived, ...ref } = item;
      out.push({ ...ref, relationId: r.id, note: r.note });
    }
    return out.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
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
