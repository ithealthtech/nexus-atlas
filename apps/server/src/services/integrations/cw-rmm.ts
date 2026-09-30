import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { cwRmmMappingSchema, cwRmmSyncOptionsSchema, type CwRmmSyncOptions, type Actor, type AssetView, type CwRmmCompany, type CwRmmRegion, type LayoutField, type RmmDeviceKind, type RmmProtection, MAX_LAYOUT_FIELDS } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import { ClientService } from '../clients.js';
import { LayoutService } from '../layouts.js';
import { contacts as contactService, locations } from '../people.js';
import { Scope } from '../scope.js';
import type { SettingsService, StoredCwRmm } from '../settings.js';
import { ImportRun } from '../importers/common.js';
import { detectManufacturer, normalizeManufacturer } from '../manufacturer.js';
import type { WarrantyLookup } from '../warranty-lookup.js';
import { readableLabel } from '../importers/hudu.js';

export const CW_RMM_BASE: Record<CwRmmRegion, string> = {
  na: 'https://openapi.service.itsupport247.net',
  eu: 'https://openapi.service.euplatform.connectwise.com',
  au: 'https://openapi.service.auplatform.connectwise.com',
};
const SCOPES = 'platform.companies.read platform.sites.read platform.devices.read';
/** Running the rotation script needs automation scopes too. Only rotation asks for them, so a key without them still syncs. */
export const ROTATION_SCOPES = `${SCOPES} platform.automation.read platform.automation.create`;
/** Tickets get their own token, so a key without ticket access still syncs devices. */
export const TICKET_SCOPES = 'platform.companies.read platform.tickets.read';
const RETRY_MS = 2000;
/** The code on errors that mean the key can't sign in or lacks a permission: no other request shape will help. */
export const ACCESS_DENIED = 'cw_access_denied';
// Five attempts at this length, plus the lead-in and the company prefix, fit an import job message (800 characters).
const ATTEMPT_CHARS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Json = Record<string, unknown>;

type DeviceQuery = { kind: 'v2'; resourceType: string; limit: number } | { kind: 'v1'; limit: number };
// The platform API spec takes company, site, or endpoint as the resource type, up to 500 devices a page. The first
// shape that works is kept for the run; the others are older fallbacks, tried only if the spec's are refused.
const DEVICE_QUERIES: DeviceQuery[] = [
  { kind: 'v2', resourceType: 'company', limit: 500 },
  { kind: 'v2', resourceType: 'site', limit: 500 },
  { kind: 'v2', resourceType: 'client', limit: 100 },
  // Every device the key can see, kept to this company by each device's own company ID.
  { kind: 'v2', resourceType: 'partner', limit: 100 },
  { kind: 'v1', limit: 100 },
];

// The Asio API's field names vary between endpoints and versions, so each value is read from the first
// name that's present.
export const pick = (o: Json, ...keys: string[]): unknown => {
  for (const key of keys) {
    const value = key.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Json)[k] : undefined), o);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};
