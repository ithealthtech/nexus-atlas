import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  MAX_LAYOUT_FIELDS,
  mergeDuplicatesSchema,
  type Actor,
  type DuplicateGroup,
  type DuplicateType,
  type LayoutField,
  type MergeResult,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { AssetService } from './assets.js';
import { LayoutService } from './layouts.js';
import { Scope } from './scope.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const key = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const norm = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');
const present = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
const ITEM_TYPE: Record<Exclude<DuplicateType, 'clients'>, string> = {
  assets: 'asset',
  contacts: 'contact',
  locations: 'location',
};

/** Groups of records that look like the same thing. Archived assets are left out. */
export async function findDuplicates(db: Database, orgId: string): Promise<DuplicateGroup[]> {
  const groups: DuplicateGroup[] = [];
  const clientRows = await db
    .select({
      id: schema.clients.id,
      name: schema.clients.name,
      createdAt: schema.clients.createdAt,
      updatedAt: schema.clients.updatedAt,
    })
    .from(schema.clients)
    .where(eq(schema.clients.orgId, orgId));
  const clientName = new Map(clientRows.map((c) => [c.id, c.name]));
  const push = <T extends { id: string; name: string; createdAt: Date; updatedAt: Date }>(
    type: DuplicateType,
    rows: (T & { clientId: string | null })[],
    detail: (r: T) => string,
    filled: (r: T) => number,
  ) => {
    const by = new Map<string, (T & { clientId: string | null })[]>();
    for (const r of rows) {
      const k = `${r.clientId ?? ''}|${key(r.name)}`;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    for (const list of by.values())
      if (list.length > 1)
        groups.push({
          type,
          name: list[0]!.name,
          clientId: list[0]!.clientId,
          clientName: list[0]!.clientId ? (clientName.get(list[0]!.clientId) ?? null) : null,
          items: list.map((r) => ({
            id: r.id,
            name: r.name,
            detail: detail(r),
            filled: filled(r),
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
          })),
        });
  };

  // Clients: how much each holds helps pick the one to keep.
  const counts = new Map<string, number>();
  for (const table of [schema.assets, schema.contacts, schema.locations, schema.passwords, schema.documents])
    for (const r of (await db
      .select({ id: table.clientId, n: sql<number>`count(*)::int` })
      .from(table)
      .where(eq(table.orgId, orgId))
      .groupBy(table.clientId)) as { id: string | null; n: number }[])
      if (r.id) counts.set(r.id, (counts.get(r.id) ?? 0) + r.n);
  push(
    'clients',
    clientRows.map((c) => ({ ...c, clientId: null })),
    (c) => `${counts.get(c.id) ?? 0} items`,
    (c) => counts.get(c.id) ?? 0,
  );

  const layouts = new Map(
    (
      await db
        .select({ id: schema.assetLayouts.id, name: schema.assetLayouts.name })
        .from(schema.assetLayouts)
        .where(eq(schema.assetLayouts.orgId, orgId))
    ).map((l) => [l.id, l.name]),
  );
  push(
    'assets',
    await db
      .select({
        id: schema.assets.id,
        name: schema.assets.name,
        clientId: schema.assets.clientId,
        layoutId: schema.assets.layoutId,
        fields: schema.assets.fields,
        createdAt: schema.assets.createdAt,
        updatedAt: schema.assets.updatedAt,
      })
      .from(schema.assets)
      .where(and(eq(schema.assets.orgId, orgId), eq(schema.assets.archived, false))),
    (a) => layouts.get(a.layoutId) ?? 'Asset',
    (a) => Object.values((a.fields ?? {}) as Record<string, unknown>).filter(present).length,
  );
  push(
    'contacts',
    await db.select().from(schema.contacts).where(eq(schema.contacts.orgId, orgId)),
    (c) => c.email || c.phone || c.title || 'Contact',
    (c) => [c.title, c.email, c.phone, c.mobile, c.notes].filter(Boolean).length,
  );
  push(
    'locations',
    await db.select().from(schema.locations).where(eq(schema.locations.orgId, orgId)),
    (l) => [l.address, l.city].filter(Boolean).join(', ') || 'Location',
    (l) => [l.address, l.city, l.region, l.postalCode, l.country, l.phone, l.notes].filter(Boolean).length,
  );
  return groups.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

/**
 * Points links, attachments, and import/sync IDs at the kept record: links that would join it to itself, or
 * repeat one it already has, are dropped.
 */
async function repoint(tx: Tx, orgId: string, itemType: string, refKind: string, keepId: string, mergeIds: string[]) {
  const r = schema.relations;
  const links = await tx
    .select()
    .from(r)
    .where(
      and(
        eq(r.orgId, orgId),
        or(and(eq(r.aType, itemType), inArray(r.aId, mergeIds)), and(eq(r.bType, itemType), inArray(r.bId, mergeIds))),
      ),
    );
  for (const link of links) {
    const swap = (type: string, id: string) => ({ type, id: type === itemType && mergeIds.includes(id) ? keepId : id });
    const [a, b] = [swap(link.aType, link.aId), swap(link.bType, link.bId)].sort((x, y) =>
      `${x.type}:${x.id}` < `${y.type}:${y.id}` ? -1 : 1,
    );
    const same = a!.type === b!.type && a!.id === b!.id;
    const [taken] = same
      ? [undefined]
      : await tx
          .select({ id: r.id })
          .from(r)
          .where(and(eq(r.aType, a!.type), eq(r.aId, a!.id), eq(r.bType, b!.type), eq(r.bId, b!.id)));
    if (same || taken) await tx.delete(r).where(eq(r.id, link.id));
    else await tx.update(r).set({ aType: a!.type, aId: a!.id, bType: b!.type, bId: b!.id }).where(eq(r.id, link.id));
  }
  await tx
    .update(schema.attachments)
    .set({ entityId: keepId })
    .where(
      and(
        eq(schema.attachments.orgId, orgId),
        eq(schema.attachments.entityType, itemType),
        inArray(schema.attachments.entityId, mergeIds),
      ),
    );
  // Hudu and ConnectWise RMM update the kept record from now on.
  await tx
    .update(schema.externalRefs)
    .set({ entityId: keepId })
    .where(
      and(
        eq(schema.externalRefs.orgId, orgId),
        eq(schema.externalRefs.kind, refKind),
        inArray(schema.externalRefs.entityId, mergeIds),
      ),
    );
}

const joinNotes = (keep: string | null, others: (string | null)[]) => {
  const parts = [keep ?? '', ...others.map((n) => n ?? '')].map((n) => n.trim()).filter(Boolean);
  return [...new Set(parts)].join('\n\n').slice(0, 20000);
};

/** Merges records into one; see each type below. Administrators only. */
export async function mergeDuplicates(db: Database, actor: Actor, input: unknown): Promise<MergeResult> {
  const body = mergeDuplicatesSchema.parse(input);
  const mergeIds = [...new Set(body.mergeIds)].filter((id) => id !== body.keepId);
  if (!mergeIds.length) throw new HttpError(400, 'Choose at least one other record to merge into the one you keep.');
  const orgId = actor.orgId;
  if (body.type === 'clients') return mergeClients(db, actor, body.keepId, mergeIds);
  if (body.type === 'assets') return mergeAssets(db, actor, body.keepId, mergeIds);
  return mergePeopleOrPlaces(db, actor, body.type, body.keepId, mergeIds, orgId);
}

/** Contacts and locations: blank details are filled from the others, notes joined, links moved; the others go. */
async function mergePeopleOrPlaces(
  db: Database,
  actor: Actor,
  type: 'contacts' | 'locations',
  keepId: string,
  mergeIds: string[],
  orgId: string,
): Promise<MergeResult> {
  const table = type === 'contacts' ? schema.contacts : schema.locations;
  const rows = await db
    .select()
    .from(table)
    .where(and(eq(table.orgId, orgId), inArray(table.id, [keepId, ...mergeIds])));
  const keep = rows.find((r) => r.id === keepId);
  const others = rows.filter((r) => r.id !== keepId);
  if (!keep || others.length !== mergeIds.length) throw new HttpError(404, 'Some of those records no longer exist.');
  if (others.some((o) => o.clientId !== keep.clientId)) throw new HttpError(400, 'Merge records from the same client.');
  const detailKeys =
    type === 'contacts'
      ? (['title', 'email', 'phone', 'mobile'] as const)
      : (['address', 'city', 'region', 'postalCode', 'country', 'phone'] as const);
  const set: Record<string, unknown> = {
    notes: joinNotes(
      keep.notes,
      others.map((o) => o.notes),
    ),
    updatedAt: new Date(),
  };
  for (const k of detailKeys) {
    const current = (keep as Record<string, unknown>)[k];
    const fill = others.map((o) => (o as Record<string, unknown>)[k]).find(present);
    if (!present(current) && fill) set[k] = fill;
  }
  if (others.some((o) => o.primary)) set.primary = true;
  await db.transaction(async (tx) => {
    await tx.update(table).set(set).where(eq(table.id, keepId));
    await repoint(tx, orgId, ITEM_TYPE[type], type, keepId, mergeIds);
    await tx.delete(table).where(inArray(table.id, mergeIds));
    await recordActivity(tx, actor, {
      clientId: keep.clientId,
      action: `Merged ${mergeIds.length + 1} duplicates into`,
      entityType: ITEM_TYPE[type],
      entityId: keepId,
      title: keep.name,
    });
  });
  return { keptId: keepId, merged: mergeIds.length, fieldsAdded: [] };
}

/**
 * Assets: values from the others fill the kept asset's blank fields, matched by field key or label; a value its
 * layout has no field for gets a new field on that layout. Notes are joined, links and files moved, and the others
 * are archived (restorable) with a note saying where they went.
 */
async function mergeAssets(db: Database, actor: Actor, keepId: string, mergeIds: string[]): Promise<MergeResult> {
  const scope = new Scope(db, actor);
  const layoutService = new LayoutService(db);
  const assets = new AssetService(layoutService);
  const keep = await assets.get(scope, keepId);
  const others = await Promise.all(mergeIds.map((id) => assets.get(scope, id)));
  if (others.some((o) => o.clientId !== keep.clientId)) throw new HttpError(400, 'Merge assets from the same client.');

  const layoutFields = async (id: string) => (await layoutService.get(actor, id)).fields as LayoutField[];
  let target = await layoutFields(keep.layoutId);
  const fields: Record<string, unknown> = { ...keep.fields };
  const added: LayoutField[] = [];
  const used = new Set(target.map((f) => f.key));
  for (const other of others) {
    const theirs = await layoutFields(other.layoutId);
    for (const [k, value] of Object.entries(other.fields)) {
      if (!present(value)) continue;
      const label = theirs.find((f) => f.key === k)?.label ?? k.replace(/_/g, ' ');
      let field =
        target.find((f) => f.key === k) ??
        target.find((f) => norm(f.label) === norm(label)) ??
        added.find((f) => norm(f.label) === norm(label));
      if (!field && target.length + added.length < MAX_LAYOUT_FIELDS) {
        let fieldKey = k;
        for (let n = 2; used.has(fieldKey); n++) fieldKey = `${k.slice(0, 36)}_${n}`;
        used.add(fieldKey);
        // Same type when it's a plain one; choice lists and the like become text, so any value fits.
        const source = theirs.find((f) => f.key === k);
        const type =
          source && ['text', 'textarea', 'url', 'email', 'phone', 'ip', 'date', 'number'].includes(source.type)
            ? source.type
            : 'text';
        field = {
          key: fieldKey,
          label,
          type,
          required: false,
          options: [],
          help: 'Added when merging duplicates.',
          showInList: false,
          expires: false,
        };
        added.push(field);
      }
      if (!field || present(fields[field.key])) continue;
      // A choice list only takes one of its options; anything else stays with the archived copy.
      if (['select', 'multiselect'].includes(field.type) && !field.options.includes(String(value))) continue;
      fields[field.key] = typeof value === 'object' && field.type === 'text' ? JSON.stringify(value) : value;
    }
  }
  if (added.length) {
    target = [...target, ...added];
    await layoutService.update(actor, keep.layoutId, { fields: target });
  }
  await assets.update(
    scope,
    keepId,
    {
      fields,
      notes: joinNotes(
        keep.notes,
        others.map((o) => o.notes),
      ),
      version: keep.version,
    },
    `Merged ${others.length} duplicate${others.length === 1 ? '' : 's'} into this`,
  );
  await db.transaction(async (tx) => {
    await repoint(tx, actor.orgId, 'asset', 'assets', keepId, mergeIds);
    await recordActivity(tx, actor, {
      clientId: keep.clientId,
      action: `Merged ${mergeIds.length + 1} duplicates into`,
      entityType: 'asset',
      entityId: keepId,
      title: keep.name,
    });
  });
  for (const other of others) {
    const current = await assets.get(scope, other.id);
    await assets.update(
      scope,
      other.id,
      { notes: joinNotes(`Merged into ${keep.name} (${keep.layoutName}).`, [current.notes]), version: current.version },
      'Merged into another asset',
    );
    await assets.setArchived(scope, other.id, true);
  }
  return { keptId: keepId, merged: others.length, fieldsAdded: added.map((f) => f.label) };
}

/**
 * Clients: everything in the others (contacts, locations, assets, documents, passwords and their folders, files,
 * access grants, history) moves to the kept client, then the emptied clients are removed.
 */
async function mergeClients(db: Database, actor: Actor, keepId: string, mergeIds: string[]): Promise<MergeResult> {
  const orgId = actor.orgId;
  const rows = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.orgId, orgId), inArray(schema.clients.id, [keepId, ...mergeIds])));
  const keep = rows.find((r) => r.id === keepId);
  const others = rows.filter((r) => r.id !== keepId);
  if (!keep || others.length !== mergeIds.length) throw new HttpError(404, 'Some of those clients no longer exist.');
  await db.transaction(async (tx) => {
    const move = { clientId: keepId };
    for (const t of [
      schema.contacts,
      schema.locations,
      schema.assets,
      schema.folders,
      schema.documents,
      schema.attachments,
      schema.activity,
      schema.vaultAudit,
    ])
      await tx.update(t).set(move).where(inArray(t.clientId, mergeIds));
    // Password folders are unique by name per client: same-named ones are combined.
    const keepFolders = await tx
      .select()
      .from(schema.passwordFolders)
      .where(eq(schema.passwordFolders.clientId, keepId));
    for (const f of await tx
      .select()
      .from(schema.passwordFolders)
      .where(inArray(schema.passwordFolders.clientId, mergeIds))) {
      const same = keepFolders.find((k) => key(k.name) === key(f.name));
      if (same) {
        await tx.update(schema.passwords).set({ folderId: same.id }).where(eq(schema.passwords.folderId, f.id));
        await tx.delete(schema.passwordFolders).where(eq(schema.passwordFolders.id, f.id));
      } else {
        await tx.update(schema.passwordFolders).set(move).where(eq(schema.passwordFolders.id, f.id));
        keepFolders.push({ ...f, clientId: keepId });
      }
    }
    await tx.update(schema.passwords).set(move).where(inArray(schema.passwords.clientId, mergeIds));
    // Access: grants on the others carry over unless the person or group already has one on the kept client.
    const keepGrants = await tx.select().from(schema.clientAccess).where(eq(schema.clientAccess.clientId, keepId));
    for (const g of await tx
      .select()
      .from(schema.clientAccess)
      .where(inArray(schema.clientAccess.clientId, mergeIds))) {
      const has = keepGrants.some((k) => (g.userId ? k.userId === g.userId : k.groupId === g.groupId));
      if (!has) {
        await tx.insert(schema.clientAccess).values({ ...g, clientId: keepId });
        keepGrants.push({ ...g, clientId: keepId });
      }
    }
    await tx
      .update(schema.externalRefs)
      .set({ entityId: keepId })
      .where(
        and(
          eq(schema.externalRefs.orgId, orgId),
          eq(schema.externalRefs.kind, 'clients'),
          inArray(schema.externalRefs.entityId, mergeIds),
        ),
      );
    await tx
      .update(schema.clients)
      .set({
        notes: joinNotes(
          keep.notes,
          others.map((o) => o.notes),
        ).slice(0, 5000),
        updatedAt: new Date(),
      })
      .where(eq(schema.clients.id, keepId));
    // Everything has moved; the emptied clients (and their now-duplicate grants) go.
    await tx.delete(schema.clients).where(inArray(schema.clients.id, mergeIds));
    await recordActivity(tx, actor, {
      clientId: keepId,
      action: `Merged ${mergeIds.length + 1} duplicate clients into`,
      entityType: 'client',
      entityId: keepId,
      title: keep.name,
    });
  });
  // ConnectWise RMM company links that pointed at a merged client now point at the kept one.
  const [org] = await db.select({ settings: schema.orgs.settings }).from(schema.orgs).where(eq(schema.orgs.id, orgId));
  const settings = (org?.settings ?? {}) as { cwRmm?: { map?: Record<string, { action: string; clientId?: string }> } };
  const map = settings.cwRmm?.map;
  if (map && Object.values(map).some((m) => m.clientId && mergeIds.includes(m.clientId))) {
    for (const m of Object.values(map)) if (m.clientId && mergeIds.includes(m.clientId)) m.clientId = keepId;
    await db
      .update(schema.orgs)
      .set({ settings: sql`jsonb_set(${schema.orgs.settings}, '{cwRmm,map}', ${JSON.stringify(map)}::jsonb)` })
      .where(eq(schema.orgs.id, orgId));
  }
  return { keptId: keepId, merged: others.length, fieldsAdded: [] };
}
