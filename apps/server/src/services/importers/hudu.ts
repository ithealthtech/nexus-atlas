import type { Database } from '@atlas/db';
import type { Actor, FieldType, HuduPreview, LayoutField } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import { ClientService } from '../clients.js';
import { DocumentService } from '../documents.js';
import { LayoutService } from '../layouts.js';
import { locations } from '../people.js';
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
  fields?: { label: string; value: unknown }[];
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
  url?: string | null;
  description?: string | null;
  otp_secret?: string | null;
  archived?: boolean;
};

const PAGE_SIZE = 25;
const MAX_PAGES = 4000;

export class HuduClient {
  constructor(
    private readonly baseUrl: string,
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

function mapLayout(layout: HuduLayout): { fields: LayoutField[]; byLabel: Map<string, LayoutField> } {
  const used = new Set<string>();
  const fields: LayoutField[] = [];
  const byLabel = new Map<string, LayoutField>();
  for (const f of [...(layout.fields ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    const type = FIELD_TYPES[f.field_type] ?? (f.field_type in FIELD_TYPES ? null : 'text');
    if (!type || fields.length >= 60) continue;
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
    byLabel.set(f.label, field);
  }
  return { fields, byLabel };
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
  const layoutMap = new Map<number, { id: string; byLabel: Map<string, LayoutField> }>();
  for (const l of await client.layouts()) {
    const { fields, byLabel } = mapLayout(l);
    const body = { name: `${l.name}`.slice(0, 80), icon: 'box', description: 'Imported from Hudu', fields };
    const id = await run.upsert(
      'layouts',
      l.id,
      l.name,
      async () => (await layouts.create(actor, body)).id,
      async (existing) => void (await layouts.update(actor, existing, body)),
    );
    if (id) layoutMap.set(l.id, { id, byLabel });
  }

  // Assets
  for (const a of (await client.assets()).filter((x) => !x.archived)) {
    const clientId = companyToClient.get(a.company_id);
    const layout = layoutMap.get(a.asset_layout_id);
    if (!clientId || !layout) {
      run.count('assets', 'skipped');
      run.note(`asset "${a.name}": its company or layout wasn't imported.`);
      continue;
    }
    const fields: Record<string, unknown> = {};
    const labels = new Map<string, string>();
    for (const f of a.fields ?? []) {
      const target = layout.byLabel.get(f.label);
      if (!target) continue;
      const value = fieldValue(target, f.value);
      if (value !== undefined) fields[target.key] = value;
      labels.set(target.key, target.label);
    }
    const notes = [
      a.primary_manufacturer && `Manufacturer: ${a.primary_manufacturer}`,
      a.primary_model && `Model: ${a.primary_model}`,
      a.primary_serial && `Serial: ${a.primary_serial}`,
    ]
      .filter(Boolean)
      .join('\n');
    const name = a.name.slice(0, 200) || `Asset ${a.id}`;
    await run.upsert(
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

  // Passwords: flattened into each client's vault.
  for (const p of (await client.passwords()).filter((x) => !x.archived)) {
    const clientId = p.company_id ? companyToClient.get(p.company_id) : undefined;
    const name = p.name.slice(0, 200) || `Password ${p.id}`;
    if (!clientId || !p.password) {
      run.count('passwords', 'skipped');
      run.note(`password "${name}": ${!clientId ? 'not linked to an imported company' : 'no password stored'}.`);
      continue;
    }
    const totp = (p.otp_secret ?? '').replace(/\s+/g, '').toUpperCase();
    const body = {
      name,
      username: (p.username ?? '').slice(0, 254),
      url: p.url && /^https?:\/\//i.test(p.url) ? p.url.slice(0, 2000) : '',
      secret: p.password.slice(0, 4096),
      notes: [htmlToText(p.description ?? ''), p.url && !/^https?:\/\//i.test(p.url) ? `Address: ${p.url}` : '']
        .filter(Boolean)
        .join('\n')
        .slice(0, 20000),
      totp: /^[A-Z2-7]{16,128}=*$/.test(totp) ? totp : '',
    };
    if (totp && !body.totp) run.note(`password "${name}": the one-time code key wasn't valid and was left out.`);
    await run.upsert(
      'passwords',
      p.id,
      name,
      async () => (await vault.create(scope, clientId, body, 'import')).id,
      async (existing) => {
        const current = await vault.get(scope, existing);
        await vault.update(scope, existing, { ...body, version: current.version }, 'import');
      },
    );
  }
}
