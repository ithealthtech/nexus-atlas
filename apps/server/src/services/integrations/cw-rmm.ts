import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { cwRmmMappingSchema, type Actor, type CwRmmCompany, type CwRmmRegion } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import { ClientService } from '../clients.js';
import { LayoutService } from '../layouts.js';
import { locations } from '../people.js';
import { Scope } from '../scope.js';
import type { SettingsService, StoredCwRmm } from '../settings.js';
import { ImportRun } from '../importers/common.js';

export const CW_RMM_BASE: Record<CwRmmRegion, string> = {
  na: 'https://openapi.service.itsupport247.net',
  eu: 'https://openapi.service.euplatform.connectwise.com',
  au: 'https://openapi.service.auplatform.connectwise.com',
};
const SCOPES = 'platform.companies.read platform.sites.read platform.devices.read';
const RETRY_MS = 2000;
// Five attempts at this length, plus the lead-in and the company prefix, fit an import job message (800 characters).
const ATTEMPT_CHARS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Json = Record<string, unknown>;

type DeviceQuery = { kind: 'v2'; resourceType: string; limit: number } | { kind: 'v1'; limit: number };
// ConnectWise doesn't publish which of these a tenant accepts; the first that works is kept for the run.
const DEVICE_QUERIES: DeviceQuery[] = [
  // A real tenant rejected the plural forms (clients, companies, sites) by name.
  { kind: 'v2', resourceType: 'client', limit: 100 },
  { kind: 'v2', resourceType: 'company', limit: 100 },
  { kind: 'v2', resourceType: 'site', limit: 100 },
  // Every device the key can see, kept to this company by each device's own company ID.
  { kind: 'v2', resourceType: 'partner', limit: 100 },
  { kind: 'v1', limit: 100 },
];

// The Asio API's field names vary between endpoints and versions, so each value is read from the first
// name that's present.
const pick = (o: Json, ...keys: string[]): unknown => {
  for (const key of keys) {
    const value = key.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Json)[k] : undefined), o);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};
const text = (o: Json, ...keys: string[]) => {
  const v = pick(o, ...keys);
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(', ');
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
};
/** The list inside a response, whatever it's called. */
const LIST_KEYS = ['data', 'items', 'results', 'companies', 'sites', 'endpoints', 'devices'];
const listOf = (body: unknown, depth = 0): Json[] => {
  if (Array.isArray(body)) return body as Json[];
  if (!body || typeof body !== 'object' || depth > 3) return [];
  const obj = body as Json;
  for (const key of LIST_KEYS) if (Array.isArray(obj[key])) return obj[key] as Json[];
  // Otherwise the first list of records anywhere inside (for example { data: { endpoints: [...] } }).
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.some((v) => v && typeof v === 'object')) return value as Json[];
    const nested = listOf(value, depth + 1);
    if (nested.length) return nested;
  }
  return [];
};
const DEVICE_ID_KEYS = [
  'endpointId',
  'endpointID',
  'endpoint_id',
  'endpoint.id',
  'endpoint.endpointId',
  'deviceId',
  'deviceID',
  'device.id',
  'resourceId',
  'agentId',
  'id',
];
/**
 * Every device record in a device-list response. ConnectWise groups them by category ({ platform: [...],
 * network: [...] }), and a record can itself hold the devices (for example a site with an endpoints list), so
 * all categories are gathered and records without a device ID of their own are opened up.
 */
function recordsOf(body: unknown, depth = 0): Json[] {
  if (depth > 4 || !body || typeof body !== 'object') return [];
  const items = Array.isArray(body)
    ? (body.filter((v) => v && typeof v === 'object') as Json[])
    : Object.values(body as Json).flatMap((v) => recordsOf(v, depth + 1));
  if (!Array.isArray(body)) return items;
  return items.flatMap((item) => {
    if (text(item, ...DEVICE_ID_KEYS)) return [item];
    const inner = Object.values(item).flatMap((v) => (Array.isArray(v) ? recordsOf(v, depth + 1) : []));
    return inner.length ? inner : [item];
  });
}
/** A response's field names (never values), two levels deep, for diagnosing an unexpected shape. */
const shapeOf = (body: unknown): string => {
  if (Array.isArray(body)) return `a list of ${body.length}`;
  if (!body || typeof body !== 'object') return typeof body;
  return Object.entries(body as Json)
    .map(([k, v]) =>
      Array.isArray(v)
        ? `${k}[${v.length}]`
        : v && typeof v === 'object'
          ? `${k}{${Object.keys(v as Json).slice(0, 8).join(',')}}`
          : k,
    )
    .slice(0, 12)
    .join(', ');
};