export const text = (o: Json, ...keys: string[]) => {
  const v = pick(o, ...keys);
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join(', ');
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
};
/** The list inside a response, whatever it's called. */
const LIST_KEYS = ['data', 'items', 'results', 'companies', 'sites', 'contacts', 'endpoints', 'devices', 'tickets'];
export const listOf = (body: unknown, depth = 0): Json[] => {
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
 * The device inside a details response: the body itself when it is the device, else the record carrying this
 * device's ID (for example under data, or in a one-item list). Its own lists, like network interfaces, are
 * fields of the device, not the device.
 */
function deviceObject(body: unknown, id: string): Json {
  const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
  if (isObject(body) && text(body, ...DEVICE_ID_KEYS)) return body;
  const match = recordsOf(body).find((r) => text(r, ...DEVICE_ID_KEYS) === id);
  if (match) return match;
  if (isObject(body)) {
    const inner = Object.values(body).filter(isObject);
    if (inner.length === 1) return inner[0]!;
    return body;
  }
  return {};
}

const SITE_ID_KEYS =['siteId', 'siteID', 'site_id', 'site.id', 'site.siteId'];
const DETAIL_CONCURRENCY = 4;
// The platformEndpointDetail fields Atlas reads: the device's own, the maker (baseboard; bios is kept as a field),
// and endpoint protection (antiViruses, and services, which mark antivirus services and their status).
const DETAIL_FIELDS = [
  'deviceName',
  'friendlyName',
  'resourceType',
  'endpointType',
  'ipAddress',
  'macAddress',
  'type',
  'subResourceType',
  'remoteAddress',
  'virtualType',
  'os',
  'system',
  'baseboard',
  'bios',
  'antiViruses',
  'services',
].join(',');

/** Maps a device record (summary merged with details) onto Atlas's fields, reading whichever names are present. */
function mapDevice(id: string, companyId: string, siteId: string, record: Json): RmmDevice {
  // ConnectWise's details put a device's own fields under its category, e.g. platform{deviceName, ipAddress,
  // macAddress, type}; those are read as if they were top-level.
  const category = ['platform', 'network', 'cloud'].find((k) => {
    const v = record[k];
    return v && typeof v === 'object' && !Array.isArray(v);
  });
  const { [category ?? '']: inner, ...rest } = record;
  const d: Json = category ? { ...rest, ...(inner as Json) } : record;
  const hostname = text(
    d,
    'hostName',
    'hostname',
    'system.hostName',
    'system.hostname',
    'computerName',
    'machineName',
    'deviceName',
    'systemName',
  );
  return {
    id,
    companyId,
    siteId,
    name: text(d, 'friendlyName', 'name', 'displayName', 'endpointName') || hostname || `Device ${id}`,
    hostname,
    type: text(d, 'endpointType', 'subResourceType', 'deviceType', 'type', 'classification', 'category', 'deviceClass', 'os.type'),
    os: text(
      d,
      'os.name',
      'os.product',
      'os.caption',
      'os.productName',
      'operatingSystem.name',
      'operatingSystem.caption',
      'operatingSystem',
      'osName',
      'osType',
      'os',
    ),
    ip: text(
      d,
      'ipAddress',
      'localIpAddress',
      'privateIpAddress',
      'internalIpAddress',
      'network.ipAddress',
      'networkInterfaces.0.ipAddress',
      'networkInterfaces.0.ipv4',
      'networkAdapters.0.ipAddress',
      'networks.0.ipv4',
      'ipAddresses',
      'ipv4',
    ),
    mac: text(
      d,
      'macAddress',
      'network.macAddress',
      'networkInterfaces.0.macAddress',
      'networkAdapters.0.macAddress',
      'networks.0.macAddress',
      'macAddresses',
    ),
    // Firmware names ("Dell Inc.", "To be filled by O.E.M.") are tidied; a blank one is filled in when the asset is saved.
    manufacturer: normalizeManufacturer(makerOf(d)),
    model: text(d, 'model', 'system.model', 'hardware.model', 'systemModel', 'productName'),
    serial: text(
      d,
      'serialNumber',
      'system.serialNumber',
      'hardware.serialNumber',
      'bios.serialNumber',
      'baseBoard.serialNumber',
      'serial',
    ),
    online: onlineState(pick(d, ...ONLINE_KEYS)),
    lastSeenAt: lastSeenOf(d),
    warrantyExpires: warrantyDate(pick(d, ...WARRANTY_KEYS)),
    ...protectionOf(d),
    // The manufacturer goes in the Manufacturer field only, not a second field named after where it was found.
    extra: extraValues(d, '', 0, new Set([makerPath(d) ?? ''])),
  };
}

// Health values for the RMM health charts. ConnectWise doesn't document these names for every endpoint type, so,
// as above, the first name present is used; a value that can't be read counts as unknown, never as a guess.
const ONLINE_KEYS = [
  'isOnline',
  'online',
  'availabilityStatus',
  'availability',
  'onlineStatus',
  'connectivity.status',
  'agent.status',
  'agentStatus',
];
const LAST_SEEN_KEYS = [
  // The heartbeat API's time of the agent's last heartbeat.
  'DcDateTimeUTC',
  'dcDateTimeUTC',
  'lastSeen',
  'lastSeenAt',
  'lastSeenDate',
  'lastContact',
  'lastContactTime',
  'lastCheckIn',
  'lastCheckin',
  'lastCheckInTime',
  'lastHeartbeat',
  'lastCommunicated',
  'agent.lastContact',
  'agent.lastSeen',
];
const WARRANTY_KEYS = [
  'warrantyExpirationDate',
  'warrantyExpiryDate',
  'warrantyExpiration',
  'warrantyEndDate',
  'warrantyEnd',
  'warranty.expirationDate',
  'warranty.endDate',
  'warranty.expires',
  'hardware.warrantyExpirationDate',
  'system.warrantyExpirationDate',
];
const PROTECTION_OBJECTS = ['endpointProtection', 'antivirus', 'antiVirus', 'av', 'securityProduct', 'security.antivirus'];

/** Every plain value in a record with its dotted path, nested objects opened (lists aren't). */
function leaves(o: Json, prefix = '', depth = 0): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [key, value] of Object.entries(o)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      if (!Array.isArray(value) && depth < 3) out.push(...leaves(value as Json, path, depth + 1));
    } else if (value !== null && value !== undefined && value !== '') out.push([path, value]);
  }
  return out;
}

