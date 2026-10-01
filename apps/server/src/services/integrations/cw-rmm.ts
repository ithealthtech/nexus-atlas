import { and, eq, inArray, like, or } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { cwRmmMappingSchema, cwRmmSyncOptionsSchema, type CwRmmSyncOptions, type Actor, type AssetView, type CwRmmCompany, type LayoutField, type RmmDeviceKind, MAX_LAYOUT_FIELDS } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import { ClientService } from '../clients.js';
import { endpointLayout, isEndpointName } from '../endpoint-layout.js';
import { LayoutService } from '../layouts.js';
import { contacts as contactService, locations } from '../people.js';
import { Scope } from '../scope.js';
import type { SettingsService, StoredCwRmm } from '../settings.js';
import { ImportRun } from '../importers/common.js';
import { detectManufacturer } from '../manufacturer.js';
import type { WarrantyLookup } from '../warranty-lookup.js';
import { type RmmContact, type RmmDevice, type RmmRelation, type RmmSite } from './cw-rmm-devices.js';
import { CwRmmClient } from './cw-rmm-client.js';

// The ConnectWise RMM sync: companies, sites, contacts and devices into Atlas. Reading device records lives in
// cw-rmm-devices.ts and the API client in cw-rmm-client.ts; both are re-exported so callers import from here.
export * from './cw-rmm-devices.js';
export * from './cw-rmm-client.js';

// Which fields of another layout can take a device value: its own key, or a label that means the same thing.
const FIELD_LABELS: Record<string, RegExp> = {
  type: /^(device )?type$|^kind$|^category$/,
  hostname: /host ?name|computer name|machine name|device name/,
  ip_address: /\bip\b|ip address|ipv4/,
  mac_address: /\bmac\b/,
  manufacturer: /manufacturer|make|vendor/,
  model: /^model$|model (name|number)/,
  serial_number: /serial|service tag/,
  operating_system: /operating system|^os$|os version/,
  location: /^location$|^site$/,
  warranty_expires: /warrant/,
};

/** The device values another layout can hold, keyed by that layout's own fields; values that don't fit are left out. */
export function fitFields(layoutFields: LayoutField[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const target =
      layoutFields.find((f) => f.key === key) ??
      layoutFields.find((f) => FIELD_LABELS[key]?.test(f.label.trim().toLowerCase()));
    if (!target || target.key in out) continue;
    if (['text', 'textarea', 'ip', 'url'].includes(target.type)) {
      if (target.type === 'url' && !/^https?:\/\//i.test(value)) continue;
      out[target.key] = value;
    } else if (target.type === 'date') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) out[target.key] = value;
    } else if (target.type === 'select') {
      const option = target.options.find((o) => o.toLowerCase() === value.toLowerCase());
      if (option) out[target.key] = option;
    }
  }
  return out;
}

const DEVICE_FIELD_LABELS: Record<string, string> = {
  type: 'Type',
  hostname: 'Hostname',
  ip_address: 'IP address',
  mac_address: 'MAC address',
  manufacturer: 'Manufacturer',
  model: 'Model',
  serial_number: 'Serial number',
  operating_system: 'Operating system',
  location: 'Location',
  warranty_expires: 'Warranty expires',
};
/** Sample values that fit a field of each device value's type, to test whether a layout can hold it. */
const SAMPLE: Record<string, string> = { ip_address: '10.0.0.1', warranty_expires: '2030-01-01' };

/**
 * Adds text fields to a layout for device values it has no field for (within the field limit), and returns
 * the layout's fields. `cache` is updated so each layout is changed once per sync.
 */
async function ensureDeviceFields(
  layouts: LayoutService,
  actor: Actor,
  layoutId: string,
  cache: Map<string, LayoutField[]>,
  values: Record<string, string>,
): Promise<LayoutField[]> {
  const current = cache.get(layoutId) ?? [];
  const labelled = new Set(current.map((f) => f.label.trim().toLowerCase()));
  const used = new Set(current.map((f) => f.key));
  const added: LayoutField[] = [];
  for (const [key, value] of Object.entries(values)) {
    // Type only goes into a matching choice list; it isn't added as free text.
    if (!value || key === 'type') continue;
    const label = DEVICE_FIELD_LABELS[key]!;
    const fits = fitFields(current, { [key]: SAMPLE[key] ?? 'x' });
    if (Object.keys(fits).length || labelled.has(label.toLowerCase())) continue;
    if (current.length + added.length >= MAX_LAYOUT_FIELDS) break;
    let fieldKey = key;
    for (let n = 2; used.has(fieldKey); n++) fieldKey = `${key}_${n}`;
    used.add(fieldKey);
    added.push({
      key: fieldKey,
      label,
      // A warranty date is a date, so it shows on Expirations and the warranty chart.
      type: key === 'warranty_expires' ? 'date' : 'text',
      required: false,
      options: [],
      help: 'Added by the ConnectWise RMM sync.',
      showInList: false,
      expires: key === 'warranty_expires',
    });
  }
  if (!added.length) return current;
  const next = [...current, ...added];
  await layouts.update(actor, layoutId, { fields: next });
  cache.set(layoutId, next);
  return next;
}

