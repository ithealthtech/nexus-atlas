import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import { assetSchema, updateAssetSchema, type AssetView, type LayoutField, type RevisionView } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { validateFields, type LayoutService } from './layouts.js';
import { getRevision, listRevisions, snapshot } from './revisions.js';
import { isUuid, type Scope } from './scope.js';

type Snapshot = { name: string; status: AssetView['status']; fields: Record<string, unknown>; notes: string };
const editor = alias(schema.users, 'editor');

export class AssetService {
  constructor(private readonly layouts: LayoutService) {}

  private select(scope: Scope) {
    return scope.db
      .select({
        a: schema.assets,
        clientName: schema.clients.name,
        layoutName: schema.assetLayouts.name,
        layoutIcon: schema.assetLayouts.icon,
        editor: editor.name,
      })
      .from(schema.assets)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
      .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
      .leftJoin(editor, eq(editor.id, schema.assets.updatedBy));
  }
  private view(r: {
    a: typeof schema.assets.$inferSelect;
    clientName: string;
    layoutName: string;
    layoutIcon: string;
    editor: string | null;
  }): AssetView {
    return {
      id: r.a.id,
      clientId: r.a.clientId,
      clientName: r.clientName,
      layoutId: r.a.layoutId,
      layoutName: r.layoutName,
      layoutIcon: r.layoutIcon,
      name: r.a.name,
      status: r.a.status as AssetView['status'],
      fields: r.a.fields as Record<string, unknown>,
      notes: r.a.notes,
      version: r.a.version,
      archived: r.a.archived,
      updatedAt: r.a.updatedAt.toISOString(),
      updatedByName: r.editor,
    };
  }

  async list(scope: Scope, filter: { clientId?: string; layoutId?: string; archived?: boolean }): Promise<AssetView[]> {
    const conditions: SQL[] = [
      eq(schema.assets.orgId, scope.actor.orgId),
      eq(schema.assets.archived, !!filter.archived),
    ];
    if (filter.clientId) {
      await scope.require(filter.clientId, 'read', 'Client');
      conditions.push(eq(schema.assets.clientId, filter.clientId));
    } else {
      const ids = await scope.readableClientIds();
      if (!ids.length) return [];
      conditions.push(inArray(schema.assets.clientId, ids));
    }
    if (filter.layoutId) {
      if (!isUuid(filter.layoutId)) return [];
      conditions.push(eq(schema.assets.layoutId, filter.layoutId));
    }
    const rows = await this.select(scope)
      .where(and(...conditions))
      .orderBy(asc(sql`lower(${schema.assets.name})`))
      .limit(2000);
    return rows.map((r) => this.view(r));
  }

  async get(scope: Scope, id: string): Promise<AssetView> {
    const [row] = isUuid(id)
      ? await this.select(scope).where(and(eq(schema.assets.id, id), eq(schema.assets.orgId, scope.actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'Asset not found.');
    await scope.require(row.a.clientId, 'read', 'Asset');
    return this.view(row);
  }

  async create(scope: Scope, clientId: string, input: unknown): Promise<AssetView> {
    await scope.require(clientId, 'edit', 'Client');
    const body = assetSchema.parse(input);
    const layout = await this.layouts.get(scope.actor, body.layoutId);
    if (layout.archived) throw new HttpError(400, 'That asset layout is archived.');
    const fields = validateFields(layout.fields as LayoutField[], body.fields);
    const id = await scope.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.assets)
        .values({
          orgId: scope.actor.orgId,
          clientId,
          layoutId: layout.id,
          name: body.name,
          status: body.status,
          fields,
          notes: body.notes,
          createdBy: scope.actor.id,
          updatedBy: scope.actor.id,
        })
        .returning({ id: schema.assets.id });
      await snapshot(tx, scope.actor, 'asset', row!.id, 1, {
        name: body.name,
        status: body.status,
        fields,
        notes: body.notes,
      } satisfies Snapshot);
      await recordActivity(tx, scope.actor, {
        clientId,
        action: 'Created',
        entityType: 'asset',
        entityId: row!.id,
        title: body.name,
      });
      return row!.id;
    });
    return this.get(scope, id);
  }

  async update(scope: Scope, id: string, input: unknown, action = 'Updated'): Promise<AssetView> {
    const current = await this.get(scope, id);
    await scope.require(current.clientId, 'edit', 'Asset');
    const body = updateAssetSchema.parse(input);
    if (body.version !== current.version)
      throw new HttpError(
        409,
        'Someone else changed this asset. Reload to see their changes before saving.',
        'conflict',
      );
    const layout = await this.layouts.get(scope.actor, current.layoutId);
    const next: Snapshot = {
      name: body.name ?? current.name,
      status: body.status ?? current.status,
      fields: body.fields ? validateFields(layout.fields as LayoutField[], body.fields) : current.fields,
      notes: body.notes ?? current.notes,
    };
    await scope.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.assets)
        .set({ ...next, version: current.version + 1, updatedBy: scope.actor.id, updatedAt: new Date() })
        .where(and(eq(schema.assets.id, id), eq(schema.assets.version, current.version)))
        .returning({ id: schema.assets.id });
      if (!updated.length)
        throw new HttpError(
          409,
          'Someone else changed this asset. Reload to see their changes before saving.',
          'conflict',
        );
      await snapshot(tx, scope.actor, 'asset', id, current.version + 1, next);
      await recordActivity(tx, scope.actor, {
        clientId: current.clientId,
        action,
        entityType: 'asset',
        entityId: id,
        title: next.name,
      });
    });
    return this.get(scope, id);
  }

  async setArchived(scope: Scope, id: string, archived: boolean): Promise<AssetView> {
    const current = await this.get(scope, id);
    await scope.require(current.clientId, 'edit', 'Asset');
    await scope.db.transaction(async (tx) => {
      await tx
        .update(schema.assets)
        .set({ archived, updatedBy: scope.actor.id, updatedAt: new Date() })
        .where(eq(schema.assets.id, id));
      await recordActivity(tx, scope.actor, {
        clientId: current.clientId,
        action: archived ? 'Archived' : 'Restored',
        entityType: 'asset',
        entityId: id,
        title: current.name,
      });
    });
    return this.get(scope, id);
  }

  async revisions(scope: Scope, id: string): Promise<RevisionView[]> {
    await this.get(scope, id);
    return listRevisions(scope.db, 'asset', id);
  }

  async revision(scope: Scope, id: string, version: number): Promise<Snapshot> {
    await this.get(scope, id);
    return getRevision<Snapshot>(scope.db, 'asset', id, version);
  }

  async restore(scope: Scope, id: string, version: number, expectedVersion: number): Promise<AssetView> {
    const old = await this.revision(scope, id, version);
    // Restoring appends a new version; history is never rewritten. Fields removed from the layout since then are dropped.
    return this.update(scope, id, { ...old, version: expectedVersion }, `Restored version ${version} of`);
  }
}
