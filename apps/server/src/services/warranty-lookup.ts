import type { LayoutField, WarrantyCheckResult, WarrantyVendor } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { AssetService, manufacturerField } from './assets.js';
import type { LayoutService } from './layouts.js';
import { detectManufacturer, normalizeManufacturer } from './manufacturer.js';
import type { Scope } from './scope.js';
import type { SettingsService } from './settings.js';
import { warrantyFields } from './warranty.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TIMEOUT = 15_000;
const MAX_CACHED = 20_000;

/** The vendor whose warranty API covers a manufacturer, or null. HPE servers are not HP Inc. and aren't covered. */
export function warrantyVendor(manufacturer: string): WarrantyVendor | null {
  const m = normalizeManufacturer(manufacturer).toLowerCase();
  if (/^dell\b/.test(m)) return 'Dell';
  if (/^lenovo\b/.test(m)) return 'Lenovo';
  if (/^hpe\b|enterprise/.test(m)) return null;
  if (/^hp\b|^hewlett/.test(m)) return 'HP';
  return null;
}

/** A serial number as vendors take it, or '' when it is a firmware placeholder. */
export function cleanSerial(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(v)) return '';
  if (/^(0+|1234567890?|DEFAULT|NONE|UNKNOWN|SYSTEMSERIALNUMBER|TOBEFILLEDBYOEM|VMWARE.*)$/.test(v)) return '';
  return v;
}

/** YYYY-MM-DD from a vendor's date string ("2027-03-31T00:00:00Z", "2027-03-31"), or ''. */
function day(value: unknown): string {
  if (typeof value !== 'string') return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m || Number(m[1]) < 1990 || Number(m[1]) > 2100) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * The latest warranty end date anywhere in a vendor's response: the values of keys named like an end date
 * ("endDate", "End", "serviceObligationLineItemEndDate"). Vendors list one entitlement per service (base
 * warranty, onsite, accidental damage, extensions); the device is covered until the last of them ends.
 */
export function latestEndDate(body: unknown): string {
  let latest = '';
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [key, value] of Object.entries(v)) {
      if (/^end$|end_?date$/i.test(key)) {
        const d = day(value);
        if (d > latest) latest = d;
      } else walk(value, depth + 1);
    }
  };
  walk(body, 0);
  return latest;
}

export interface WarrantyFound {
  vendor: WarrantyVendor;
  /** YYYY-MM-DD, or '' when the vendor has no warranty on record for the serial. */
  expires: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The public support sites answer browsers; a plain client is often turned away.
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** YYYY-MM-DD from "2027-03-31", "31 Mar 2027", "March 31, 2027", or "03/31/2027"; '' otherwise. */
export function textDate(text: string): string {
  const iso = day(text);
  if (iso) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const ok = (y: number, m: number, d: number) =>
    y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : '';
  let m = /^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/i.exec(text);
  if (m) return ok(Number(m[3]), MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[1]));
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (m) return ok(Number(m[3]), MONTHS.indexOf(m[1]!.toLowerCase()) + 1, Number(m[2]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text);
  if (m) return ok(Number(m[3]), Number(m[1]), Number(m[2]));
  return '';
}

/** The warranty expiry on Dell's public warranty page: the latest date shown next to "Expires" or "Expiration". */
export function dellExpiry(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ');
  let latest = '';
  for (const m of text.matchAll(/expir(?:es|ation|y)(?: date)?\s*(?:on)?\s*:?\s*/gi)) {
    const d = textDate(text.slice(m.index + m[0].length, m.index + m[0].length + 40));
    if (d > latest) latest = d;
  }
  return latest;
}

/** HP's product number (like "4K1A3UT#ABA") from its public serial number search, or ''. */
export function hpProductNumber(body: unknown): string {
  let found = '';
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 8 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    for (const [key, value] of Object.entries(v)) {
      if (/^(productNumber|pn|productNo)$/i.test(key) && typeof value === 'string' && value.trim()) {
        found = value.trim();
        return;
      }
      walk(value, depth + 1);
    }
  };
  walk(body, 0);
  return found;
}

