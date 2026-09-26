import type { Database } from '@atlas/db';
import { guessPasswordCategory, type Actor, type FieldType, type HuduPreview, type LayoutField } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import { ClientService } from '../clients.js';
import { DocumentService } from '../documents.js';
import { LayoutService } from '../layouts.js';
import { locations } from '../people.js';
import { RelationService } from '../relations.js';
import { Scope } from '../scope.js';
import type { VaultService } from '../vault.js';
import { ImportRun } from './common.js';
import { htmlToRichText, htmlToText } from './html.js';

// Hudu REST API v1 (https://<instance>/api/v1, header x-api-key). Lists return 25 items per page.
type HuduCompany = {
  id: number;
  name: string;
  company_type?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country_name?: string | null;
  phone_number?: string | null;
  website?: string | null;
  notes?: string | null;
  archived?: boolean;
};
type HuduLayoutField = {
  id?: number;
  label: string;
  field_type: string;
  required?: boolean;
  hint?: string | null;
  position?: number;
};
type HuduLayout = { id: number; name: string; fields?: HuduLayoutField[]; active?: boolean };
type HuduAsset = {
  id: number;
  company_id: number;
  asset_layout_id: number;
  name: string;
  primary_serial?: string | null;
  primary_model?: string | null;
  primary_manufacturer?: string | null;
  primary_mail?: string | null;
  // Hudu has sent a field's name as `label` or `caption`, sometimes with its layout field's id.
  fields?: { label?: string | null; caption?: string | null; asset_layout_field_id?: number; value: unknown }[];
  // Older API versions: one object per field, keyed by the label in snake_case.
  custom_fields?: Record<string, unknown>[];
  // Data synced by an integration (RMM, PSA, Microsoft 365). Often the only details a synced asset has.
  cards?: { integrator_name?: string | null; sync_type?: string | null; data?: unknown }[];
  archived?: boolean;
};
type HuduArticle = {
  id: number;
  name: string;
  content?: string | null;
  company_id?: number | null;
  archived?: boolean;
};
type HuduPassword = {
  id: number;
  company_id?: number | null;
  name: string;
  username?: string | null;
  password?: string | null;
  // The address saved on the password (the site to sign in to).
  login_url?: string | null;
  // Hudu's own link to this password's page, not the sign-in address.
  url?: string | null;
  description?: string | null;
  otp_secret?: string | null;
  password_folder_name?: string | null;
  // The asset a password is attached to in Hudu, if any.
  passwordable_type?: string | null;
  passwordable_id?: number | null;
  archived?: boolean;
};

const PAGE_SIZE = 25;
const MAX_PAGES = 4000;

export class HuduClient {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async page<T>(path: string, key: string, page: number): Promise<T[]> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/v1/${path}?page=${page}`, {
        headers: { 'x-api-key': this.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch {
      throw new HttpError(502, `Couldn't reach Hudu at ${this.baseUrl}. Check the address.`);
    }
    if (response.status === 401 || response.status === 403)
      throw new HttpError(400, 'Hudu rejected the API key. Check it has access to the data you want to import.');
    if (!response.ok) throw new HttpError(502, `Hudu answered ${response.status} for ${path}.`);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const items = body?.[key];
    if (!Array.isArray(items)) throw new HttpError(502, `Hudu's ${path} response wasn't in the expected format.`);
    return items as T[];
  }

  async all<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await this.page<T>(path, key, page);
      out.push(...items);
      if (items.length < PAGE_SIZE) break;
    }
    return out;
  }

  companies = () => this.all<HuduCompany>('companies', 'companies');
  layouts = () => this.all<HuduLayout>('asset_layouts', 'asset_layouts');
  assets = () => this.all<HuduAsset>('assets', 'assets');
  articles = () => this.all<HuduArticle>('articles', 'articles');
  passwords = () => this.all<HuduPassword>('asset_passwords', 'asset_passwords');
}

// Hudu field types → Atlas field types. Choice lists become text so any existing value imports cleanly.
const FIELD_TYPES: Record<string, FieldType | null> = {
  Text: 'text',
  RichText: 'textarea',
  Embed: 'textarea',
  Heading: null,
  CheckBox: 'checkbox',
  Website: 'url',
  Email: 'email',
  Number: 'number',
  Date: 'date',
  Dropdown: 'text',
  ListSelect: 'text',
  Phone: 'phone',
  AssetTag: 'text',
  AssetLink: 'text',
  // Password fields belong in the vault, not in asset fields.
  Password: null,
  ConfidentialText: null,
};