/**
 * Makes sure a layout has a field for each label (matched by label, loosely, or by its key), adding text fields
 * for the rest within the field limit. Returns label → field key; `cache` is kept current.
 */
async function ensureLabelledFields(
  layouts: LayoutService,
  actor: Actor,
  layoutId: string,
  cache: Map<string, LayoutField[]>,
  labels: string[],
): Promise<Map<string, string>> {
  const loose = (l: string) => l.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  const current = cache.get(layoutId) ?? ((await layouts.get(actor, layoutId)).fields as LayoutField[]);
  const used = new Set(current.map((f) => f.key));
  const added: LayoutField[] = [];
  const keys = new Map<string, string>();
  for (const label of labels) {
    const found =
      [...current, ...added].find((f) => loose(f.label) === loose(label)) ??
      [...current, ...added].find((f) => f.key === slugKey(label));
    if (found) {
      keys.set(label, found.key);
      continue;
    }
    if (current.length + added.length >= MAX_LAYOUT_FIELDS) continue;
    let key = slugKey(label);
    for (let n = 2; used.has(key); n++) key = `${slugKey(label).slice(0, 36)}_${n}`;
    used.add(key);
    added.push({
      key,
      label,
      type: 'text',
      required: false,
      options: [],
      help: 'Added by the ConnectWise RMM sync.',
      showInList: false,
      expires: false,
    });
    keys.set(label, key);
  }
  if (added.length) {
    const next = [...current, ...added];
    await layouts.update(actor, layoutId, { fields: next });
    cache.set(layoutId, next);
  }
  return keys;
}

/** The value in the form a field of that type accepts, or undefined when it can't hold it. */
export function valueFor(field: LayoutField, value: string): string | undefined {
  const v = value.trim();
  if (!v) return undefined;
  switch (field.type) {
    case 'text':
    case 'textarea':
      return v;
    case 'select':
      return field.options.find((o) => o.toLowerCase() === v.toLowerCase());
    case 'ip':
      return /^[0-9a-f.:]+$/i.test(v) ? v : undefined;
    case 'url':
      return /^https?:\/\/\S+$/i.test(v) ? v : undefined;
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : undefined;
    case 'number':
      return Number.isFinite(Number(v)) ? v : undefined;
    case 'date':
      return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
    default:
      // Checkbox, multiselect, and the like: not something free text should be forced into.
      return undefined;
  }
}

