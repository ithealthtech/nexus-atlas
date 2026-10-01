// Reading ConnectWise RMM records: pulling the values Atlas keeps out of whatever field names a response uses.
import { type RmmProtection } from '@atlas/shared';
import { normalizeManufacturer } from '../manufacturer.js';
import { readableLabel } from '../importers/hudu.js';

export type Json = Record<string, unknown>;

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
export const DEVICE_ID_KEYS = [
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
export function deviceObject(body: unknown, id: string): Json {
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

export const SITE_ID_KEYS =['siteId', 'siteID', 'site_id', 'site.id', 'site.siteId'];
export const DETAIL_CONCURRENCY = 4;
// The platformEndpointDetail fields Atlas reads: the device's own, the maker (baseboard; bios is kept as a field),
// and endpoint protection (antiViruses, and services, which mark antivirus services and their status).
export const DETAIL_FIELDS = [
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
export function mapDevice(id: string, companyId: string, siteId: string, record: Json): RmmDevice {
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
export function withGroupIds(body: unknown): unknown {
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
export function recordsOf(body: unknown, depth = 0): Json[] {
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
  /** Installed applications; undefined when they weren't read (switched off, or ConnectWise wouldn't say). */
  software?: RmmApp[];
  /** Accounts that sign in, most recent first; undefined when they weren't read. */
  signIns?: RmmSignIn[];
}
export interface RmmApp {
  name: string;
  version: string;
  publisher: string;
  installedAt: string | null;
}
export interface RmmSignIn {
  username: string;
  domain: string;
  lastLogonAt: string | null;
}
/** A device related to another in the RMM: `role` is this device's side, e.g. Host or Guest. */
export interface RmmRelation {
  endpointId: string;
  role: string;
  relatedRole: string;
}

// Windows' own accounts, never a person.
const BUILT_IN_ACCOUNTS = /^(administrator|guest|defaultaccount|wdagutilityaccount|defaultuser\d*|system|local service|network service|dwm-\d+|umfd-\d+)$/i;
// ConnectWise caps how much comes back; a device with more than this many apps keeps the first ones.
const MAX_APPS = 1000;
const MAX_SIGN_INS = 50;

/** A date ConnectWise gives as ISO text or a Unix time (seconds or milliseconds), as ISO; null when there is none. */
export function isoOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '' || value === 0) return null;
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
  const date = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(value));
  // Windows reports "never" as a year-1601 or year-0001 date.
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1990 ? null : date.toISOString();
}

/** A device's applications from the applications API, one per name and version. */
export function appsOf(records: Json[]): RmmApp[] {
  const out = new Map<string, RmmApp>();
  for (const a of records) {
    const name = text(a, 'name', 'displayName', 'applicationName').slice(0, 300);
    if (!name) continue;
    const version = text(a, 'version', 'displayVersion').slice(0, 100);
    const key = `${name.toLowerCase()}|${version}`;
    if (out.has(key)) continue;
    out.set(key, {
      name,
      version,
      publisher: text(a, 'publisher', 'vendor').slice(0, 200),
      installedAt: isoOf(pick(a, 'installedDate', 'installDate')),
    });
    if (out.size >= MAX_APPS) break;
  }
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * The accounts that sign in to a device: local and domain accounts from the users API (enabled ones that have
 * signed in), plus whoever the system state API says signed in last or is signed in now. Most recent first.
 */
export function signInsOf(users: Json[], state: Json | undefined): RmmSignIn[] {
  const out = new Map<string, RmmSignIn>();
  const add = (raw: string, domain: string, when: string | null) => {
    // System state gives DOMAIN\user or user@domain; the users API gives the two apart.
    const [, d1, u1] = /^(?:([^\\]+)\\)?(.+)$/.exec(raw.trim()) ?? [];
    const [, u2, d2] = /^([^@]+)(?:@(.+))?$/.exec(u1 ?? '') ?? [];
    const username = (u2 ?? '').trim().slice(0, 200);
    if (!username || BUILT_IN_ACCOUNTS.test(username)) return;
    const key = username.toLowerCase();
    const seen = out.get(key);
    if (seen && (seen.lastLogonAt ?? '') >= (when ?? '')) return;
    out.set(key, { username, domain: (domain || d1 || d2 || seen?.domain || '').slice(0, 200), lastLogonAt: when });
  };
  for (const u of users) {
    if (pick(u, 'userDisabled') === true) continue;
    const when = isoOf(pick(u, 'lastLogonTimestamp', 'lastLogon', 'lastLogonTime'));
    if (when) add(text(u, 'username', 'userName', 'name'), text(u, 'domainName', 'domain'), when);
  }
  if (state) {
    const last = pick(state, 'lastLoggedOnUser');
    if (last && typeof last === 'object')
      add(text(last as Json, 'username', 'userName'), '', isoOf(pick(last as Json, 'logonTime')));
    const now = pick(state, 'loggedOnUsers');
    for (const u of Array.isArray(now) ? (now as Json[]) : [])
      add(text(u, 'username', 'userName'), '', isoOf(pick(u, 'logonTime')));
  }
  return [...out.values()]
    .sort((x, y) => (y.lastLogonAt ?? '').localeCompare(x.lastLogonAt ?? ''))
    .slice(0, MAX_SIGN_INS);
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