const slug = (label: string) => {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 36);
  return /^[a-z]/.test(s) ? s : `f_${s || 'field'}`.slice(0, 40);
};

/** Compares labels loosely: "Serial Number", " serial  number", and "serial_number" all match. */
const norm = (label: string) =>
  label
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();

// Integration data that looks like a credential stays out of Atlas.
const SECRET = /pass(word|phrase)?|secret|token|api.?key|private.?key|recovery|otp|pin$/i;

type MappedLayout = {
  fields: LayoutField[];
  byLabel: Map<string, LayoutField>;
  byId: Map<number, LayoutField>;
  /** Labels (normalized) and ids of Password/ConfidentialText fields, which are never imported. */
  excluded: Set<string | number>;
};

function mapLayout(layout: HuduLayout): MappedLayout {
  const used = new Set<string>();
  const fields: LayoutField[] = [];
  const byLabel = new Map<string, LayoutField>();
  const byId = new Map<number, LayoutField>();
  const excluded = new Set<string | number>();
  for (const f of [...(layout.fields ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const type = FIELD_TYPES[f.field_type] ?? (f.field_type in FIELD_TYPES ? null : 'text');
    if (!type) {
      excluded.add(norm(f.label));
      if (f.id !== undefined) excluded.add(f.id);
      continue;
    }
    if (fields.length >= 60) continue;
    let key = slug(f.label);
    for (let n = 2; used.has(key); n++) key = `${slug(f.label).slice(0, 36)}_${n}`;
    used.add(key);
    const field: LayoutField = {
      key,
      label: f.label.slice(0, 80) || key,
      type,
      required: false,
      options: [],
      help: htmlToText(f.hint ?? '').slice(0, 200),
      showInList: fields.length < 2,
      expires: type === 'date' && /expir|renew|warranty|end/i.test(f.label),
    };
    fields.push(field);
    if (!byLabel.has(norm(f.label))) byLabel.set(norm(f.label), field);
    if (f.id !== undefined) byId.set(f.id, field);
  }
  return { fields, byLabel, byId, excluded };
}

/** Flattens an integration card's data into "key: value" pairs (one level of nesting, no credentials). */
function cardEntries(data: unknown, prefix = ''): [string, string][] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const name = prefix ? `${prefix} ${key}` : key;
    if (SECRET.test(key) || value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      const items = value.filter((v) => v !== null && typeof v !== 'object').map(String);
      if (items.length) out.push([name, items.join(', ')]);
    } else if (typeof value === 'object') {
      if (!prefix) out.push(...cardEntries(value, name));
    } else out.push([name, String(value)]);
  }
  return out.slice(0, 80);
}

/**
 * Gathers everything Hudu knows about an asset into layout fields and notes: its own fields (matched by
 * layout field id, then loosely by label), older `custom_fields`, the primary email, and integration cards.
 * Integration data fills fields that are still blank; anything that doesn't fit a field goes into notes.
 */