/** A field key from a label: lowercase letters, digits, and underscores, starting with a letter. */
const slugKey = (label: string) =>
  `f_${label}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^f_(?=[a-z])/, '')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'field';

/** Non-archived assets in a client by lower-cased name, with how many device fields each one's layout can take. */
async function sameNameCandidates(db: Database, orgId: string, clientId: string) {
  const layouts = await db
    .select({ id: schema.assetLayouts.id, fields: schema.assetLayouts.fields })
    .from(schema.assetLayouts)
    .where(eq(schema.assetLayouts.orgId, orgId));
  const layoutFields = new Map(layouts.map((l) => [l.id, l.fields as LayoutField[]]));
  const probe = Object.fromEntries(Object.keys(FIELD_LABELS).map((k) => [k, k === 'type' ? '' : 'x']));
  const rows = await db
    .select({
      id: schema.assets.id,
      name: schema.assets.name,
      layoutId: schema.assets.layoutId,
      createdAt: schema.assets.createdAt,
    })
    .from(schema.assets)
    .where(
      and(eq(schema.assets.orgId, orgId), eq(schema.assets.clientId, clientId), eq(schema.assets.archived, false)),
    );
  const byName = new Map<string, { id: string; layoutId: string; createdAt: Date; fit: number }[]>();
  for (const r of rows) {
    const fit = Object.keys(fitFields(layoutFields.get(r.layoutId) ?? [], probe)).length;
    const key = r.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), { id: r.id, layoutId: r.layoutId, createdAt: r.createdAt, fit }]);
  }
  return { byName, layoutFields };
}

/** Asset IDs already linked to a ConnectWise RMM device. */
async function claimedByRmm(db: Database, orgId: string) {
  const rows = await db
    .select({ id: schema.externalRefs.entityId })
    .from(schema.externalRefs)
    .where(
      and(
        eq(schema.externalRefs.orgId, orgId),
        eq(schema.externalRefs.source, 'cw-rmm'),
        eq(schema.externalRefs.kind, 'assets'),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

// Marks the assets the sync made outside Configurations, so they are told apart from ones it matched.
const OWNED = 'owned-assets';

/** Asset IDs the sync made (outside Configurations). */
async function ownedByRmm(db: Database, orgId: string) {
  const rows = await db
    .select({ id: schema.externalRefs.entityId })
    .from(schema.externalRefs)
    .where(
      and(
        eq(schema.externalRefs.orgId, orgId),
        eq(schema.externalRefs.source, 'cw-rmm'),
        eq(schema.externalRefs.kind, OWNED),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

async function markOwned(db: Database, orgId: string, owned: Set<string>, assetId: string) {
  if (owned.has(assetId)) return;
  await db
    .insert(schema.externalRefs)
    .values({ orgId, source: 'cw-rmm', kind: OWNED, externalId: assetId, entityId: assetId })
    .onConflictDoNothing();
  owned.add(assetId);
}

/**
 * A value entered on an asset, in the form a field of another layout takes, or undefined when it can't hold it.
 * Text goes through valueFor; numbers, checkboxes, and lists carry over into a field of the same type.
 */
export function keptValue(from: LayoutField | undefined, to: LayoutField, value: unknown): unknown {
  if (typeof value === 'string') return valueFor(to, value);
  if (!from || from.type !== to.type) return undefined;
  if (to.type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  if (to.type === 'checkbox') return typeof value === 'boolean' ? value : undefined;
  if (to.type === 'multiselect')
    return Array.isArray(value) && value.every((v) => typeof v === 'string' && to.options.includes(v))
      ? value
      : undefined;
  return undefined;
}

/** Maps the RMM's device type onto the Configurations layout's Type options. */
export function deviceType(d: Pick<RmmDevice, 'type' | 'os'>): string {
  const t = `${d.type} ${d.os}`.toLowerCase();
  if (/server/.test(t)) return 'Server';
  if (/laptop|notebook|portable/.test(t)) return 'Laptop';
  if (/virtual|\bvm\b/.test(t)) return 'Virtual machine';
  if (/firewall/.test(t)) return 'Firewall';
  if (/switch/.test(t)) return 'Switch';
  if (/router/.test(t)) return 'Router';
  if (/access ?point|\bap\b/.test(t)) return 'Access point';
  if (/printer/.test(t)) return 'Other';
  if (/desktop|workstation|windows|mac ?os|linux/.test(t)) return 'Workstation';
  return 'Other';
}

/** Server, workstation, or other, for the RMM health counts. */
export function deviceKind(d: Pick<RmmDevice, 'type' | 'os'>): RmmDeviceKind {
  const type = deviceType(d);
  if (type === 'Server') return 'server';
  if (type === 'Workstation' || type === 'Laptop') return 'workstation';
  return 'other';
}

type ContactRow = { id: string; name: string; email: string };

/**
 * The client's contact a device account belongs to: by email ("jane.doe" for jane.doe@harbor.com), by name
 * ("janedoe" or "jdoe" for Jane Doe). Null unless exactly one contact matches, so a guess never links the wrong person.
 */
export function contactFor(username: string, contacts: ContactRow[]): string | null {
  const u = norm(username);
  if (u.length < 3) return null;
  const ids = new Set<string>();
  for (const c of contacts) {
    const words = c.name.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const forms = [
      norm(c.email.split('@')[0] ?? ''),
      norm(c.name),
      words.length > 1 ? norm(`${words[0]![0]}${words.at(-1)}`) : '',
    ];
    if (forms.includes(u)) ids.add(c.id);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

// Links the sync makes end their note with this, so it can tell them from links people made and remove its own when
// ConnectWise stops reporting them.
const SYNCED = ' (ConnectWise RMM)';
const SIGN_IN_LINK = `Signs in as %${SYNCED}`;
const VM_LINK = `% hosts virtual machine %${SYNCED}`;

/** Removes the sync's own links (notes matching `pattern`) from an asset to items of `type` not in `keep`. */
async function dropSyncedLinks(
  db: Database,
  orgId: string,
  assetId: string,
  type: 'asset' | 'contact',
  pattern: string,
  keep: Set<string>,
) {
  const r = schema.relations;
  const rows = await db
    .select({ id: r.id, aId: r.aId, bId: r.bId })
    .from(r)
    .where(
      and(
        eq(r.orgId, orgId),
        like(r.note, pattern),
        or(
          and(eq(r.aType, 'asset'), eq(r.aId, assetId), eq(r.bType, type)),
          and(eq(r.bType, 'asset'), eq(r.bId, assetId), eq(r.aType, type)),
        ),
      ),
    );
  const stale = rows.filter((row) => !keep.has(row.aId === assetId ? row.bId : row.aId)).map((row) => row.id);
  if (stale.length) await db.delete(r).where(inArray(r.id, stale));
}

/** Links two items (undirected, stored once in a stable order), unless they already are; whether a link was made. */
async function linkItems(
  db: Database,
  orgId: string,
  x: { type: string; id: string },
  y: { type: string; id: string },
  note: string,
) {
  const [a, b] = `${x.type}:${x.id}` < `${y.type}:${y.id}` ? [x, y] : [y, x];
  const made = await db
    .insert(schema.relations)
    .values({ orgId, aType: a.type, aId: a.id, bType: b.type, bId: b.id, note: note.slice(0, 200) })
    .onConflictDoNothing()
    .returning({ id: schema.relations.id });
  return made.length > 0;
}

/** Records a device's health for the RMM health charts, against the asset it was synced into. */
async function saveStatus(
  db: Database,
  orgId: string,
  clientId: string,
  assetId: string,
  d: RmmDevice,
  contacts: ContactRow[] = [],
) {
  const values = {
    clientId,
    assetId,
    kind: deviceKind(d),
    online: d.online,
    lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt) : null,
    protection: d.protection,
    protectionProduct: d.protectionProduct,
    // Software and sign-ins ConnectWise didn't give this time keep what an earlier sync saved.
    ...(d.software ? { software: d.software } : {}),
    ...(d.signIns ? { signIns: d.signIns.map((u) => ({ ...u, contactId: contactFor(u.username, contacts) })) } : {}),
    // Only a read that brought software or sign-ins makes them current.
    ...(d.software || d.signIns ? { inventoryAt: new Date() } : {}),
    updatedAt: new Date(),
  };
  await db
    .insert(schema.rmmDeviceStatus)
    .values({ orgId, source: 'cw-rmm', externalId: d.id, ...values })
    .onConflictDoUpdate({
      target: [schema.rmmDeviceStatus.orgId, schema.rmmDeviceStatus.source, schema.rmmDeviceStatus.externalId],
      set: values,
    });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** RMM companies with the decision for each, and a same-name Atlas client to suggest. */
export async function companiesWithMapping(
  db: Database,
  actor: Actor,
  client: CwRmmClient,
  saved: StoredCwRmm,
): Promise<CwRmmCompany[]> {
  const clients = await new ClientService(db).list(actor);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const byName = new Map(clients.map((c) => [norm(c.name), c.id]));
  return (await client.companies())
    .map((c) => {
      const m = saved.map[c.id];
      const linked = m?.action === 'link' ? byId.get(m.clientId) : undefined;
      return {
        id: c.id,
        name: c.name,
        action: m?.action === 'skip' ? ('skip' as const) : linked ? ('link' as const) : null,
        clientId: linked?.id ?? null,
        clientName: linked?.name ?? null,
        suggestedClientId: m ? null : (byName.get(norm(c.name)) ?? null),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Saves decisions; 'create' makes the Atlas client now so the next sync has somewhere to go. */
export async function saveMapping(
  db: Database,
  actor: Actor,
  settings: SettingsService,
  client: CwRmmClient,
  input: unknown,
) {
  const body = cwRmmMappingSchema.parse(input);
  const saved = (await settings.cwRmm(actor.orgId))!;
  const names = new Map((await client.companies()).map((c) => [c.id, c.name]));
  const clients = new ClientService(db);
  const map = { ...saved.map };
  for (const m of body.mappings) {
    if (!names.has(m.companyId)) throw new HttpError(400, 'That company is not in ConnectWise RMM.');
    if (m.action === 'clear') delete map[m.companyId];
    else if (m.action === 'skip') map[m.companyId] = { action: 'skip' };
    else if (m.action === 'create') {
      const created = await clients.create(actor, { name: names.get(m.companyId)!.slice(0, 200) });
      map[m.companyId] = { action: 'link', clientId: created.id };
    } else {
      if (!m.clientId) throw new HttpError(400, 'Choose the Atlas client to link.');
      await clients.get(actor, m.clientId);
      map[m.companyId] = { action: 'link', clientId: m.clientId };
    }
  }
  await settings.patchCwRmm(actor.orgId, { map });
}

/**
 * The layout devices are saved in: the one chosen in the sync options, else the Endpoints layout (one named
 * "Endpoints", "Devices" or "Computer Assets", renamed to Endpoints; see endpointLayout), else Configurations. `configurationId` is the Configurations layout, whose synced
 * devices move to the chosen layout.
 */
export async function deviceLayout(db: Database, orgId: string, chosen: string | null, actor?: Actor) {
  const layouts = await db
    .select({
      id: schema.assetLayouts.id,
      key: schema.assetLayouts.key,
      name: schema.assetLayouts.name,
      archived: schema.assetLayouts.archived,
    })
    .from(schema.assetLayouts)
    .where(eq(schema.assetLayouts.orgId, orgId));
  const configuration = layouts.find((l) => l.key === 'configuration');
  if (chosen) {
    const picked = layouts.find((l) => l.id === chosen);
    // A chosen Devices or Computer Assets layout means the Endpoints layout, which it's folded into (and archived).
    const endpoints = picked && picked.key !== 'configuration' && isEndpointName(picked.name);
    const folded = endpoints ? await endpointLayout(db, orgId, actor) : null;
    if (folded) return { id: folded, configurationId: configuration?.id ?? null };
    if (!picked || picked.archived)
      throw new HttpError(
        400,
        'The asset layout chosen for ConnectWise RMM devices is missing or archived. Pick another to sync devices.',
      );
    return { id: picked.id, configurationId: configuration?.id ?? null };
  }
  const named = await endpointLayout(db, orgId, actor);
  if (named) return { id: named, configurationId: configuration?.id ?? null };
  if (!configuration || configuration.archived)
    throw new HttpError(400, 'The Configurations asset layout is missing or archived. Restore it to sync devices.');
  return { id: configuration.id, configurationId: configuration.id };
}

/**
 * A company's contacts into its Atlas client. A contact already there with the same email (or, without one, the
 * same name) is linked and updated rather than copied. Notes, and which contact is primary, are left as Atlas has
 * them once a contact exists.
 */
async function syncContacts(scope: Scope, client: CwRmmClient, run: ImportRun, companyId: string, clientId: string) {
  let found: RmmContact[];
  try {
    found = await client.contacts(companyId);
  } catch (error) {
    run.note(`Company ${companyId}: contacts ${error instanceof HttpError ? error.message.replace(/^ConnectWise RMM /, '') : 'could not be read.'}`);
    return;
  }
  const existing = await contactService.list(scope, clientId);
  const hasPrimary = existing.some((c) => c.primary);
  for (const c of found) {
    const body = { name: c.name, title: c.title, email: c.email, phone: c.phone, mobile: c.mobile };
    // A value ConnectWise leaves blank doesn't wipe one typed into Atlas.
    const filled = Object.fromEntries(Object.entries(body).filter(([, v]) => v));
    await run.upsert(
      'contacts',
      c.id,
      c.name,
      async () => {
        const same = existing.find((e) =>
          c.email ? e.email.toLowerCase() === c.email : e.name.trim().toLowerCase() === c.name.toLowerCase(),
        );
        if (same) {
          await contactService.update(scope, same.id, filled);
          return same.id;
        }
        const created = await contactService.create(scope, clientId, {
          ...body,
          primary: c.primary && !hasPrimary,
          notes: 'Synced from ConnectWise.',
        });
        existing.push(created);
        return created.id;
      },
      async (id) => void (await contactService.update(scope, id, filled)),
    );
  }
}

/**
 * Syncs linked companies: sites become locations, contacts become contacts, devices become assets in the device layout (see deviceLayout).
 * A device the RMM no longer reports is archived, but only when its company's device list was fetched in full.
 */
export async function runCwRmmSync(
  db: Database,
  actor: Actor,
  client: CwRmmClient,
  run: ImportRun,
  map: StoredCwRmm['map'],
  options: CwRmmSyncOptions = cwRmmSyncOptionsSchema.parse({}),
  warranty?: WarrantyLookup,
) {
  const scope = new Scope(db, actor);
  const layoutService = new LayoutService(db);
  const assets = new AssetService(layoutService);
  // The client is shared between syncs; each sync notes the field names it saw.
  client.lastDeviceFields = '';
  const layout = await deviceLayout(db, actor.orgId, options.layoutId, actor);
  // Assets the sync made, which it keeps in the device layout and archives when their device goes. Those in
  // Configurations are all its own (it never matches devices to assets there); elsewhere they are marked.
  const owned = await ownedByRmm(db, actor.orgId);
  const isOwned = (a: { id: string; layoutId: string }) => a.layoutId === layout.configurationId || owned.has(a.id);
  let moved = 0;

  const linked = Object.entries(map).flatMap(([companyId, m]) => (m.action === 'link' ? [[companyId, m.clientId] as const] : []));
  if (!linked.length) run.note('No ConnectWise RMM companies are linked to Atlas clients yet.');
  const skipped = [
    !options.locations && 'sites (locations)',
    !options.contacts && 'contacts',
    !options.devices && 'devices',
  ].filter(Boolean);
  if (skipped.length) run.note(`Not synced this time, as chosen: ${skipped.join(', ')}.`);
  const seen = new Set<string>();
  const readInFull = new Set<string>();
  // A client linked to several companies is read in full only if every one of them was.
  const unread = new Set<string>();
  // Assets already linked to an RMM device, so two devices never land on one asset.
  const claimed = await claimedByRmm(db, actor.orgId);
  let matched = 0;
  let folded = 0;
  let warranties = 0;
  let signInLinks = 0;
  let vmLinks = 0;
  // Cleared when ConnectWise refuses the relations API, so it isn't asked again for every device.
  let relationsApi = options.inventory;
  for (const [companyId, clientId] of linked) {
    let sites: RmmSite[];
    let devices: RmmDevice[];
    try {
      // One request at a time: ConnectWise rate-limits bursts.
      sites = await client.sites(companyId);
      devices = options.devices
        ? await client.devices(
            companyId,
            sites.map((s) => s.id),
            { inventory: options.inventory },
          )
        : [];
    } catch (error) {
      unread.add(clientId);
      run.count('assets', 'failed');
      run.note(`Company ${companyId}: ${error instanceof HttpError ? error.message : 'could not be read.'}`);
      continue;
    }
    // Field names only (never values), so an unexpected response can be diagnosed from the job log.
    if (options.devices && !devices.length) run.note(`Company ${companyId}: no devices listed (${client.lastDeviceList}).`);
    const siteNames = new Map<string, string>();
    for (const s of sites) {
      siteNames.set(s.id, s.name);
      if (!options.locations) continue;
      const body = {
        name: s.name.slice(0, 120),
        address: s.address.slice(0, 300),
        city: s.city.slice(0, 120),
        region: s.region.slice(0, 120),
        postalCode: s.postalCode.slice(0, 20),
        country: s.country.slice(0, 80),
        notes: 'Synced from ConnectWise RMM.',
      };
      await run.upsert(
        'locations',
        s.id,
        s.name,
        async () => (await locations.create(scope, clientId, body)).id,
        async (existing) => void (await locations.update(scope, existing, body)),
      );
    }
    if (options.contacts) await syncContacts(scope, client, run, companyId, clientId);
    // Assets already in this client (from Hudu, a CSV, or typed in) that a device may be, by name or hostname:
    // the existing asset is updated instead of a copy being made.
    const existing = await sameNameCandidates(db, actor.orgId, clientId);
    const match = (d: RmmDevice, except?: string) =>
      [d.name, d.hostname]
        .filter(Boolean)
        .flatMap((n) => existing.byName.get(n.toLowerCase()) ?? [])
        .filter((a) => a.id !== except && a.layoutId !== layout.configurationId && !claimed.has(a.id))
        // The asset whose layout takes the most of the device's fields, then the oldest.
        .sort((a, b) => b.fit - a.fit || a.createdAt.getTime() - b.createdAt.getTime())[0];
    const contacts = options.inventory
      ? await db
          .select({ id: schema.contacts.id, name: schema.contacts.name, email: schema.contacts.email })
          .from(schema.contacts)
          .where(and(eq(schema.contacts.orgId, actor.orgId), eq(schema.contacts.clientId, clientId)))
      : [];
    // Each device's asset, for linking virtual machines to their hosts once the company's devices are all saved.
    const assetOf = new Map<string, string>();
    for (const d of devices) {
      seen.add(d.id);
      // A warranty date the RMM doesn't report is asked of the device's vendor, by serial number. It only fills a
      // blank warranty field (see withLookedUp), so a date someone typed in stays.
      let lookedUp = '';
      if (!d.warrantyExpires && warranty) {
        const maker = d.manufacturer || detectManufacturer({ model: d.model, name: d.name, hostname: d.hostname });
        lookedUp = (await warranty.find(actor.orgId, maker, d.serial))?.expires ?? '';
      }
      const withLookedUp = (layoutId: string, values: Record<string, unknown>) => {
        if (!lookedUp) return values;
        const fitted = fitFields(existing.layoutFields.get(layoutId) ?? [], { warranty_expires: lookedUp });
        const blank = Object.entries(fitted).filter(([key]) => !values[key]);
        if (blank.length) warranties++;
        return { ...values, ...Object.fromEntries(blank) };
      };
      const fields = {
        type: deviceType(d),
        hostname: d.hostname.slice(0, 500),
        ip_address: /^[0-9a-f.:]+$/i.test(d.ip.split(',')[0]!.trim()) ? d.ip.split(',')[0]!.trim() : '',
        mac_address: d.mac.slice(0, 500),
        manufacturer: d.manufacturer.slice(0, 500),
        model: d.model.slice(0, 500),
        serial_number: d.serial.slice(0, 500),
        operating_system: d.os.slice(0, 500),
        location: (siteNames.get(d.siteId) ?? '').slice(0, 500),
        warranty_expires: d.warrantyExpires,
      };
      const name = d.name.slice(0, 200);
      /** Everything else the RMM sent, keyed by the layout's own fields; fields it lacks are added to it. */
      const extras = async (layoutId: string) => {
        const keys = await ensureLabelledFields(
          layoutService,
          actor,
          layoutId,
          existing.layoutFields,
          d.extra.map(([label]) => label),
        );
        const layoutFields = existing.layoutFields.get(layoutId) ?? [];
        const out: Record<string, string> = {};
        for (const [label, value] of d.extra) {
          const field = layoutFields.find((f) => f.key === keys.get(label));
          // A value goes only into a field that can hold it (a choice list takes one of its options, a date a
          // date); anything else is left out rather than making the whole asset fail to save.
          const fitted = field && !(field.key in out) ? valueFor(field, value) : undefined;
          if (field && fitted !== undefined) out[field.key] = fitted;
        }
        return out;
      };
      /** Writes the device's values into an asset of another layout, where that layout's fields can take them. */
      const updateOther = async (id: string) => {
        const current = await assets.get(scope, id);
        // A value the layout has no field for gets one, so nothing the RMM knows is dropped.
        const layoutFields = await ensureDeviceFields(
          layoutService,
          actor,
          current.layoutId,
          existing.layoutFields,
          fields,
        );
        const fitted = fitFields(layoutFields, fields);
        // The named mapping wins over the extras where both carry a field.
        const merged = withLookedUp(current.layoutId, {
          ...current.fields,
          ...(await extras(current.layoutId)),
          ...fitted,
        });
        if (current.archived) await assets.setArchived(scope, id, false);
        if (JSON.stringify(merged) !== JSON.stringify(current.fields))
          await assets.update(scope, id, { fields: merged, version: current.version }, 'Synced from ConnectWise RMM');
        claimed.add(id);
      };
      /** The device's values keyed by the device layout's own fields, adding fields it lacks. */
      const deviceFields = async () =>
        fitFields(await ensureDeviceFields(layoutService, actor, layout.id, existing.layoutFields, fields), fields);
      /** Moves a device's asset out of Configurations into the device layout, keeping what fits there. */
      const moveToDeviceLayout = async (current: AssetView) => {
        const from = existing.layoutFields.get(current.layoutId) ?? [];
        const to = await ensureDeviceFields(layoutService, actor, layout.id, existing.layoutFields, fields);
        // Values Atlas users entered go into the same-keyed or same-labelled field, where it can hold them.
        const kept: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(current.fields)) {
          const label = from.find((f) => f.key === key)?.label.trim().toLowerCase();
          const field =
            to.find((f) => f.key === key) ?? (label ? to.find((f) => f.label.trim().toLowerCase() === label) : undefined);
          const fitted = field ? keptValue(from.find((f) => f.key === key), field, value) : undefined;
          if (field && fitted !== undefined) kept[field.key] = fitted;
        }
        return assets.moveToLayout(
          scope,
          current.id,
          { layoutId: layout.id, fields: kept, version: current.version },
          'Moved to the device layout by the ConnectWise RMM sync',
        );
      };
      const synced = await run.upsert(
        'assets',
        d.id,
        name,
        async () => {
          const other = match(d);
          if (other) {
            await updateOther(other.id);
            matched++;
            return other.id;
          }
          const created = await assets.create(scope, clientId, {
            layoutId: layout.id,
            name,
            fields: withLookedUp(layout.id, { ...(await extras(layout.id)), ...(await deviceFields()) }),
            notes: 'Synced from ConnectWise RMM.',
          });
          await markOwned(db, actor.orgId, owned, created.id);
          return created.id;
        },
        async (existingId) => {
          let current = await assets.get(scope, existingId);
          const misplaced = current.layoutId !== layout.id && isOwned(current);
          if (current.layoutId !== layout.id && !misplaced) return updateOther(existingId);
          // A copy an earlier sync made beside an asset that was already there: move the link to that asset and
          // archive the copy (it can be restored).
          const other = match(d, existingId);
          if (other) {
            await updateOther(other.id);
            await run.remember('assets', d.id, other.id);
            if (!current.archived) await assets.setArchived(scope, existingId, true);
            folded++;
            return;
          }
          // A device an earlier sync saved in another layout (Configurations, or one chosen before) moves.
          if (misplaced) {
            current = await moveToDeviceLayout(current);
            await markOwned(db, actor.orgId, owned, current.id);
            moved++;
          }
          // Fields Atlas users added stay; the RMM's own values are refreshed.
          const merged = withLookedUp(layout.id, {
            ...current.fields,
            ...(await extras(layout.id)),
            ...(await deviceFields()),
          });
          if (current.archived) await assets.setArchived(scope, existingId, false);
          if (current.name !== name || JSON.stringify(merged) !== JSON.stringify(current.fields))
            await assets.update(
              scope,
              existingId,
              { name, fields: merged, version: current.version },
              'Synced from ConnectWise RMM',
            );
        },
      );
      // The asset the device now lives in (a copy folded into an existing asset has moved).
      const assetId = synced && (await run.ref('assets', d.id));
      if (!assetId) continue;
      assetOf.set(d.id, assetId);
      await saveStatus(db, actor.orgId, clientId, assetId, d, contacts);
      // "Jane's laptop": the device is linked to the contact of each account that signs in to it, and no longer to
      // one whose account has stopped signing in.
      if (!d.signIns) continue;
      const signedIn = new Set<string>();
      for (const u of d.signIns) {
        const contactId = contactFor(u.username, contacts);
        if (!contactId) continue;
        signedIn.add(contactId);
        const note = `Signs in as ${u.username}${SYNCED}`;
        if (await linkItems(db, actor.orgId, { type: 'asset', id: assetId }, { type: 'contact', id: contactId }, note))
          signInLinks++;
      }
      await dropSyncedLinks(db, actor.orgId, assetId, 'contact', SIGN_IN_LINK, signedIn);
    }
    // Virtual machines and their hosts, as ConnectWise relates them. Workstations host nothing, so they're skipped.
    const names = new Map(devices.map((d) => [d.id, d.name]));
    for (const d of relationsApi ? devices : []) {
      const assetId = assetOf.get(d.id);
      if (!assetId || !d.siteId || deviceKind(d) === 'workstation') continue;
      let related: RmmRelation[];
      try {
        related = await client.relations(companyId, d.siteId, d.id);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        relationsApi = error.status === 404;
        if (relationsApi) continue;
        run.note(`Virtual machine hosts not linked: ${error.message}`);
        break;
      }
      const current = new Set<string>();
      for (const r of related) {
        const other = assetOf.get(r.endpointId);
        if (!other) continue;
        const guest = /guest|virtual|\bvm\b/i;
        const isHost = /host/i.test(r.role) || guest.test(r.relatedRole);
        const isGuest = guest.test(r.role) || /host/i.test(r.relatedRole);
        if (isHost === isGuest) continue;
        const [host, vm] = isHost ? [d.name, names.get(r.endpointId)] : [names.get(r.endpointId), d.name];
        current.add(other);
        const note = `${host} hosts virtual machine ${vm}${SYNCED}`;
        if (await linkItems(db, actor.orgId, { type: 'asset', id: assetId }, { type: 'asset', id: other }, note))
          vmLinks++;
      }
      // A VM that moved to another host keeps no link to the old one.
      await dropSyncedLinks(db, actor.orgId, assetId, 'asset', VM_LINK, current);
    }
    // Only a company whose devices were read counts toward archiving devices the RMM dropped.
    if (options.devices) readInFull.add(clientId);
  }

  if (signInLinks)
    run.note(`${signInLinks} new link${signInLinks === 1 ? '' : 's'} between devices and the contacts who sign in to them.`);
  if (vmLinks) run.note(`${vmLinks} new link${vmLinks === 1 ? '' : 's'} between virtual machines and their hosts.`);
  if (warranties)
    run.note(`Warranty end dates looked up from the vendor for ${warranties} device${warranties === 1 ? '' : 's'}.`);
  if (moved)
    run.note(`${moved} device${moved === 1 ? '' : 's'} moved into the device layout from where earlier syncs put them.`);
  if (matched)
    run.note(`${matched} device${matched === 1 ? '' : 's'} matched an asset already in Atlas by name, and updated it.`);
  if (folded)
    run.note(
      `${folded} cop${folded === 1 ? 'y' : 'ies'} from earlier syncs archived; their devices now update the same-named asset that was already there.`,
    );
  if (client.lastDeviceFields) run.note(`ConnectWise device ${client.lastDeviceFields}.`);

  // Archive devices removed from the RMM, within the clients read in full.
  const complete = [...readInFull].filter((id) => !unread.has(id));
  if (complete.length) {
    // Their health drops out of the charts with them.
    const statuses = await db
      .select({ externalId: schema.rmmDeviceStatus.externalId })
      .from(schema.rmmDeviceStatus)
      .where(
        and(
          eq(schema.rmmDeviceStatus.orgId, actor.orgId),
          eq(schema.rmmDeviceStatus.source, 'cw-rmm'),
          inArray(schema.rmmDeviceStatus.clientId, complete),
        ),
      );
    const gone = statuses.map((r) => r.externalId).filter((id) => !seen.has(id));
    if (gone.length)
      await db
        .delete(schema.rmmDeviceStatus)
        .where(
          and(
            eq(schema.rmmDeviceStatus.orgId, actor.orgId),
            eq(schema.rmmDeviceStatus.source, 'cw-rmm'),
            inArray(schema.rmmDeviceStatus.externalId, gone),
          ),
        );
    const refs = await db
      .select({
        externalId: schema.externalRefs.externalId,
        id: schema.assets.id,
        layoutId: schema.assets.layoutId,
        archived: schema.assets.archived,
      })
      .from(schema.externalRefs)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.externalRefs.entityId))
      .where(
        and(
          eq(schema.externalRefs.orgId, actor.orgId),
          eq(schema.externalRefs.source, 'cw-rmm'),
          eq(schema.externalRefs.kind, 'assets'),
          inArray(schema.assets.clientId, complete),
        ),
      );
    let archived = 0;
    // Only the sync's own assets: an existing asset it matched and updated is never archived.
    for (const r of refs)
      if (!seen.has(r.externalId) && !r.archived && isOwned(r)) {
        await assets.setArchived(scope, r.id, true);
        archived++;
      }
    if (archived)
      run.note(`Archived ${archived} device${archived === 1 ? '' : 's'} ConnectWise RMM no longer reports.`);
  }
  /** The clients whose devices were read in full. */
  return complete;
}
