import type { LayoutField, WarrantyCheckResult, WarrantyVendor } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { AssetService, manufacturerField } from './assets.js';
import type { LayoutService } from './layouts.js';
import { detectManufacturer, normalizeManufacturer } from './manufacturer.js';
import type { Scope } from './scope.js';
import type { SettingsService, WarrantyLookupConfig } from './settings.js';
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

/**
 * Looks device warranties up by serial number from the vendors' own APIs: Dell TechDirect, Lenovo's support API,
 * and HP's Product Warranty API. Each needs the organization's API credentials, set under Settings. Answers are
 * remembered for a while so hourly syncs don't ask again about the same devices.
 */
export class WarrantyLookup {
  private readonly cache = new Map<string, { found: WarrantyFound | null; until: number }>();
  private readonly tokens = new Map<string, { token: string; until: number }>();
  /** Vendors that just failed, per organization, which automatic lookups leave alone until the time given. */
  private readonly down = new Map<string, number>();

  constructor(
    private readonly settings: SettingsService,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /** Which vendors have credentials set. */
  static ready(config: WarrantyLookupConfig): Record<WarrantyVendor, boolean> {
    return {
      Dell: !!(config.dell.clientId && config.dell.clientSecret),
      Lenovo: !!config.lenovo.clientId,
      HP: !!(config.hp.apiKey && config.hp.apiSecret),
    };
  }

  /**
   * The warranty end date for a device, or null when its vendor isn't supported or has no credentials set.
   * `auto` lookups (on create and sync) are skipped when the organization turned automatic lookups off, and
   * never throw; a manual one throws with a message the user can act on.
   */
  async find(orgId: string, manufacturer: string, serial: string, auto = true): Promise<WarrantyFound | null> {
    const vendor = warrantyVendor(manufacturer);
    const sn = cleanSerial(serial);
    if (!vendor || !sn) return null;
    const config = await this.settings.warrantyLookup(orgId);
    if ((auto && !config.autoLookup) || !WarrantyLookup.ready(config)[vendor]) return null;
    const key = `${orgId}|${vendor}|${sn}`;
    const cached = this.cache.get(key);
    if (auto && cached && cached.until > Date.now()) return cached.found;
    if (auto && (this.down.get(`${orgId}|${vendor}`) ?? 0) > Date.now()) return null;
    try {
      const expires = await this.ask(vendor, sn, config);
      const found = { vendor, expires };
      this.down.delete(`${orgId}|${vendor}`);
      this.remember(key, found, expires ? 30 * DAY : DAY);
      return found;
    } catch (error) {
      // A vendor refusing (bad key, rate limit, outage) isn't asked again about this device for an hour.
      this.remember(key, null, HOUR);
      // One failure pauses automatic lookups from that vendor, so a sync doesn't wait on it device by device.
      this.down.set(`${orgId}|${vendor}`, Date.now() + 15 * 60_000);
      if (auto) return null;
      throw error instanceof HttpError ? error : new HttpError(502, `${vendor} could not be reached.`);
    }
  }

  private remember(key: string, found: WarrantyFound | null, ttl: number) {
    if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { found, until: Date.now() + ttl });
  }

  private async ask(vendor: WarrantyVendor, serial: string, config: WarrantyLookupConfig): Promise<string> {
    if (vendor === 'Dell') {
      const token = await this.token(
        `dell|${config.dell.clientId}`,
        'https://apigtwb2c.us.dell.com/auth/oauth/v2/token',
        config.dell.clientId,
        config.dell.clientSecret,
        'Dell',
      );
      const url = new URL('https://apigtwb2c.us.dell.com/PROD/sbil/eapi/v5/asset-entitlements');
      url.searchParams.set('servicetags', serial);
      return latestEndDate(await this.json('Dell', url, { headers: { Authorization: `Bearer ${token}` } }));
    }
    if (vendor === 'Lenovo') {
      const url = new URL('https://supportapi.lenovo.com/v2.5/warranty');
      url.searchParams.set('Serial', serial);
      return latestEndDate(await this.json('Lenovo', url, { headers: { ClientID: config.lenovo.clientId } }));
    }
    const token = await this.token(
      `hp|${config.hp.apiKey}`,
      'https://warranty.api.hp.com/oauth/v1/token',
      config.hp.apiKey,
      config.hp.apiSecret,
      'HP',
    );
    return latestEndDate(
      await this.json('HP', new URL('https://warranty.api.hp.com/productwarranty/v2/queries'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ sn: serial }]),
      }),
    );
  }

  /** An OAuth client-credentials token, reused until shortly before it expires. */
  private async token(key: string, url: string, id: string, secret: string, vendor: WarrantyVendor) {
    const cached = this.tokens.get(key);
    if (cached && cached.until > Date.now()) return cached.token;
    const body = await this.json(vendor, new URL(url), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
    });
    const token = (body as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || !token) throw new HttpError(502, `${vendor} did not accept the API credentials.`);
    const ttl = Number((body as { expires_in?: unknown }).expires_in) || 3600;
    this.tokens.set(key, { token, until: Date.now() + Math.max(60, ttl - 60) * 1000 });
    return token;
  }

  private async json(vendor: WarrantyVendor, url: URL, init: RequestInit): Promise<unknown> {
    const res = await this.fetcher(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
    if (res.status === 401 || res.status === 403)
      throw new HttpError(502, `${vendor} refused the API credentials. Check them under Settings, Asset warranty.`);
    if (res.status === 429) throw new HttpError(502, `${vendor} is limiting requests. Try again later.`);
    if (res.status === 404) return {};
    if (!res.ok) throw new HttpError(502, `${vendor} answered with an error (${res.status}).`);
    return res.json();
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
    return (
      (keys.manufacturer && str(fields[keys.manufacturer])) ||
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