function assetDetails(a: HuduAsset, layout: MappedLayout) {
  const fields: Record<string, unknown> = {};
  const labels = new Map<string, string>();
  const extra: string[] = [];
  /** Values no field of the layout takes: normalized name → a label for a new field. */
  const missing = new Map<string, string>();
  const put = (target: LayoutField, raw: unknown, overwrite: boolean) => {
    labels.set(target.key, target.label);
    if (!overwrite && fields[target.key] !== undefined) return true;
    const value = fieldValue(target, raw);
    if (value === undefined) return false;
    fields[target.key] = value;
    return true;
  };
  const present = (raw: unknown) => raw !== null && raw !== undefined && raw !== '';
  /** Puts a value in its field; one with no field is reported as missing and kept for the notes meanwhile. */
  const place = (name: string, raw: unknown, overwrite: boolean, lines: string[], integration = true) => {
    // Another system's record numbers are skipped; a layout's own fields (even "Asset ID") never are.
    if (!present(raw) || layout.excluded.has(norm(name)) || (integration && INTERNAL.test(name.trim()))) return;
    const target = fieldFor(layout, name);
    if (target && put(target, raw, overwrite)) return;
    if (!target) missing.set(norm(name), readableLabel(name));
    lines.push(`${readableLabel(name)}: ${htmlToText(String(raw)).slice(0, 500)}`);
  };

  for (const f of a.fields ?? []) {
    const label = (f.label ?? f.caption ?? '').trim();
    if (layout.excluded.has(norm(label)) || (f.asset_layout_field_id && layout.excluded.has(f.asset_layout_field_id)))
      continue;
    const byId = f.asset_layout_field_id !== undefined && layout.byId.get(f.asset_layout_field_id);
    if (byId) put(byId, f.value, true);
    else if (label) place(label, f.value, true, extra, false);
  }
  for (const entry of a.custom_fields ?? [])
    for (const [key, value] of Object.entries(entry ?? {})) place(key, value, false, extra);

  if (a.primary_mail) {
    const email = [...layout.byLabel.values()].find((f) => f.type === 'email' || /e-?mail/i.test(f.label));
    if (!email || !put(email, a.primary_mail, false)) extra.push(`Email: ${a.primary_mail}`);
  }
  place('Manufacturer', a.primary_manufacturer, false, extra);
  place('Model', a.primary_model, false, extra);
  place('Serial number', a.primary_serial, false, extra);

  const cards: string[] = [];
  for (const card of a.cards ?? []) {
    const lines: string[] = [];
    for (const [key, value] of cardEntries(card.data)) place(key, value, false, lines);
    if (lines.length) cards.push([`From ${card.integrator_name || 'an integration'}:`, ...lines].join('\n'));
  }

  // Only what still has no field (a layout at its 60-field limit) stays in the notes.
  const notes = [...extra, ...cards].filter(Boolean).join('\n').slice(0, 19000);
  return { fields, labels, notes, missing };
}

/**
 * Adds text fields for values a layout had no field for (up to the 60-field limit), and makes the mapped layout
 * aware of them so the values land there. Returns the labels added.
 */
async function addLayoutFields(
  layouts: LayoutService,
  actor: Actor,
  layout: MappedLayout & { id: string },
  missing: Map<string, string>,
): Promise<string[]> {
  const current = await layouts.get(actor, layout.id);
  const existing = current.fields as LayoutField[];
  const used = new Set(existing.map((f) => f.key));
  const added: LayoutField[] = [];
  for (const [key, label] of missing) {
    if (existing.length + added.length >= 60) break;
    if (layout.byLabel.has(norm(label))) continue;
    let fieldKey = slug(label);
    for (let n = 2; used.has(fieldKey); n++) fieldKey = `${slug(label).slice(0, 36)}_${n}`;
    used.add(fieldKey);
    const field: LayoutField = {
      key: fieldKey,
      label,
      type: 'text',
      required: false,
      options: [],
      help: 'Added by the Hudu import.',
      showInList: false,
      expires: false,
    };
    added.push(field);
    layout.byLabel.set(key, field);
    layout.byLabel.set(norm(label), field);
  }
  if (added.length) {
    await layouts.update(actor, layout.id, { fields: [...existing, ...added] });
    layout.fields.push(...added);
  }
  return added.map((f) => f.label);
}

// Integration keys that are another system's internal record numbers, not information about the asset.
const INTERNAL = /(^|[\s_])(id|guid|identifier)$|^(id|name)$|Guid$|[a-z]Id$/;

// The same information under the names integrations use for it (compared normalized).
const SYNONYMS: Record<string, string[]> = {
  'manufacturer name': ['manufacturer'],
  manufacturer: ['manufacturer name', 'make', 'vendor'],
  modelnumber: ['model'],
  'model number': ['model'],
  model: ['model number'],
  osinfo: ['operating system', 'os'],
  'os info': ['operating system', 'os'],
  ipaddress: ['ip address', 'ip'],
  macaddress: ['mac address', 'mac'],
  serial: ['serial number', 'serial no', 'service tag'],
  serialnumber: ['serial number', 'serial', 'service tag'],
  'serial number': ['serial', 'serial no', 'service tag'],
  'site name': ['location', 'site'],
  'location name': ['location'],
  'type name': ['type'],
  'status name': ['status'],
  ram: ['memory', 'ram'],
};

function fieldFor(layout: MappedLayout, name: string): LayoutField | undefined {
  const key = norm(name);
  return (
    layout.byLabel.get(key) ??
    (SYNONYMS[key] ?? []).map((s) => layout.byLabel.get(s)).find(Boolean) ??
    layout.byLabel.get(norm(readableLabel(name)))
  );
}