// ConnectWise's names for these vary by tenant and agent (systemManufacturer, lastContactedAt, ...), so when none
// of the names listed above is present, a field whose name says what it is is used.
// ConnectWise's endpoint details give the maker as baseboard.manufacturer; bios.manufacturer is the firmware vendor.
const MAKER_NAMES = [
  'manufacturer',
  'system.manufacturer',
  'hardware.manufacturer',
  'baseboard.manufacturer',
  'baseBoard.manufacturer',
  'vendor',
];
const MAKER_KEY = /^(system|computer|hardware|device|machine|product|endpoint|oem)?_?(manufacturer|make)(_?name)?$/i;
// A BIOS, board, or part maker (American Megatrends, Intel) isn't the device's.
const MAKER_SKIP = /bios|firmware|board|processor|cpu|gpu|video|display|monitor|disk|drive|memory|ram|network|adapter|nic|battery|printer|software|antivirus|protection|os\b|operatingsystem/i;
const makerPath = (d: Json) =>
  MAKER_NAMES.find((k) => text(d, k)) ??
  leaves(d).find(([path, v]) => {
    const parts = path.split('.');
    return typeof v === 'string' && MAKER_KEY.test(parts.pop()!) && !MAKER_SKIP.test(parts.join('.'));
  })?.[0];
const makerOf = (d: Json) => {
  const path = makerPath(d);
  return path ? text(d, path) : '';
};

const SEEN_KEY = /^(last|latest)_?(seen|contact|contacted|check_?in|heartbeat|communicat|connect|report|sync|online|agent)|(heartbeat|check_?in|contact)_?(time|date|at|on|timestamp)?$/i;
const SEEN_SKIP = /boot|logon|login|loggedon|user|patch|scan|reboot|install|shutdown|restart/i;
const seenPath = (d: Json) =>
  LAST_SEEN_KEYS.find((k) => seenAt(pick(d, k))) ??
  leaves(d).find(([path, v]) => {
    const key = path.split('.').pop()!;
    return SEEN_KEY.test(key) && !SEEN_SKIP.test(path) && seenAt(v) !== null;
  })?.[0];
/** When the agent last checked in, from a listed name or one that plainly says so; null when nothing does. */
export function lastSeenOf(d: Json): string | null {
  const path = seenPath(d);
  return path ? seenAt(pick(d, path)) : null;
}

const PROTECTION_KEY = /anti_?virus|endpoint_?protection|security_?product|defender|(^|\s)edr(\s|$)/i;
const AV_KEY = /(^|\s)(av|AV)([A-Z_\s]|$)/; // av, avStatus, AV_state; not availability
/** Endpoint protection values found by name (antivirusStatus, endpointProtection.state, ...). */
const protectionLeaves = (d: Json) =>
  leaves(d).filter(([path]) => PROTECTION_KEY.test(path.replace(/\./g, ' ')) || AV_KEY.test(path.replace(/\./g, ' ')));

/** true for online, false for offline, null when the value doesn't say. */
export function onlineState(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (/^(online|up|connected|available|true|yes)$/.test(v)) return true;
  if (/^(offline|down|disconnected|unavailable|unreachable|false|no)$/.test(v)) return false;
  return null;
}

/** A check-in time as ISO, from an ISO string or a Unix time in seconds or milliseconds; null if unreadable. */
export function seenAt(value: unknown, now = Date.now()): string | null {
  let ms: number;
  if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string' && /^\d{9,13}$/.test(value.trim())) return seenAt(Number(value), now);
  else if (typeof value === 'string') ms = Date.parse(value);
  else return null;
  // Before 2000 or more than a day ahead is a placeholder or a bad clock, not a check-in.
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > now + 86_400_000) return null;
  return new Date(ms).toISOString();
}