/** ConnectWise's own explanation of an error, trimmed for a job message. */
async function detail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  let message = raw;
  try {
    const body = JSON.parse(raw) as Json;
    message =
      text(body, 'message', 'error_description', 'error.message', 'detail', 'title', 'errors.0.message', 'error') ||
      raw;
  } catch {
    /* not JSON */
  }
  message = message.replace(/\s+/g, ' ').trim().slice(0, 200);
  return message ? ` ConnectWise said: ${message}` : '';
}

export interface RmmCompany {
  id: string;
  name: string;
}
export interface RmmSite {
  id: string;
  companyId: string;
  name: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}
export interface RmmDevice {
  id: string;
  companyId: string;
  siteId: string;
  name: string;
  hostname: string;
  type: string;
  os: string;
  ip: string;
  mac: string;
  manufacturer: string;
  model: string;
  serial: string;
}

/** Talks to the ConnectWise Asio platform API with an OAuth client-credentials token. */
export class CwRmmClient {
  /** What the last device list looked like, for a job note when a company comes back empty. */
  lastDeviceList = '';
  // One client (and so one token) per set of credentials, shared by every request and sync: signing in for
  // each page load gets the key locked.
  private static shared = new WeakMap<typeof fetch, Map<string, CwRmmClient>>();
  static for(region: CwRmmRegion, clientId: string, clientSecret: string, fetcher: typeof fetch = fetch) {
    const key = [region, clientId, createHash('sha256').update(clientSecret).digest('hex')].join('|');
    let clients = CwRmmClient.shared.get(fetcher);
    if (!clients) CwRmmClient.shared.set(fetcher, (clients = new Map()));
    let client = clients.get(key);
    if (!client) clients.set(key, (client = new CwRmmClient(region, clientId, clientSecret, fetcher)));
    return client;
  }

  private token: { value: string; expires: number } | null = null;
  private readonly base: string;

  constructor(
    region: CwRmmRegion,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.base = CW_RMM_BASE[region];
  }

  /** Concurrent callers share one sign-in: ConnectWise locks a key (423) that asks for many tokens at once. */
  private pending: Promise<string> | null = null;
  /** The device-list request this tenant accepted, once one has worked. */
  private deviceQuery: DeviceQuery | null = null;