/** "cpuSpeed" → "CPU speed", "manufacturer name" → "Manufacturer name", "os_type" → "OS type". */
function readableLabel(name: string): string {
  const label = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\s]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .map((w) => (['ip', 'mac', 'os', 'cpu', 'ram', 'url', 'dns', 'ssid', 'vlan'].includes(w) ? w.toUpperCase() : w))
    .join(' ');
  return (label.charAt(0).toUpperCase() + label.slice(1)).slice(0, 80);
}

function fieldValue(field: LayoutField, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const text = typeof raw === 'string' ? raw : String(raw);
  switch (field.type) {
    case 'checkbox':
      return raw === true || /^(true|yes|1)$/i.test(text);
    case 'number': {
      const n = Number(text.replace(/,/g, ''));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date': {
      if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
      const parsed = new Date(text);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
    }
    case 'url':
      return /^https?:\/\//i.test(text) ? text.trim() : `https://${text.trim()}`;
    case 'textarea':
      return htmlToText(text).slice(0, 10000);
    default:
      return htmlToText(text).slice(0, 500);
  }
}

/** Retries a save without the fields the server rejected, keeping their values in the notes. */
async function saveTolerant<T>(
  fields: Record<string, unknown>,
  notes: string,
  labels: Map<string, string>,
  save: (fields: Record<string, unknown>, notes: string) => Promise<T>,
): Promise<T> {
  try {
    return await save(fields, notes);
  } catch (error) {
    if (!(error instanceof HttpError) || !error.fields) throw error;
    const rejected = Object.keys(error.fields)
      .filter((k) => k.startsWith('fields.'))
      .map((k) => k.slice(7));
    if (!rejected.length) throw error;
    const kept = { ...fields };
    const moved = rejected.map((k) => {
      const value = kept[k];
      delete kept[k];
      return `${labels.get(k) ?? k}: ${String(value)}`;
    });
    return save(kept, [notes, ...moved].filter(Boolean).join('\n'));
  }
}

/**
 * The sign-in address saved on a Hudu password: `login_url`. Hudu's `url` is its own link to the password's
 * page, so it's used only when there's no `login_url` and it doesn't point at the Hudu instance itself.
 */
export function loginAddress(p: Pick<HuduPassword, 'login_url' | 'url'>, huduBaseUrl: string): string {
  const login = (p.login_url ?? '').trim();
  if (login) return login;
  const url = (p.url ?? '').trim();
  if (!url) return '';
  try {
    if (new URL(url).host.toLowerCase() === new URL(huduBaseUrl).host.toLowerCase()) return '';
  } catch {
    // Not an absolute URL, so not a link to Hudu.
  }
  return url;
}

export async function previewHudu(client: HuduClient): Promise<HuduPreview> {
  const [companies, layouts, assets, articles, passwords] = await Promise.all([
    client.companies(),
    client.layouts(),
    client.assets(),
    client.articles(),
    client.passwords(),
  ]);
  return {
    companies: companies.filter((c) => !c.archived).length,
    assetLayouts: layouts.length,
    assets: assets.filter((a) => !a.archived).length,
    articles: articles.filter((a) => !a.archived).length,
    passwords: passwords.filter((p) => !p.archived).length,
  };
}

/**
 * Imports everything from Hudu: companies → clients (plus a location from the address), asset layouts → layouts,
 * assets, articles → documents (company articles per client, the rest in the knowledge base), and passwords →
 * each client's vault (folders flattened). Re-running updates what the previous run imported.
 */