/** A warranty end date as YYYY-MM-DD, from a date string or a Unix time; '' when missing or implausible. */
export function warrantyDate(value: unknown): string {
  let ms: number;
  if (typeof value === 'number') ms = value < 1e11 ? value * 1000 : value;
  else if (typeof value === 'string' && /^\d{9,13}$/.test(value.trim())) return warrantyDate(Number(value));
  else if (typeof value === 'string') ms = Date.parse(value.trim());
  else return '';
  if (!Number.isFinite(ms) || ms < Date.UTC(1990, 0, 1) || ms > Date.UTC(2100, 0, 1)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Endpoint protection: running, installed but not running, or missing, with the product name when given. */
export function protectionOf(d: Json): { protection: RmmProtection | null; protectionProduct: string } {
  // ConnectWise's endpoint details: antiViruses lists the products running, and services marks antivirus services
  // with their status.
  const avServices = (Array.isArray(d.services) ? (d.services as Json[]) : []).filter(
    (s) => s && typeof s === 'object' && s.antivirus === true,
  );
  if (avServices.length) {
    const up = avServices.filter((s) => /^(running|started)$/i.test(text(s, 'serviceStatus', 'status')));
    return {
      protection: up.length ? 'running' : 'not_running',
      protectionProduct: text((up[0] ?? avServices[0])!, 'displayName', 'serviceName').slice(0, 200),
    };
  }
  if (Array.isArray(d.antiViruses)) {
    const names = [
      ...new Set((d.antiViruses as Json[]).map((a) => (a && typeof a === 'object' ? text(a, 'name', 'applicationName') : ''))),
    ].filter(Boolean);
    return names.length
      ? { protection: 'running', protectionProduct: names.join(', ').slice(0, 200) }
      : { protection: 'missing', protectionProduct: '' };
  }
  const obj = PROTECTION_OBJECTS.map((k) => pick(d, k)).find(
    (v): v is Json => !!v && typeof v === 'object' && !Array.isArray(v),
  );
  const product = (
    (obj && text(obj, 'name', 'product', 'productName', 'vendor')) ||
    text(d, 'antivirusProduct', 'antivirusName', 'avProduct', 'endpointProtectionProduct', 'securityProductName') ||
    String(protectionLeaves(d).find(([path, v]) => typeof v === 'string' && /(name|product|vendor)$/i.test(path.split('.').pop()!))?.[1] ?? '')
  ).slice(0, 200);
  // Any other value named for the protection, by what its name ends with.
  const loose = (end: RegExp) => protectionLeaves(d).find(([path]) => end.test(path.split('.').pop()!))?.[1];
  const installed =
    pick(obj ?? {}, 'installed', 'isInstalled') ??
    pick(d, 'isAntivirusInstalled', 'antivirusInstalled') ??
    loose(/installed$/i);
  const running =
    pick(obj ?? {}, 'running', 'isRunning', 'enabled', 'isEnabled', 'active') ??
    pick(d, 'isAntivirusRunning', 'antivirusRunning', 'antivirusEnabled') ??
    loose(/(running|enabled|active|protected)$/i);
  const bare = pick(d, ...PROTECTION_OBJECTS);
  const status = String(
    pick(obj ?? {}, 'status', 'state', 'protectionStatus') ??
      pick(d, 'antivirusStatus', 'avStatus', 'endpointProtectionStatus', 'protectionStatus') ??
      (typeof bare === 'string' ? bare : undefined) ??
      loose(/(status|state)$/i) ??
      '',
  )
    .trim()
    .toLowerCase();
  // "Installed" on its own doesn't say whether it runs, so it stays unknown.
  let protection: RmmProtection | null = null;
  if (installed === false || /^(not ?installed|none|missing|absent|no ?av|unprotected|not ?found)$/.test(status))
    protection = 'missing';
  else if (running === true || /^(running|active|enabled|protected|on|ok|healthy|up ?to ?date)$/.test(status))
    protection = 'running';
  else if (running === false || /^(disabled|stopped|not ?running|inactive|off|expired|out ?of ?date|outdated|at ?risk|not ?protected)$/.test(status))
    protection = 'not_running';
  return { protection, protectionProduct: product };
}

// Values the named fields above already carry; everything else ConnectWise sends is kept as its own field.
const MAPPED = new Set(
  [
    'hostName',
    'hostname',
    'deviceName',
    'computerName',
    'machineName',
    'systemName',
    'friendlyName',
    'name',
    'displayName',
    'endpointName',
    'ipAddress',
    'localIpAddress',
    'macAddress',
    'endpointType',
    'osName',
    'operatingSystem',
    'manufacturer',
    'model',
    'serialNumber',
    'serial',
    'warrantyExpirationDate',
    'warrantyExpiryDate',
    'warrantyExpiration',
    'warrantyEndDate',
    'warrantyEnd',
  ].map((k) => k.toLowerCase()),
);
const CATEGORIES = new Set(['platform', 'network', 'cloud']);
// Read for endpoint protection only: a device's full service list isn't worth a field per service.
const NOT_KEPT = new Set(['services']);

/** Every other value in a device record, as [label, value]: nested objects flattened, lists of values joined. */
function extraValues(record: Json, prefix = '', depth = 0, skip = new Set<string>(), path = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === '') continue;
    const at = path ? `${path}.${key}` : key;
    if (skip.has(at)) continue;
    // The category object's fields were read as the device's own, so they aren't prefixed with it.
    if (!prefix && CATEGORIES.has(key) && typeof value === 'object' && !Array.isArray(value)) continue;
    if (!prefix && (MAPPED.has(key.toLowerCase()) || NOT_KEPT.has(key))) continue;
    const label = prefix ? `${prefix} ${key}` : key;
    if (Array.isArray(value)) {
      const items = value.filter((v) => v !== null && typeof v !== 'object').map(String);
      if (items.length) out.push([readableLabel(label), items.join(', ').slice(0, 2000)]);
      else if (depth < 2)
        value
          .filter((v): v is Json => !!v && typeof v === 'object')
          .forEach((v, i) => out.push(...extraValues(v, value.length > 1 ? `${label} ${i + 1}` : label, depth + 1, skip, `${at}.${i}`)));
    } else if (typeof value === 'object') {
      if (depth < 2) out.push(...extraValues(value as Json, label, depth + 1, skip, at));
    } else out.push([readableLabel(label), String(value).slice(0, 2000)]);
  }
  return out.slice(0, 150);
}