  private bearer(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return Promise.resolve(this.token.value);
    this.pending ??= this.signIn().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Sends a request, waiting and retrying (up to 3 times) when ConnectWise says to slow down. */
  private async send(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await request();
      } catch {
        throw new HttpError(502, 'ConnectWise RMM could not be reached. Check the region and this server’s internet access.');
      }
      if (![423, 429, 503].includes(res.status) || attempt >= 3) return res;
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : RETRY_MS * 2 ** attempt);
    }
  }

  private async signIn(): Promise<string> {
    const res = await this.send(() =>
      this.fetcher(`${this.base}/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: SCOPES,
        }),
        signal: AbortSignal.timeout(20_000),
      }),
    );
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new HttpError(
        400,
        `ConnectWise RMM rejected the client ID or secret, or the key is missing a scope.${await detail(res)}`,
      );
    if (res.status === 423)
      throw new HttpError(
        502,
        'ConnectWise RMM has temporarily locked this API key after too many sign-ins. Wait a few minutes, then sync again.',
      );
    if (!res.ok) throw new HttpError(502, `ConnectWise RMM returned ${res.status} when signing in.${await detail(res)}`);
    const body = (await res.json()) as Json;
    const value = text(body, 'access_token', 'accessToken');
    if (!value) throw new HttpError(502, 'ConnectWise RMM did not return an access token.');
    const seconds = Number(pick(body, 'expires_in', 'expiresIn')) || 3600;
    this.token = { value, expires: Date.now() + seconds * 1000 };
    return value;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const token = await this.bearer();
    const res = await this.send(() =>
      this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      }),
    );
    const where = path.split('?')[0];
    if (res.status === 401 || res.status === 403)
      throw new HttpError(
        400,
        `ConnectWise RMM refused ${where}. Check the key's scopes in API Access.${await detail(res)}`,
      );
    if (!res.ok)
      throw new HttpError(
        res.status === 400 || res.status === 404 ? res.status : 502,
        `ConnectWise RMM returned ${res.status} for ${where}.${await detail(res)}`,
      );
    return res.json();
  }

  async companies(): Promise<RmmCompany[]> {
    return listOf(await this.call('GET', '/api/platform/v1/company/companies'))
      .map((c) => ({ id: text(c, 'id', 'companyId', 'clientId'), name: text(c, 'name', 'companyName', 'friendlyName') }))
      .filter((c) => c.id && c.name);
  }

  async sites(companyId: string): Promise<RmmSite[]> {
    return listOf(await this.call('GET', `/api/platform/v1/company/companies/${encodeURIComponent(companyId)}/sites`))
      .map((s) => ({
        id: text(s, 'id', 'siteId'),
        companyId,
        name: text(s, 'name', 'siteName', 'friendlyName') || 'Site',
        address: [text(s, 'address.line1', 'address.addressLine1', 'addressLine1', 'address1'), text(s, 'address.line2', 'addressLine2', 'address2')]
          .filter(Boolean)
          .join(', '),
        city: text(s, 'address.city', 'city'),
        region: text(s, 'address.state', 'address.region', 'state', 'region'),
        postalCode: text(s, 'address.postalCode', 'address.zip', 'postalCode', 'zip', 'zipCode'),
        country: text(s, 'address.country', 'country', 'countryName'),
      }))
      .filter((s) => s.id);
  }

  /** Every device for the company, page by page, using the first request shape the tenant accepts. */
  async devices(companyId: string, siteIds: string[] = []): Promise<RmmDevice[]> {
    const shapes = this.deviceQuery ? [this.deviceQuery] : DEVICE_QUERIES;
    const tried: string[] = [];
    for (const shape of shapes) {
      if (shape.kind === 'v2' && shape.resourceType === 'site' && !siteIds.length) continue;
      try {
        const devices = await this.devicePages(companyId, siteIds, shape);
        this.deviceQuery = shape;
        return devices;
      } catch (error) {
        // Only a rejected request is worth trying another shape for.
        if (!(error instanceof HttpError && error.status === 400)) throw error;
        const said = /ConnectWise said: (.*)$/.exec(error.message)?.[1] ?? error.message;
        // Each attempt gets its own share of the job message, so a long answer can't hide a later one.
        const short = said.length > ATTEMPT_CHARS ? `${said.slice(0, ATTEMPT_CHARS - 1)}…` : said;
        tried.push(`${shape.kind === 'v2' ? `v2 by ${shape.resourceType}` : 'v1 list'}: ${short}`);
      }
    }
    // Every shape's answer, so one message shows whether it's the request or the key's permissions.
    throw new HttpError(
      400,
      `ConnectWise RMM wouldn't list devices. Check the API key has the Devices read permission. Tried ${tried.join('; ')}`,
    );
  }

  private async devicePages(companyId: string, siteIds: string[], shape: DeviceQuery): Promise<RmmDevice[]> {
    const out: RmmDevice[] = [];
    // Only lists that aren't already limited to the company need filtering; a device's own company ID may use
    // a different numbering than the company list, so trusting it elsewhere could drop every device.
    const filter = shape.kind === 'v1' || shape.resourceType === 'partner';
    const via = shape.kind === 'v2' ? `v2 by ${shape.resourceType}` : 'v1 list';
    let seen = 0;
    let otherCompany = 0;
    let noId: Json | undefined;
    this.lastDeviceList = `${via}: no response`;
    for (let cursor = 0, pages = 0; pages < 500; pages++) {
      const query = `limit=${shape.limit}&cursor=${cursor}`;
      let body: unknown;
      try {
        body =
          shape.kind === 'v2'
            ? await this.call('POST', `/api/platform/v2/device/categories/all/endpoints?${query}`, {
                resourceType: shape.resourceType,
                resources:
                  shape.resourceType === 'site' ? siteIds : shape.resourceType === 'partner' ? [] : [companyId],
              })
            : await this.call(
                'GET',
                `/api/platform/v1/device/endpoints?${query}&clientId=${encodeURIComponent(companyId)}`,
              );
      } catch (error) {
        // ConnectWise answers "resource not found" (404) for a company with no devices, or past the last page. A
        // request it can't read gets 400, so a 404 still means the request itself was accepted.
        if (error instanceof HttpError && error.status === 404) {
          if (!pages) this.lastDeviceList = `${via}: resource not found`;
          break;
        }
        throw error;
      }
      const page = recordsOf(body);
      seen += page.length;
      for (const d of page) {
        const id = text(d, ...DEVICE_ID_KEYS);
        if (!id) {
          noId ??= d;
          continue;
        }
        const owner = text(d, 'companyId', 'clientId', 'company.id', 'client.id');
        if (filter && owner && owner !== companyId) {
          otherCompany++;
          continue;
        }
        const hostname = text(d, 'hostName', 'hostname', 'system.hostName', 'computerName');
        out.push({
          id,
          companyId,
          siteId: text(d, 'siteId', 'site.id'),
          name: text(d, 'friendlyName', 'name', 'displayName') || hostname || `Device ${id}`,
          hostname,
          type: text(d, 'endpointType', 'deviceType', 'type', 'classification', 'category'),
          os: text(d, 'os.name', 'os.product', 'operatingSystem.name', 'operatingSystem', 'osName', 'os'),
          ip: text(d, 'ipAddress', 'localIpAddress', 'network.ipAddress', 'ipAddresses'),
          mac: text(d, 'macAddress', 'network.macAddress', 'macAddresses'),
          manufacturer: text(d, 'manufacturer', 'system.manufacturer', 'hardware.manufacturer'),
          model: text(d, 'model', 'system.model', 'hardware.model'),
          serial: text(d, 'serialNumber', 'system.serialNumber', 'hardware.serialNumber', 'bios.serialNumber'),
        });
      }
      if (!pages)
        this.lastDeviceList = `${via}: response fields ${shapeOf(body)}; ${page.length} records on the first page`;
      const next = Number(pick((body ?? {}) as Json, 'nextCursor', 'pageInfo.nextCursor', 'next'));
      if (page.length < shape.limit) break;
      cursor = Number.isFinite(next) && next > cursor ? next : cursor + page.length;
    }
    if (seen && !out.length)
      this.lastDeviceList +=
        `; ${otherCompany} belonged to another company, ${seen - otherCompany} had no device ID` +
        (noId ? `; a record without one has fields ${shapeOf(noId)}` : '');
    return out;
  }
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
 * Syncs linked companies: sites become locations, devices become Configurations assets. A device the RMM no
 * longer reports is archived, but only when its company's device list was fetched in full.
 */
export async function runCwRmmSync(db: Database, actor: Actor, client: CwRmmClient, run: ImportRun, map: StoredCwRmm['map']) {
  const scope = new Scope(db, actor);
  const assets = new AssetService(new LayoutService(db));
  const [layout] = await db
    .select({ id: schema.assetLayouts.id, archived: schema.assetLayouts.archived })
    .from(schema.assetLayouts)
    .where(and(eq(schema.assetLayouts.orgId, actor.orgId), eq(schema.assetLayouts.key, 'configuration')));
  if (!layout || layout.archived)
    throw new HttpError(400, 'The Configurations asset layout is missing or archived. Restore it to sync devices.');

  const linked = Object.entries(map).flatMap(([companyId, m]) => (m.action === 'link' ? [[companyId, m.clientId] as const] : []));
  if (!linked.length) run.note('No ConnectWise RMM companies are linked to Atlas clients yet.');
  const seen = new Set<string>();
  const complete: string[] = [];
  for (const [companyId, clientId] of linked) {
    let sites: RmmSite[];
    let devices: RmmDevice[];
    try {
      // One request at a time: ConnectWise rate-limits bursts.
      sites = await client.sites(companyId);
      devices = await client.devices(
        companyId,
        sites.map((s) => s.id),
      );
    } catch (error) {
      run.count('assets', 'failed');
      run.note(`Company ${companyId}: ${error instanceof HttpError ? error.message : 'could not be read.'}`);
      continue;
    }
    // Field names only (never values), so an unexpected response can be diagnosed from the job log.
    if (!devices.length) run.note(`Company ${companyId}: no devices listed (${client.lastDeviceList}).`);
    const siteNames = new Map<string, string>();
    for (const s of sites) {
      siteNames.set(s.id, s.name);
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
    for (const d of devices) {
      seen.add(d.id);
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
      };
      const name = d.name.slice(0, 200);
      await run.upsert(
        'assets',
        d.id,
        name,
        async () =>
          (await assets.create(scope, clientId, { layoutId: layout.id, name, fields, notes: 'Synced from ConnectWise RMM.' }))
            .id,
        async (existing) => {
          const current = await assets.get(scope, existing);
          // Fields Atlas users added stay; the RMM's own values are refreshed.
          const merged = { ...current.fields, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) };
          if (current.archived) await assets.setArchived(scope, existing, false);
          if (current.name !== name || JSON.stringify(merged) !== JSON.stringify(current.fields))
            await assets.update(scope, existing, { name, fields: merged, version: current.version }, 'Synced from ConnectWise RMM');
        },
      );
    }
    complete.push(clientId);
  }

  // Archive devices removed from the RMM, within the companies read in full.
  if (complete.length) {
    const refs = await db
      .select({ externalId: schema.externalRefs.externalId, id: schema.assets.id, archived: schema.assets.archived })
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
    for (const r of refs)
      if (!seen.has(r.externalId) && !r.archived) {
        await assets.setArchived(scope, r.id, true);
        archived++;
      }
    if (archived)
      run.note(`Archived ${archived} device${archived === 1 ? '' : 's'} ConnectWise RMM no longer reports.`);
  }
}