export async function runHuduImport(
  db: Database,
  actor: Actor,
  client: HuduClient,
  run: ImportRun,
  vault: VaultService,
) {
  const scope = new Scope(db, actor);
  const clients = new ClientService(db);
  const layouts = new LayoutService(db);
  const assets = new AssetService(layouts);
  const documents = new DocumentService();
  const relations = new RelationService();

  // Companies
  const companyToClient = new Map<number, string>();
  for (const c of (await client.companies()).filter((x) => !x.archived)) {
    const notes = [
      htmlToText(c.notes ?? ''),
      c.website ? `Website: ${c.website}` : '',
      c.phone_number ? `Phone: ${c.phone_number}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 5000);
    const body = { name: c.name.slice(0, 200), type: (c.company_type || 'Customer').slice(0, 80), notes };
    const id = await run.upsert(
      'clients',
      c.id,
      c.name,
      async () => (await clients.create(actor, body)).id,
      async (existing) => void (await clients.update(actor, existing, body)),
    );
    if (!id) continue;
    companyToClient.set(c.id, id);
    if (c.address_line_1) {
      const location = {
        name: 'Main office',
        address: [c.address_line_1, c.address_line_2].filter(Boolean).join(', ').slice(0, 300),
        city: (c.city ?? '').slice(0, 120),
        region: (c.state ?? '').slice(0, 120),
        postalCode: (c.zip ?? '').slice(0, 20),
        country: (c.country_name ?? '').slice(0, 80),
        phone: (c.phone_number ?? '').slice(0, 40),
        primary: true,
      };
      await run.upsert(
        'locations',
        c.id,
        `${c.name} address`,
        async () => (await locations.create(scope, id, location)).id,
        async (existing) => void (await locations.update(scope, existing, location)),
      );
    }
  }

  // Asset layouts
  const layoutMap = new Map<number, MappedLayout & { id: string; name: string }>();
  for (const l of await client.layouts()) {
    const mapped = mapLayout(l);
    const body = {
      name: `${l.name}`.slice(0, 80),
      icon: 'box',
      description: 'Imported from Hudu',
      fields: mapped.fields,
    };
    const id = await run.upsert(
      'layouts',
      l.id,
      l.name,
      async () => (await layouts.create(actor, body)).id,
      async (existing) => {
        // Fields added since (by an earlier import for data Hudu's layout lacked, or by hand) are kept.
        const current = (await layouts.get(actor, existing)).fields as LayoutField[];
        const keys = new Set(mapped.fields.map((f) => f.key));
        for (const f of current)
          if (!keys.has(f.key) && mapped.fields.length < 60) {
            mapped.fields.push(f);
            if (!mapped.byLabel.has(norm(f.label))) mapped.byLabel.set(norm(f.label), f);
          }
        await layouts.update(actor, existing, { ...body, fields: mapped.fields });
      },
    );
    if (id) layoutMap.set(l.id, { ...mapped, id, name: l.name });
  }
  // Every value an asset carries gets a field: first a pass over all assets collects what no field of their
  // layout takes (integration data such as RAM or department, extra Hudu fields), and those fields are added
  // to the layout, so the import below puts each value in its own field instead of the notes.
  const huduAssets = (await client.assets()).filter((x) => !x.archived);
  const missingByLayout = new Map<number, Map<string, string>>();
  for (const a of huduAssets) {
    const layout = layoutMap.get(a.asset_layout_id);
    if (!layout || !companyToClient.has(a.company_id)) continue;
    const seen = missingByLayout.get(a.asset_layout_id) ?? new Map<string, string>();
    for (const [key, label] of assetDetails(a, layout).missing) if (!seen.has(key)) seen.set(key, label);
    missingByLayout.set(a.asset_layout_id, seen);
  }
  for (const [huduLayoutId, missing] of missingByLayout) {
    if (!missing.size) continue;
    const layout = layoutMap.get(huduLayoutId)!;
    const added = await addLayoutFields(layouts, actor, layout, missing);
    if (added.length)
      run.note(
        `${layout.name}: added ${added.length} field${added.length === 1 ? '' : 's'} for data the layout had no place for (${added
          .slice(0, 12)
          .join(', ')}${added.length > 12 ? ` and ${added.length - 12} more` : ''}).`,
      );
    const left = missing.size - added.length;
    if (left > 0)
      run.note(
        `${layout.name}: ${left} more value${left === 1 ? '' : 's'} didn't fit, because a layout holds at most 60 fields; they were kept in each asset's notes.`,
      );
  }

  // Assets
  const assetToAtlas = new Map<number, string>();
  for (const a of huduAssets) {
    const clientId = companyToClient.get(a.company_id);
    const layout = layoutMap.get(a.asset_layout_id);
    if (!clientId || !layout) {
      run.count('assets', 'skipped');
      run.note(`asset "${a.name}": its company or layout wasn't imported.`);
      continue;
    }
    const { fields, labels, notes } = assetDetails(a, layout);
    const name = a.name.slice(0, 200) || `Asset ${a.id}`;
    const assetId = await run.upsert(
      'assets',
      a.id,
      name,
      async () =>
        (
          await saveTolerant(fields, notes, labels, (f, n) =>
            assets.create(scope, clientId, { layoutId: layout.id, name, fields: f, notes: n }),
          )
        ).id,
      async (existing) => {
        const current = await assets.get(scope, existing);
        await saveTolerant(fields, notes, labels, (f, n) =>
          assets.update(scope, existing, { name, fields: f, notes: n, version: current.version }, 'Updated by import'),
        );
      },
    );
    if (assetId) assetToAtlas.set(a.id, assetId);
  }

  // Articles
  for (const a of (await client.articles()).filter((x) => !x.archived)) {
    const clientId = a.company_id ? companyToClient.get(a.company_id) : null;
    if (a.company_id && !clientId) {
      run.count('documents', 'skipped');
      continue;
    }
    const title = a.name.slice(0, 200) || `Article ${a.id}`;
    const content = htmlToRichText(a.content ?? '');
    await run.upsert(
      'documents',
      a.id,
      title,
      async () => (await documents.create(scope, { title, content, clientId: clientId ?? null })).id,
      async (existing) => {
        const current = await documents.get(scope, existing);
        await documents.update(scope, existing, { title, content, version: current.version }, 'Updated by import');
      },
    );
  }

  // Passwords: into each client's vault, in folders matching Hudu's (one level).
  const folderCache = new Map<string, string>();
  const folderFor = async (clientId: string, rawName: string) => {
    const name = rawName.trim().slice(0, 80);
    if (!name) return null;
    const key = `${clientId}|${name.toLowerCase()}`;
    if (!folderCache.has(key)) {
      const existing = (await vault.folders(scope, clientId)).find((f) => f.name.toLowerCase() === name.toLowerCase());
      folderCache.set(key, existing?.id ?? (await vault.createFolder(scope, clientId, { name })).id);
    }
    return folderCache.get(key)!;
  };
  for (const p of (await client.passwords()).filter((x) => !x.archived)) {
    const clientId = p.company_id ? companyToClient.get(p.company_id) : undefined;
    const name = p.name.slice(0, 200) || `Password ${p.id}`;
    if (!clientId || !p.password) {
      run.count('passwords', 'skipped');
      run.note(`password "${name}": ${!clientId ? 'not linked to an imported company' : 'no password stored'}.`);
      continue;
    }
    const totp = (p.otp_secret ?? '').replace(/\s+/g, '').toUpperCase();
    const address = loginAddress(p, client.baseUrl);
    const body = {
      name,
      username: (p.username ?? '').slice(0, 254),
      url: /^https?:\/\//i.test(address) ? address.slice(0, 2000) : '',
      secret: p.password.slice(0, 4096),
      notes: [htmlToText(p.description ?? ''), address && !/^https?:\/\//i.test(address) ? `Address: ${address}` : '']
        .filter(Boolean)
        .join('\n')
        .slice(0, 20000),
      totp: /^[A-Z2-7]{16,128}=*$/.test(totp) ? totp : '',
    };
    // Hudu's folder often says what a login is for ("Network", "M365"); fall back to Atlas's own guess.
    const fromFolder = p.password_folder_name ? guessPasswordCategory(p.password_folder_name) : 'other';
    const category = fromFolder !== 'other' ? fromFolder : null;
    // The same folder in Atlas, created the first time it's seen for this client.
    const folderId = p.password_folder_name ? await folderFor(clientId, p.password_folder_name) : null;
    if (totp && !body.totp) run.note(`password "${name}": the one-time code key wasn't valid and was left out.`);
    const passwordId = await run.upsert(
      'passwords',
      p.id,
      name,
      async () => (await vault.create(scope, clientId, { ...body, category, folderId }, 'import')).id,
      async (existing) => {
        const current = await vault.get(scope, existing);
        // Keep a type someone chose in Atlas; only fill it when it's still a guess. Likewise the folder.
        const keep = {
          ...(current.categoryGuessed ? { category } : {}),
          ...(current.folderId ? {} : { folderId }),
        };
        await vault.update(scope, existing, { ...body, ...keep, version: current.version }, 'import');
      },
    );
    // Link the password to the asset it was attached to in Hudu.
    const assetId =
      p.passwordable_type === 'Asset' && p.passwordable_id ? assetToAtlas.get(p.passwordable_id) : undefined;
    if (passwordId && assetId) {
      try {
        await relations.add(scope, 'password', passwordId, { type: 'asset', id: assetId });
      } catch {
        run.note(`password "${name}": couldn't be linked to its asset.`);
      }
    }
  }
}