/**
 * Looks device warranties up by serial number the way each vendor's own public warranty check does, so no API
 * keys are needed: Lenovo's and HP's support-site lookups, and Dell's warranty page. These aren't documented
 * APIs and can change; a vendor that stops answering is skipped for a while, and the date can still be typed in.
 * Answers are remembered so hourly syncs don't ask again about the same devices.
 */
export class WarrantyLookup {
  private readonly cache = new Map<string, { found: WarrantyFound | null; until: number }>();
  /** Vendors that just failed, which automatic lookups leave alone until the time given. */
  private readonly down = new Map<WarrantyVendor, number>();

  constructor(
    private readonly settings: SettingsService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /**
   * The warranty end date for a device, or null when its vendor isn't supported. `auto` lookups (on save and
   * sync) are skipped when the organization turned automatic lookups off, and never throw; a manual one throws
   * with a message the user can act on.
   */
  async find(orgId: string, manufacturer: string, serial: string, auto = true): Promise<WarrantyFound | null> {
    const vendor = warrantyVendor(manufacturer);
    const sn = cleanSerial(serial);
    if (!vendor || !sn) return null;
    if (auto && !(await this.settings.warranty(orgId)).autoLookup) return null;
    const key = `${vendor}|${sn}`;
    const cached = this.cache.get(key);
    if (auto && cached && cached.until > Date.now()) return cached.found;
    if (auto && (this.down.get(vendor) ?? 0) > Date.now()) return null;
    try {
      const expires = await this.ask(vendor, sn);
      const found = { vendor, expires };
      this.down.delete(vendor);
      this.remember(key, found, expires ? 30 * DAY : DAY);
      return found;
    } catch (error) {
      // A vendor refusing (rate limit, outage, a changed site) isn't asked again about this device for an hour,
      // and automatic lookups from it pause, so a sync doesn't wait on it device by device.
      this.remember(key, null, HOUR);
      this.down.set(vendor, Date.now() + 15 * 60_000);
      if (auto) return null;
      throw error instanceof HttpError ? error : new HttpError(502, `${vendor}'s warranty check could not be reached.`);
    }
  }

  private remember(key: string, found: WarrantyFound | null, ttl: number) {
    if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { found, until: Date.now() + ttl });
  }

