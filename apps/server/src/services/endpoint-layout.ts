import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { MAX_LAYOUT_FIELDS, type Actor, type LayoutField } from '@atlas/shared';
import { recordActivity } from './activity.js';
import { mergeAssets } from './duplicates.js';
import { snapshot } from './revisions.js';

/** The one layout for PCs, Macs, Linux workstations and servers, which Hudu and ConnectWise RMM both import into. */
export const ENDPOINTS = 'Endpoints';
export const ENDPOINTS_DESCRIPTION = 'Any PC, Mac, Linux workstation or server.';
export const ENDPOINTS_ICON = 'monitor-smartphone';

// Names that mean the same layout: Atlas's "Devices", Hudu's "Computer Assets", "Endpoints", and the like.
const ENDPOINT_NAME = /^(managed |rmm )?(devices?|endpoints?|computers?|workstations?)( assets?)?$/;
const DEVICE_NAME = /^(managed |rmm )?devices?( assets?)?$/;

export const isEndpointName = (name: string) => ENDPOINT_NAME.test(name.trim().toLowerCase());

/**
 * The organization's endpoint layout, renamed to Endpoints if it isn't already, or null when there is none.
 * Configurations and archived layouts don't count. One already named Endpoints comes first, then one named for
 * devices, then the oldest other match (such as an earlier import's "Computer Assets").
 *
 * With an actor, the other matching layouts are folded into it, so there is one: an asset with the same name in
 * the same client is merged into the Endpoints one (as on the Duplicates page), the rest move over with their
 * values, and the emptied layout is archived.
 */
export async function endpointLayout(db: Database, orgId: string, actor?: Actor): Promise<string | null> {
  const layouts = (
    await db
      .select({
        id: schema.assetLayouts.id,
        key: schema.assetLayouts.key,
        name: schema.assetLayouts.name,
      })
      .from(schema.assetLayouts)
      .where(and(eq(schema.assetLayouts.orgId, orgId), eq(schema.assetLayouts.archived, false)))
      .orderBy(asc(schema.assetLayouts.createdAt))
  ).filter((l) => l.key !== 'configuration' && (isEndpointName(l.name) || isEndpointName(l.key)));
  const lower = (s: string) => s.trim().toLowerCase();
  const picked =
    layouts.find((l) => lower(l.name) === lower(ENDPOINTS)) ??
    layouts.find((l) => DEVICE_NAME.test(lower(l.name)) || DEVICE_NAME.test(l.key)) ??
    layouts[0];
  if (!picked) return null;
  if (picked.name !== ENDPOINTS)
    await db
      .update(schema.assetLayouts)
      .set({ name: ENDPOINTS, description: ENDPOINTS_DESCRIPTION, updatedAt: new Date() })
      .where(eq(schema.assetLayouts.id, picked.id));
  if (actor) for (const other of layouts) if (other.id !== picked.id) await foldInto(db, actor, picked.id, other.id);
  return picked.id;
}

const norm = (label: string) =>
  label
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');
const present = (v: unknown) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);

/** Moves every asset of layout `fromId` into `toId` (merging same-named ones), then archives `fromId`. */
async function foldInto(db: Database, actor: Actor, toId: string, fromId: string) {
  const layoutOf = async (id: string) =>
    (await db.select().from(schema.assetLayouts).where(eq(schema.assetLayouts.id, id)))[0]!;
  const target = await layoutOf(toId);
  const source = await layoutOf(fromId);
  const fields = [...(target.fields as LayoutField[])];
  const theirs = source.fields as LayoutField[];

  // Each of the old layout's fields maps to the Endpoints field with the same key or label, or is added to it.
  const keyFor = new Map<string, LayoutField | null>();
  const used = new Set(fields.map((f) => f.key));
  for (const f of theirs) {
    let field = fields.find((t) => t.key === f.key) ?? fields.find((t) => norm(t.label) === norm(f.label));
    if (!field && fields.length < MAX_LAYOUT_FIELDS) {
      let fieldKey = f.key;
      for (let n = 2; used.has(fieldKey); n++) fieldKey = `${f.key.slice(0, 36)}_${n}`;
      used.add(fieldKey);
      // Optional, so the Endpoints assets that have no value for it can still be saved.
      field = { ...f, key: fieldKey, required: false };
      fields.push(field);
    }
    keyFor.set(f.key, field ?? null);
  }
  if (fields.length !== (target.fields as LayoutField[]).length)
    await db.update(schema.assetLayouts).set({ fields, updatedAt: new Date() }).where(eq(schema.assetLayouts.id, toId));

  const rows = (layoutId: string) =>
    db
      .select({
        id: schema.assets.id,
        clientId: schema.assets.clientId,
        name: schema.assets.name,
        archived: schema.assets.archived,
      })
      .from(schema.assets)
      .where(and(eq(schema.assets.orgId, actor.orgId), eq(schema.assets.layoutId, layoutId)));
  const kept = new Map(
    (await rows(toId)).filter((a) => !a.archived).map((a) => [`${a.clientId}|${a.name.trim().toLowerCase()}`, a.id]),
  );
  for (const a of await rows(fromId)) {
    const same = !a.archived && kept.get(`${a.clientId}|${a.name.trim().toLowerCase()}`);
    if (same) {
      // Values fill the Endpoints asset's blanks; links, files and import links move; the copy is archived.
      await mergeAssets(db, actor, same, [a.id]);
    }
    // Moved (the merged copy too, archived, so the old layout is left empty), as a new version like any move.
    const [current] = await db.select().from(schema.assets).where(eq(schema.assets.id, a.id));
    if (!current) continue;
    const values: Record<string, unknown> = {};
    const left: string[] = [];
    for (const [k, v] of Object.entries((current.fields ?? {}) as Record<string, unknown>)) {
      if (!present(v)) continue;
      const field = keyFor.get(k);
      const fits =
        field &&
        (field.type === 'multiselect'
          ? Array.isArray(v) && v.every((o) => field.options.includes(String(o)))
          : field.type !== 'select' || field.options.includes(String(v)));
      if (field && fits && !present(values[field.key])) values[field.key] = v;
      else
        left.push(`${theirs.find((f) => f.key === k)?.label ?? k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    const next = {
      name: current.name,
      status: current.status,
      fields: values,
      notes: [current.notes, ...left].filter(Boolean).join('\n'),
      layoutId: toId,
      fromLayoutId: fromId,
    };
    await db.transaction(async (tx) => {
      await tx
        .update(schema.assets)
        .set({
          layoutId: toId,
          fields: values,
          notes: next.notes,
          version: current.version + 1,
          updatedBy: actor.id,
          updatedAt: new Date(),
        })
        .where(eq(schema.assets.id, a.id));
      await snapshot(tx, actor, 'asset', a.id, current.version + 1, next);
      await recordActivity(tx, actor, {
        clientId: current.clientId,
        action: `Moved to ${ENDPOINTS}`,
        entityType: 'asset',
        entityId: a.id,
        title: current.name,
      });
    });
  }
  await db
    .update(schema.assetLayouts)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(schema.assetLayouts.id, fromId));
}