/** The cursor of the rel="next" URL in a Link header, or null when there's no next page. */
export function nextCursorOf(link: string | null): number | null {
  for (const part of (link ?? '').split(',')) {
    const m = /<([^>]+)>\s*;[^,]*rel="?next"?/i.exec(part);
    if (!m) continue;
    const cursor = Number(new URL(m[1]!, 'https://x.invalid').searchParams.get('cursor'));
    if (Number.isFinite(cursor)) return cursor;
  }
  return null;
}

/**
 * The device list groups devices by company and site ({ platform: [{ companyID, siteID, endpoints: [...] }] }); each
 * device is given its group's IDs, so its details are fetched from the right site the first time.
 */
function withGroupIds(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  for (const groups of Object.values(body as Json)) {
    for (const g of Array.isArray(groups) ? (groups as Json[]) : []) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.endpoints)) continue;
      const siteID = text(g, 'siteID', 'siteId');
      const companyID = text(g, 'companyID', 'companyId');
      for (const e of g.endpoints as Json[]) {
        if (!e || typeof e !== 'object') continue;
        if (siteID && !text(e, ...SITE_ID_KEYS)) e.siteID = siteID;
        if (companyID && !text(e, 'companyID', 'companyId')) e.companyID = companyID;
      }
    }
  }
  return body;
}

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
export const shapeOf = (body: unknown): string => {
  if (Array.isArray(body)) return `a list of ${body.length}`;
  if (!body || typeof body !== 'object') return typeof body;
  return Object.entries(body as Json)
    .map(([k, v]) =>
      Array.isArray(v)
        ? `${k}[${v.length}]`
        : v && typeof v === 'object'
          ? `${k}{${Object.keys(v as Json).slice(0, 40).join(',')}}`
          : k,
    )
    .slice(0, 30)
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
export interface RmmContact {
  id: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  mobile: string;
  /** The company's primary contact. */
  primary: boolean;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A phone number record as one string: country code, number, and extension when given. */
const phoneText = (p: Json | undefined) => {
  if (!p || typeof p !== 'object') return '';
  const number = text(p, 'nationalNumber', 'number', 'phoneNumber', 'value');
  if (!number) return '';
  const code = text(p, 'countryCode');
  const ext = text(p, 'extension');
  return `${code && !number.startsWith('+') ? `+${code.replace(/^\+/, '')} ` : ''}${number}${ext ? ` x${ext}` : ''}`;
};

/**
 * A ConnectWise contact (a company's primaryContact, or a contact record) in Atlas's terms; null when it has no ID
 * or name, or is inactive. Contact records list emails and phone numbers; the company's primary contact gives one
 * of each.
 */
export function mapContact(c: Json, primary = false): RmmContact | null {
  const id = text(c, 'id', 'contactId');
  const name = [text(c, 'firstName'), text(c, 'lastName')].filter(Boolean).join(' ') || text(c, 'name', 'fullName');
  if (!id || !name || c.activeFlag === false) return null;
  const list = (key: string) => (Array.isArray(c[key]) ? (c[key] as Json[]).filter((v) => v && typeof v === 'object') : []);
  const first = (items: Json[]) => items.find((v) => v.primaryFlag === true) ?? items[0];
  const email = text(c, 'primaryEmail.emailAddress', 'email', 'emailAddress') || text(first(list('emails')) ?? {}, 'emailAddress');
  const phones = list('phoneNumbers');
  const isMobile = (p: Json) => /mobile|cell/i.test(`${text(p, 'designation', 'type.name', 'description')}`);
  const mobile = phoneText(phones.find(isMobile));
  const phone =
    phoneText(pick(c, 'primaryPhoneNumber') as Json | undefined) ||
    phoneText(first(phones.filter((p) => !isMobile(p)))) ||
    text(c, 'phone', 'phoneNumber');
  return {
    id,
    name: name.slice(0, 120),
    title: text(c, 'title', 'jobTitle').slice(0, 120),
    email: EMAIL.test(email) && email.length <= 254 ? email.toLowerCase() : '',
    phone: phone.slice(0, 40),
    mobile: mobile.slice(0, 40),
    primary,
  };
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
  /** Agent online (true), offline (false), or not reported (null). */
  online: boolean | null;
  /** The agent's last check-in, ISO, or null when not reported. */
  lastSeenAt: string | null;
  protection: RmmProtection | null;
  protectionProduct: string;
  /** Warranty end date (YYYY-MM-DD), or '' when not reported. */
  warrantyExpires: string;
  /** Everything else ConnectWise sent about the device, as [label, value]. */
  extra: [string, string][];
}

/** Talks to the ConnectWise Asio platform API with an OAuth client-credentials token. */
export class CwRmmClient {
  /** What the last device list looked like, for a job note when a company comes back empty. */
  lastDeviceList = '';
  /** Field names of one real device (summary and details), for a single job note per sync. */
  lastDeviceFields = '';
  /** Whether the tenant takes a field list on device details; false after it refuses one. */
  private detailFields = true;
  // One client (and so one token) per set of credentials, shared by every request and sync: signing in for
  // each page load gets the key locked.
  private static shared = new WeakMap<typeof fetch, Map<string, CwRmmClient>>();
  static for(
    region: CwRmmRegion,
    clientId: string,
    clientSecret: string,
    fetcher: typeof fetch = fetch,
    scopes: string = SCOPES,
  ) {
    const key = [region, clientId, createHash('sha256').update(clientSecret).digest('hex'), scopes].join('|');
    let clients = CwRmmClient.shared.get(fetcher);
    if (!clients) CwRmmClient.shared.set(fetcher, (clients = new Map()));
    let client = clients.get(key);
    if (!client) clients.set(key, (client = new CwRmmClient(region, clientId, clientSecret, fetcher, scopes)));
    return client;
  }

  private token: { value: string; expires: number } | null = null;
  private readonly base: string;

  constructor(
    region: CwRmmRegion,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly scopes: string = SCOPES,
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
          scope: this.scopes,
        }),
        signal: AbortSignal.timeout(20_000),
      }),
    );
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new HttpError(
        400,
        `ConnectWise RMM rejected the client ID or secret, or the key is missing a scope.${await detail(res)}`,
        ACCESS_DENIED,
      );
    if (res.status === 423)
      throw new HttpError(
        502,
        'ConnectWise RMM has temporarily locked this API key after too many sign-ins. Wait a few minutes, then sync again.',
        ACCESS_DENIED,
      );
    if (!res.ok) throw new HttpError(502, `ConnectWise RMM returned ${res.status} when signing in.${await detail(res)}`);
    const body = (await res.json()) as Json;
    const value = text(body, 'access_token', 'accessToken');
    if (!value) throw new HttpError(502, 'ConnectWise RMM did not return an access token.');
    const seconds = Number(pick(body, 'expires_in', 'expiresIn')) || 3600;
    this.token = { value, expires: Date.now() + seconds * 1000 };
    return value;
  }

  /** A GET for another part of the platform API (tickets), with the same sign-in, retries, and errors. */
  get(path: string): Promise<unknown> {
    return this.call('GET', path);
  }

  /** One page of another part of the platform API (patching, backup, security), with the next page's cursor. */
  page(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ body: unknown; nextCursor: number | null }> {
    return this.request(method, path, body);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    return (await this.request(method, path, body)).body;
  }

  /** A call's body, with the next page's cursor when ConnectWise gives one in its Link header. */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ body: unknown; nextCursor: number | null }> {
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
        ACCESS_DENIED,
      );
    if (!res.ok)
      throw new HttpError(
        res.status === 400 || res.status === 404 ? res.status : 502,
        `ConnectWise RMM returned ${res.status} for ${where}.${await detail(res)}`,
      );
    return { body: await res.json(), nextCursor: nextCursorOf(res.headers.get('link')) };
  }

  /**
   * Runs a script from the ConnectWise RMM script library on one device, now, with these parameters. Returns the
   * task ID ConnectWise gives back ('' when it gives none).
   *
   * The platform API spec schedules a script with POST /v2/automation/endpoints/schedule-tasks: the script as the
   * template, the endpoint IDs as targets, and the parameters as one JSON string. The spec doesn't list the schedule
   * values; RunNow is ConnectWise's tasking name for "run once, now". ConnectWise's own answer is passed on whole
   * when it refuses.
   */
  async runScript(input: {
    companyId: string;
    endpointId: string;
    scriptId: string;
    name: string;
    parameters: Record<string, string>;
  }): Promise<string> {
    const body = await this.call('POST', '/api/platform/v2/automation/endpoints/schedule-tasks', {
      templateID: input.scriptId,
      templateType: 'script',
      name: input.name.slice(0, 100),
      description: input.name.slice(0, 100),
      parameters: JSON.stringify(input.parameters),
      targets: [input.endpointId],
      targetType: 'MANAGED_ENDPOINT',
      schedule: { regularity: 'RunNow' },
    });
    return text((body ?? {}) as Json, 'taskId', 'taskID', 'id', 'data.taskId');
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

  /**
   * The company's contacts: its primary contact (from the company record, as the spec gives it), plus any others
   * the contact list returns for this company. The spec documents only creating contacts, so the list is a bonus:
   * when ConnectWise refuses it, the primary contact is still synced.
   */
  async contacts(companyId: string): Promise<RmmContact[]> {
    const company = (await this.call('GET', `/api/platform/v1/company/companies/${encodeURIComponent(companyId)}`)) as Json;
    const primary = mapContact((pick(company ?? {}, 'primaryContact', 'data.primaryContact') ?? {}) as Json, true);
    const out = new Map<string, RmmContact>(primary ? [[primary.id, primary]] : []);
    let listed: Json[] = [];
    try {
      listed = listOf(await this.call('GET', `/api/platform/v1/contact/contacts?companyId=${encodeURIComponent(companyId)}`));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
    for (const c of listed) {
      // Only contacts that say they belong to this company: a list that ignored the filter mustn't mix clients.
      if (text(c, 'company.id', 'companyId', 'company.companyId') !== companyId) continue;
      const mapped = mapContact(c, primary?.id === text(c, 'id', 'contactId'));
      if (mapped) out.set(mapped.id, mapped);
    }
    return [...out.values()];
  }

  /** Every device for the company, page by page, using the first request shape the tenant accepts. */
  async devices(companyId: string, siteIds: string[] = []): Promise<RmmDevice[]> {
    const shapes = this.deviceQuery ? [this.deviceQuery] : DEVICE_QUERIES;
    const tried: string[] = [];
    for (const shape of shapes) {
      if (shape.kind === 'v2' && shape.resourceType === 'site' && !siteIds.length) continue;
      try {
        const listed = await this.devicePages(companyId, siteIds, shape);
        this.deviceQuery = shape;
        const devices = await this.withDetails(companyId, siteIds, listed);
        // Neither the list nor the details say whether the agent is online, when it last checked in, or how its
        // protection is doing; the heartbeat and system state APIs do.
        const [beats, states] = await Promise.all([
          this.endpointStates(companyId, 'heartbeat'),
          this.endpointStates(companyId, 'systemstate'),
        ]);
        return devices.map((d) => withState(d, beats.get(d.id), states.get(d.id)));
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

  /** Each of the company's endpoints' record from a bulk state API, by endpoint ID; empty when ConnectWise won't say. */
  private async endpointStates(companyId: string, api: 'heartbeat' | 'systemstate'): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    let body: unknown;
    try {
      body = await this.call(
        'GET',
        `/api/platform/v2/device/endpoints/${api}?resourceType=companies&resources=${encodeURIComponent(companyId)}`,
      );
    } catch (error) {
      // These are extra: without them the devices still sync, with the values unknown.
      if (error instanceof HttpError) return out;
      throw error;
    }
    const records = pick((body ?? {}) as Json, 'successfulRecords');
    for (const record of Array.isArray(records) ? (records as Json[]) : []) {
      const endpoints = pick(record, 'endpoints');
      for (const e of Array.isArray(endpoints) ? (endpoints as Json[]) : []) {
        const id = text(e, 'EndpointID', 'endpointID', 'endpointId');
        if (id) out.set(id, e);
      }
    }
    return out;
  }

  /**
   * The list gives a short summary per device; the details (hostname, OS, network, hardware) come from each
   * device's own endpoint, fetched a few at a time. A device whose details can't be read keeps its summary.
   */
  private async withDetails(companyId: string, siteIds: string[], listed: { id: string; raw: Json }[]) {
    const out: RmmDevice[] = [];
    // The list doesn't say which site a device is in. The details endpoint needs one, so the company's sites
    // are tried in turn, busiest first (by devices found so far), stopping at the one that knows the device.
    const hits = new Map<string, number>();
    let next = 0;
    const worker = async () => {
      while (next < listed.length) {
        const { id, raw } = listed[next++]!;
        const listedSite = text(raw, ...SITE_ID_KEYS);
        const candidates = listedSite
          ? [listedSite]
          : [...siteIds].sort((a, b) => (hits.get(b) ?? 0) - (hits.get(a) ?? 0));
        let siteId = listedSite; // Kept even when the details can't be read.
        let detail: Json = {};
        let detailNote = candidates.length ? '' : 'no site to look it up in';
        for (const site of candidates) {
          try {
            const path = `/api/platform/v2/device/companies/${encodeURIComponent(companyId)}/sites/${encodeURIComponent(site)}/endpoints/${encodeURIComponent(id)}`;
            const body = await this.detailsOf(path);
            detail = deviceObject(body, id);
            siteId = text(detail, ...SITE_ID_KEYS) || site;
            hits.set(site, (hits.get(site) ?? 0) + 1);
            detailNote = '';
            break;
          } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            detailNote = error.message.replace(/^ConnectWise RMM /, '').slice(0, 120);
            // Not in this site: try the next. Anything else won't change from site to site.
            if (error.status !== 404) break;
          }
        }
        // Field names only (never values), once per client, so the mapping can be checked against a real device.
        this.lastDeviceFields ||= `summary fields ${shapeOf(raw)}; details ${detailNote || `fields ${shapeOf(detail)}`}`;
        out.push(mapDevice(id, companyId, siteId, { ...raw, ...detail }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, listed.length) }, worker));
    return out;
  }

  /**
   * A device's details. Without a field list ConnectWise returns only the minimal fields (metadata, os and system),
   * so the hardware and protection sections are asked for by name; a tenant that refuses the list gets the default.
   */
  private async detailsOf(path: string) {
    if (this.detailFields) {
      try {
        return await this.call('GET', `${path}?field=${DETAIL_FIELDS}`);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 400)) throw error;
        this.detailFields = false;
      }
    }
    return this.call('GET', path);
  }

  private async devicePages(companyId: string, siteIds: string[], shape: DeviceQuery) {
    const out: { id: string; raw: Json }[] = [];
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
      let linked: number | null;
      try {
        ({ body, nextCursor: linked } =
          shape.kind === 'v2'
            ? await this.request('POST', `/api/platform/v2/device/categories/all/endpoints?${query}`, {
                resourceType: shape.resourceType,
                resources:
                  shape.resourceType === 'site' ? siteIds : shape.resourceType === 'partner' ? [] : [companyId],
              })
            : await this.request(
                'GET',
                `/api/platform/v1/device/endpoints?${query}&clientId=${encodeURIComponent(companyId)}`,
              ));
      } catch (error) {
        // ConnectWise answers "resource not found" (404) for a company with no devices, or past the last page. A
        // request it can't read gets 400, so a 404 still means the request itself was accepted.
        if (error instanceof HttpError && error.status === 404) {
          if (!pages) this.lastDeviceList = `${via}: resource not found`;
          break;
        }
        throw error;
      }
      const page = recordsOf(withGroupIds(body));
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
        out.push({ id, raw: d });
      }
      if (!pages)
        this.lastDeviceList = `${via}: response fields ${shapeOf(body)}; ${page.length} records on the first page`;
      // The spec gives the next page in the Link header; without one, a short page is the last.
      const next = linked ?? Number(pick((body ?? {}) as Json, 'nextCursor', 'pageInfo.nextCursor', 'next'));
      if (linked === null && page.length < shape.limit) break;
      if (!page.length) break;
      cursor = Number.isFinite(next) && next > cursor ? next : cursor + page.length;
    }
    if (seen && !out.length)
      this.lastDeviceList +=
        `; ${otherCompany} belonged to another company, ${seen - otherCompany} had no device ID` +
        (noId ? `; a record without one has fields ${shapeOf(noId)}` : '');
    return out;
  }
}