  private async ask(vendor: WarrantyVendor, serial: string): Promise<string> {
    if (vendor === 'Lenovo') {
      const res = await this.call(vendor, 'https://pcsupport.lenovo.com/us/en/api/v4/upsell/redport/getIbaseInfo', {
        method: 'POST',
        headers: { ...BROWSER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ serialNumber: serial, country: 'us', language: 'en' }),
      });
      return latestEndDate(await res.json());
    }
    if (vendor === 'HP') {
      const search = new URL('https://support.hp.com/wcc-services/searchresult/us-en');
      for (const [k, v] of Object.entries({
        q: serial,
        context: 'pdp',
        authState: 'anonymous',
        template: 'WarrantyLanding',
      }))
        search.searchParams.set(k, v);
      const product = hpProductNumber(
        await (
          await this.call(vendor, search, {
            headers: { ...BROWSER, Referer: 'https://support.hp.com/us-en/check-warranty' },
          })
        ).json(),
      );
      const res = await this.call(
        vendor,
        'https://support.hp.com/wcc-services/profile/devices/warranty/specs?authState=anonymous&template=checkWarranty',
        {
          method: 'POST',
          headers: {
            ...BROWSER,
            'Content-Type': 'application/json',
            Referer: 'https://support.hp.com/us-en/warrantyresult',
          },
          body: JSON.stringify({
            productNumber: product,
            serialNumber: serial,
            countryCode: 'US',
            languageCode: 'en',
            authState: 'anonymous',
          }),
        },
      );
      return latestEndDate(await res.json());
    }
    const res = await this.call(
      vendor,
      `https://www.dell.com/support/home/en-us/product-support/servicetag/${encodeURIComponent(serial)}/warranty`,
      { headers: { ...BROWSER, Accept: 'text/html,application/xhtml+xml' } },
    );
    return dellExpiry(await res.text());
  }

  private async call(vendor: WarrantyVendor, url: URL | string, init: RequestInit): Promise<Response> {
    const res = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status === 429) throw new HttpError(502, `${vendor} is limiting warranty checks. Try again later.`);
    if (!res.ok) throw new HttpError(502, `${vendor}'s warranty check answered with an error (${res.status}).`);
    return res;
  }

  /** The asset's serial number, manufacturer, and warranty date fields, or null when its layout lacks one. */
  static fieldsOf(layoutFields: LayoutField[]) {
    const serial = layoutFields.find(
      (f) => f.type === 'text' && (f.key === 'serial_number' || /serial|service tag/i.test(f.label)),
    );
    const warranty = warrantyFields(layoutFields)[0];
    if (!serial || !warranty) return null;
    return { serial: serial.key, warranty, manufacturer: manufacturerField(layoutFields)?.key };
  }

  /** The device's manufacturer as entered, or as its model and name suggest. */
  static manufacturerOf(fields: Record<string, unknown>, keys: { manufacturer?: string }, name: string) {
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    // Firmware placeholders ("To Be Filled By O.E.M.") count as blank, so the model decides.
    return (
      (keys.manufacturer && normalizeManufacturer(str(fields[keys.manufacturer]))) ||
      detectManufacturer({ model: str(fields.model), name, hostname: str(fields.hostname) })
    );
  }

  /** Fills a blank warranty date on a device being saved, when its vendor has one on record. Never throws. */
  async fill(orgId: string, layoutFields: LayoutField[], name: string, fields: Record<string, unknown>) {
    const keys = WarrantyLookup.fieldsOf(layoutFields);
    if (!keys || fields[keys.warranty]) return fields;
    const serial = fields[keys.serial];
    if (typeof serial !== 'string' || !serial) return fields;
    const found = await this.find(orgId, WarrantyLookup.manufacturerOf(fields, keys, name), serial).catch(() => null);
    return found?.expires ? { ...fields, [keys.warranty]: found.expires } : fields;
  }

  /** "Check warranty" on an asset: asks the vendor now and saves the date it gives. */
  async check(scope: Scope, layouts: LayoutService, assetId: string): Promise<WarrantyCheckResult> {
    const assets = new AssetService(layouts);
    const asset = await assets.get(scope, assetId);
    await scope.require(asset.clientId, 'edit', 'Asset');
    const layout = await layouts.get(scope.actor, asset.layoutId);
    const keys = WarrantyLookup.fieldsOf(layout.fields as LayoutField[]);
    if (!keys) throw new HttpError(400, 'This asset layout has no serial number and warranty date fields.');
    const serial = cleanSerial(String(asset.fields[keys.serial] ?? ''));
    if (!serial) throw new HttpError(400, 'Enter the serial number (service tag) first.');
    const manufacturer = WarrantyLookup.manufacturerOf(asset.fields, keys, asset.name);
    const vendor = warrantyVendor(manufacturer);
    if (!vendor)
      throw new HttpError(
        400,
        manufacturer
          ? `Warranty lookup covers Dell, Lenovo, and HP devices, not ${manufacturer}.`
          : 'Enter the manufacturer first. Warranty lookup covers Dell, Lenovo, and HP devices.',
      );
    const found = await this.find(scope.actor.orgId, manufacturer, serial, false);
    if (!found)
      throw new HttpError(
        400,
        `Add ${vendor} API credentials under Settings, Asset warranty, to look up ${vendor} warranties.`,
      );
    if (!found.expires)
      return { asset, vendor, expires: null, message: `${vendor} has no warranty on record for ${serial}.` };
    if (asset.fields[keys.warranty] === found.expires)
      return { asset, vendor, expires: found.expires, message: `Warranty ends ${found.expires}, as already recorded.` };
    const saved = await assets.update(
      scope,
      asset.id,
      { fields: { ...asset.fields, [keys.warranty]: found.expires }, version: asset.version },
      `Warranty looked up from ${vendor}`,
    );
    return { asset: saved, vendor, expires: found.expires, message: `Warranty ends ${found.expires}, from ${vendor}.` };
  }
}
