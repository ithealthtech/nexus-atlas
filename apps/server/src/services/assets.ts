import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import { assetSchema, updateAssetSchema, type AssetView, type LayoutField, type RevisionView } from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { DomainLookup } from './domain-lookup.js';
import type { WarrantyLookup } from './warranty-lookup.js';
import { recordActivity } from './activity.js';
import { validateFields, type LayoutService } from './layouts.js';
import { detectManufacturer } from './manufacturer.js';
import { getRevision, listRevisions, snapshot } from './revisions.js';
import { isUuid, type Scope } from './scope.js';

type Snapshot = {
  name: string;
  status: AssetView['status'];
  fields: Record<string, unknown>;
  notes: string;
  /** Set on a version that moved the asset to another layout: the layout it moved to, and the one it left. */
  layoutId?: string;
  fromLayoutId?: string;
};
const editor = alias(schema.users, 'editor');

// Domains-layout fields a lookup can fill, with the field type each needs.
const DETECTED: Record<string, LayoutField['type'][]> = {
  registrar: ['text'],
  expires: ['date', 'text'],
  nameservers: ['textarea', 'text'],
  dns_host: ['text'],
};
const blank = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The layout's manufacturer field: keyed "manufacturer", or a text field labelled Manufacturer or Make. */
export const manufacturerField = (fields: LayoutField[]) =>
  fields.find((f) => f.type === 'text' && (f.key === 'manufacturer' || /^(manufacturer|make)$/i.test(f.label.trim())));

/** Fills a blank manufacturer from the model, operating system, name, hostname, or MAC address. */
export function withManufacturer(layoutFields: LayoutField[], name: string, fields: Record<string, unknown>) {
  const field = manufacturerField(layoutFields);
  if (!field || !blank(fields[field.key])) return fields;
  const found = detectManufacturer({
    model: str(fields.model),
    os: str(fields.operating_system),
    name,
    hostname: str(fields.hostname),
    mac: str(fields.mac_address),
  });
  return found ? { ...fields, [field.key]: found } : fields;
}

export class AssetService {
  constructor(
    private readonly layouts: LayoutService,
    private readonly domains?: DomainLookup,
    private readonly warranty?: WarrantyLookup,
  ) {}