/**
 * A device with what the heartbeat and system state APIs say about it: online or not, when it last checked in, and
 * its protection, each only where the device's own record didn't say.
 */
export function withState(d: RmmDevice, beat: Json | undefined, state: Json | undefined, now = new Date()): RmmDevice {
  const both: Json = { ...state, ...beat };
  const online = beat ? onlineState(pick(beat, 'Availability', 'availability')) : null;
  const protection = protectionOf(both);
  const lastSeenAt =
    d.lastSeenAt ??
    lastSeenOf(both) ??
    // An agent the heartbeat API says is up is checking in now.
    (online === true ? now.toISOString() : null);
  return {
    ...d,
    online: online ?? d.online,
    lastSeenAt,
    protection: d.protection ?? protection.protection,
    protectionProduct: d.protectionProduct || protection.protectionProduct,
    manufacturer: d.manufacturer || normalizeManufacturer(makerOf(both)),
  };
}

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

/** Records a device's health for the RMM health charts, against the asset it was synced into. */
async function saveStatus(db: Database, orgId: string, clientId: string, assetId: string, d: RmmDevice) {
  const values = {
    clientId,
    assetId,
    kind: deviceKind(d),
    online: d.online,
    lastSeenAt: d.lastSeenAt ? new Date(d.lastSeenAt) : null,
    protection: d.protection,
    protectionProduct: d.protectionProduct,
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

// A layout named for devices, which the sync saves devices in when no layout was chosen.
const DEVICE_LAYOUT = /^(managed |rmm )?devices?( assets?)?$/;

/**
 * The layout devices are saved in: the one chosen in the sync options, else a layout named for devices
 * ("Devices", "Device assets"), else Configurations. `configurationId` is the Configurations layout, whose synced
 * devices move to the chosen layout.
 */
export async function deviceLayout(db: Database, orgId: string, chosen: string | null) {
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
    if (!picked || picked.archived)
      throw new HttpError(
        400,
        'The asset layout chosen for ConnectWise RMM devices is missing or archived. Pick another to sync devices.',
      );
    return { id: picked.id, configurationId: configuration?.id ?? null };
  }
  const named = layouts
    .filter((l) => !l.archived && l.key !== 'configuration')
    .find((l) => DEVICE_LAYOUT.test(l.name.trim().toLowerCase()) || DEVICE_LAYOUT.test(l.key));
  if (named) return { id: named.id, configurationId: configuration?.id ?? null };
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
  const layout = await deviceLayout(db, actor.orgId, options.layoutId);
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
      if (assetId) await saveStatus(db, actor.orgId, clientId, assetId, d);
    }
    // Only a company whose devices were read counts toward archiving devices the RMM dropped.
    if (options.devices) readInFull.add(clientId);
  }

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
