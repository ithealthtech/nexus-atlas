import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { MAX_LAYOUT_FIELDS, type Actor, type LayoutField } from '@atlas/shared';
import { mergeAssets } from './duplicates.js';

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
      field = { ...f, key: fieldKey };
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
        fields: schema.assets.fields,
        notes: schema.assets.notes,
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
    // Moved (the merged copy too, archived, so the old layout is left empty).
    const values: Record<string, unknown> = {};
    const left: string[] = [];
    for (const [k, v] of Object.entries((a.fields ?? {}) as Record<string, unknown>)) {
      if (!present(v)) continue;
      const field = keyFor.get(k);
      const fits = field && (!['select', 'multiselect'].includes(field.type) || field.options.includes(String(v)));
      if (field && fits && !present(values[field.key])) values[field.key] = v;
      else
        left.push(`${theirs.find((f) => f.key === k)?.label ?? k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
    }
    const [current] = await db
      .select({ notes: schema.assets.notes })
      .from(schema.assets)
      .where(eq(schema.assets.id, a.id));
    const notes = [current?.notes ?? a.notes, ...left].filter(Boolean).join('\n');
    await db
      .update(schema.assets)
      .set({ layoutId: toId, fields: values, notes, updatedAt: new Date() })
      .where(eq(schema.assets.id, a.id));
  }
  await db
    .update(schema.assetLayouts)
    .set({ archived: true, updatedAt: new Date() })
    .where(eq(schema.assetLayouts.id, fromId));
}