  /**
   * Fills a blank manufacturer from what else is known about the device. For the built-in Domains layout, fills
   * blank fields (registrar, expiry, name servers, DNS host)
   * from the asset's name. Fills a blank warranty date from the vendor, by serial number.
   * Never overwrites what someone entered, and never blocks a save.
   */
  private async detect(
    orgId: string,
    layout: { key: string; fields: unknown },
    name: string,
    given: Record<string, unknown>,
  ) {
    let fields = withManufacturer(layout.fields as LayoutField[], name, given);
    if (this.warranty) fields = await this.warranty.fill(orgId, layout.fields as LayoutField[], name, fields);
    if (!this.domains || layout.key !== 'domain') return fields;
    const layoutFields = layout.fields as LayoutField[];
    const targets = layoutFields.filter((f) => DETECTED[f.key]?.includes(f.type) && blank(fields[f.key]));
    if (!targets.length) return fields;
    const found = await this.domains.lookup(name);
    if (!found) return fields;
    const merged = { ...fields };
    for (const f of targets) {
      const value = found[f.key as keyof typeof found];
      if (value) merged[f.key] = value;
    }
    try {
      return validateFields(layoutFields, merged);
    } catch {
      return fields;
    }
  }

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
    const fields = await this.detect(
      scope.actor.orgId,
      layout,
      body.name,
      validateFields(layout.fields as LayoutField[], body.fields),
    );
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
    const name = body.name ?? current.name;
    const next: Snapshot = {
      name,
      status: body.status ?? current.status,
      fields: await this.detect(
        scope.actor.orgId,
        layout,
        name,
        body.fields ? validateFields(layout.fields as LayoutField[], body.fields) : current.fields,
      ),
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

  /**
   * Moves an asset to another layout with the given fields (checked against that layout), as a new version. Its
   * relations, passwords, and history stay with it.
   */
  async moveToLayout(
    scope: Scope,
    id: string,
    input: {
      layoutId: string;
      fields: Record<string, unknown>;
      version: number;
      name?: string;
      status?: AssetView['status'];
      notes?: string;
    },
    action = 'Moved',
  ): Promise<AssetView> {
    const current = await this.get(scope, id);
    await scope.require(current.clientId, 'edit', 'Asset');
    if (input.version !== current.version)
      throw new HttpError(
        409,
        'Someone else changed this asset. Reload to see their changes before saving.',
        'conflict',
      );
    const layout = await this.layouts.get(scope.actor, input.layoutId);
    if (layout.archived) throw new HttpError(400, 'That asset layout is archived.');
    const name = input.name ?? current.name;
    const next: Snapshot = {
      name,
      status: input.status ?? current.status,
      fields: await this.detect(
        scope.actor.orgId,
        layout,
        name,
        validateFields(layout.fields as LayoutField[], input.fields),
      ),
      notes: input.notes ?? current.notes,
      layoutId: layout.id,
      fromLayoutId: current.layoutId,
    };
    await scope.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.assets)
        .set({
          name: next.name,
          status: next.status,
          fields: next.fields,
          notes: next.notes,
          layoutId: layout.id,
          version: current.version + 1,
          updatedBy: scope.actor.id,
          updatedAt: new Date(),
        })
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

  /**
   * Fills in the manufacturer of every asset, in the clients the actor can edit, where it's blank and can be
   * worked out. Each change is saved as a new version, so it can be reviewed and undone.
   */
  async fillManufacturers(scope: Scope): Promise<{ checked: number; filled: number }> {
    const layouts = (
      await scope.db
        .select({ id: schema.assetLayouts.id, fields: schema.assetLayouts.fields })
        .from(schema.assetLayouts)
        .where(eq(schema.assetLayouts.orgId, scope.actor.orgId))
    )
      .map((l) => ({
        id: l.id,
        fields: l.fields as LayoutField[],
        field: manufacturerField(l.fields as LayoutField[]),
      }))
      .filter((l) => l.field);
    const clientIds = await scope.readableClientIds();
    let checked = 0;
    let filled = 0;
    if (!layouts.length || !clientIds.length) return { checked, filled };
    const rows = await scope.db
      .select({
        id: schema.assets.id,
        name: schema.assets.name,
        clientId: schema.assets.clientId,
        layoutId: schema.assets.layoutId,
        fields: schema.assets.fields,
      })
      .from(schema.assets)
      .where(
        and(
          eq(schema.assets.orgId, scope.actor.orgId),
          eq(schema.assets.archived, false),
          inArray(
            schema.assets.layoutId,
            layouts.map((l) => l.id),
          ),
          inArray(schema.assets.clientId, clientIds),
        ),
      );
    for (const r of rows) {
      const layout = layouts.find((l) => l.id === r.layoutId)!;
      const fields = r.fields as Record<string, unknown>;
      if (!blank(fields[layout.field!.key])) continue;
      checked++;
      if (withManufacturer(layout.fields, r.name, fields) === fields) continue;
      if ((await scope.level(r.clientId)) === 'read') continue;
      const current = await this.get(scope, r.id);
      await this.update(scope, r.id, { fields: current.fields, version: current.version }, 'Manufacturer detected');
      filled++;
    }
    return { checked, filled };
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
    const action = `Restored version ${version} of`;
    // A version from before a move to another layout goes back to the layout it was in, if that is still in use.
    const layoutId = await this.layoutAt(scope, id, version);
    const current = await this.get(scope, id);
    if (layoutId && layoutId !== current.layoutId) {
      const layout = await this.layouts.get(scope.actor, layoutId).catch(() => null);
      if (layout && !layout.archived)
        return this.moveToLayout(
          scope,
          id,
          {
            layoutId,
            fields: old.fields,
            version: expectedVersion,
            name: old.name,
            status: old.status,
            notes: old.notes,
          },
          action,
        );
    }
    // Restoring appends a new version; history is never rewritten. Fields removed from the layout since then are dropped.
    const { name, status, fields, notes } = old;
    return this.update(scope, id, { name, status, fields, notes, version: expectedVersion }, action);
  }

  /** The layout an asset was in at a version, from the versions that moved it; null when it never moved. */
  private async layoutAt(scope: Scope, id: string, version: number): Promise<string | null> {
    const moves = (
      await scope.db
        .select({ version: schema.revisions.version, snapshot: schema.revisions.snapshot })
        .from(schema.revisions)
        .where(and(eq(schema.revisions.entityType, 'asset'), eq(schema.revisions.entityId, id)))
        .orderBy(asc(schema.revisions.version))
    ).filter((r) => (r.snapshot as Snapshot).layoutId);
    const before = moves.filter((r) => r.version <= version).at(-1);
    if (before) return (before.snapshot as Snapshot).layoutId!;
    return (moves[0]?.snapshot as Snapshot | undefined)?.fromLayoutId ?? null;
  }
}
