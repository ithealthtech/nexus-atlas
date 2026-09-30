import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  brandingSchema,
  cwRmmConnectionSchema,
  m365ConnectionSchema,
  m365SyncOptionsSchema,
  type M365SyncOptions,
  type M365View,
  entraSettingsSchema,
  type EntraView,
  passwordHealthSettingsSchema,
  type PasswordHealthSettings,
  cwRmmSyncOptionsSchema,
  huduImportOptionsSchema,
  type CwRmmSyncOptions,
  type HuduImportOptions,
  type CwRmmRegion,
  type CwRmmView,
  huduConnectionSchema,
  type Branding,
  notificationSettingsSchema,
  rmmHealthSettingsSchema,
  type RmmHealthSettings,
  rotationSettingsSchema,
  type RotationSettings,
  warrantySettingsSchema,
  type WarrantySettings,
  trackerSettingsSchema,
  type TrackerSettings,
  assetStatsSettingsSchema,
  type AssetStatsSettings,
  smtpSettingsSchema,
  type MailMethod,
  type NotificationSettings,
  type SmtpPreset,
  type SmtpSecurity,
  type SmtpSettingsView,
  siemSettingsSchema,
  requestLogSettingsSchema,
  type RequestLogSettings,
  vaultPolicySchema,
  type SiemMethod,
  type SyslogTransport,
  type VaultPolicy,
} from '@atlas/shared';
import { open, seal, type KeyProvider } from '../crypto/keys.js';
import { HttpError } from '../errors.js';

/** Email settings as stored: the SMTP password and the Graph client secret are sealed with the master key. */
interface StoredSmtp {
  enabled: boolean;
  method: MailMethod;
  tenantId: string;
  clientId: string;
  clientSecretSealed: string | null;
  preset: SmtpPreset;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  passwordSealed: string | null;
  fromAddress: string;
  fromName: string;
}
export interface AuditCheckpoint {
  id: string;
  hash: string;
  mac: string;
  at: string;
}
interface StoredSettings {
  branding?: Branding;
  hudu?: { url: string; keySealed: string; options?: HuduImportOptions };
  smtp?: StoredSmtp;
  notifications?: NotificationSettings;
  auditCheckpoint?: AuditCheckpoint;
  cwRmm?: StoredCwRmm;
  /** A pending "erase all data" request, during its waiting period. */
  erase?: EraseRequest;
  health?: PasswordHealthSettings & { lastRunAt?: string };
  entra?: StoredEntra;
  trackers?: TrackerSettings;
  rmmHealth?: RmmHealthSettings;
  rotation?: RotationSettings;
  warranty?: StoredWarranty;
  assetStats?: AssetStatsSettings;
  m365?: StoredM365;
  vaultPolicy?: VaultPolicy;
  siem?: StoredSiem;
  requestLog?: RequestLogSettings;
}
/** SIEM streaming as stored: the webhook signing secret is sealed with the master key. */
export interface StoredSiem {
  enabled: boolean;
  method: SiemMethod;
  url: string;
  secretSealed: string | null;
  host: string;
  port: number;
  transport: SyslogTransport;
  security: boolean;
  vault: boolean;
  /** The last row of each log that was delivered; streaming continues after it. */
  cursor: { security: number; vault: number };
  lastSentAt: string | null;
  lastError: string | null;
}
/** SIEM settings ready to send with (secret decrypted). */
export interface SiemConfig extends Omit<StoredSiem, 'secretSealed'> {
  secret: string;
}
export interface StoredWarranty {
  soonDays: number;
  autoLookup?: boolean;
}
export interface StoredEntra {
  tenantId: string;
  clientId: string;
  secretSealed: string;
  enabled: boolean;
  trustMfa: boolean;
  requireSso: boolean;
}
export interface EraseRequest {
  requestedAt: string;
  /** Not before this can the owner confirm. */
  confirmableAt: string;
  /** After this the request lapses and must be made again. */
  expiresAt: string;
  requestedBy: string;
  requestedByName: string;
}
export interface StoredM365 {
  clientId: string;
  secretSealed: string;
  autoSync: boolean;
  /** The administrator who connected it; scheduled syncs run as them. */
  connectedBy: string;
  lastSyncAt: string | null;
  options?: M365SyncOptions;
  /** Atlas client id → its Microsoft 365 tenant. */
  tenants: Record<
    string,
    {
      tenantId: string;
      tenantName: string | null;
      status: 'unchecked' | 'ok' | 'failed';
      detail: string | null;
      checkedAt: string | null;
    }
  >;
}
export interface StoredCwRmm {
  region: CwRmmRegion;
  clientId: string;
  secretSealed: string;
  autoSync: boolean;
  /** The administrator who connected it; scheduled syncs run as them. */
  connectedBy: string;
  lastSyncAt: string | null;
  options?: CwRmmSyncOptions;
  /** ConnectWise company id → what to do with it. */
  map: Record<string, { action: 'link'; clientId: string } | { action: 'skip' }>;
}
/** Email settings ready to send with (secrets decrypted). */
export interface SmtpConfig extends Omit<StoredSmtp, 'passwordSealed' | 'clientSecretSealed'> {
  password: string;
  clientSecret: string;
}

const entraAad = (orgId: string) => `org|${orgId}|entra`;
const cwAad = (orgId: string) => `org|${orgId}|cw-rmm`;
const m365Aad = (orgId: string) => `org|${orgId}|m365`;
const smtpAad = (orgId: string) => `org|${orgId}|smtp`;
const siemAad = (orgId: string) => `org|${orgId}|siem`;
const graphAad = (orgId: string) => `org|${orgId}|graph`;
const DEFAULT_SMTP: StoredSmtp = {
  enabled: false,
  // Settings saved before Graph support were SMTP.
  method: 'smtp',
  tenantId: '',
  clientId: '',
  clientSecretSealed: null,
  preset: 'custom',
  host: '',
  port: 587,
  security: 'starttls',
  username: '',
  passwordSealed: null,
  fromAddress: '',
  fromName: 'MSP Atlas',
};

export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly keys: KeyProvider,
  ) {}

  private async load(orgId: string): Promise<StoredSettings> {
    const [row] = await this.db
      .select({ settings: schema.orgs.settings })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId));
    return (row?.settings ?? {}) as StoredSettings;
  }

  /** Replaces one top-level key atomically, so concurrent writers of different keys don't clobber each other. */
  private async put<K extends keyof StoredSettings>(orgId: string, key: K, value: StoredSettings[K]) {
    await this.db
      .update(schema.orgs)
      .set({
        settings: sql`${schema.orgs.settings} || jsonb_build_object(${key}::text, ${JSON.stringify(value)}::jsonb)`,
      })
      .where(eq(schema.orgs.id, orgId));
  }

  /**
   * Re-seals every organization's stored secrets (SMTP password, Microsoft 365 client secret, Hudu API key)
   * under the current master key, for rotation (cli/rewrap-keys). `keys` must still hold the old key.
   */
  async rewrapSecrets(): Promise<number> {
    let count = 0;
    const reseal = (value: string | null | undefined, aad: string) => {
      if (!value) return value ?? null;
      count++;
      return seal(this.keys, open(this.keys, value, aad), aad);
    };
    for (const { id } of await this.db.select({ id: schema.orgs.id }).from(schema.orgs)) {
      const stored = await this.load(id);
      if (stored.smtp)
        await this.put(id, 'smtp', {
          ...stored.smtp,
          passwordSealed: reseal(stored.smtp.passwordSealed, smtpAad(id)),
          clientSecretSealed: reseal(stored.smtp.clientSecretSealed, graphAad(id)),
        });
      if (stored.hudu)
        await this.put(id, 'hudu', { ...stored.hudu, keySealed: reseal(stored.hudu.keySealed, `org|${id}|hudu`)! });
      if (stored.entra)
        await this.put(id, 'entra', {
          ...stored.entra,
          secretSealed: reseal(stored.entra.secretSealed, entraAad(id))!,
        });
      if (stored.m365)
        await this.put(id, 'm365', { ...stored.m365, secretSealed: reseal(stored.m365.secretSealed, m365Aad(id))! });
      if (stored.cwRmm)
        await this.put(id, 'cwRmm', { ...stored.cwRmm, secretSealed: reseal(stored.cwRmm.secretSealed, cwAad(id))! });
      if (stored.siem?.secretSealed)
        await this.put(id, 'siem', { ...stored.siem, secretSealed: reseal(stored.siem.secretSealed, siemAad(id)) });
    }
    return count;
  }

  async smtpView(orgId: string): Promise<SmtpSettingsView> {
    const { passwordSealed, clientSecretSealed, ...rest } = { ...DEFAULT_SMTP, ...(await this.load(orgId)).smtp };
    return { ...rest, hasPassword: !!passwordSealed, hasClientSecret: !!clientSecretSealed };
  }

  async smtpConfig(orgId: string): Promise<SmtpConfig | null> {
    const stored = (await this.load(orgId)).smtp;
    if (!stored?.enabled) return null;
    const smtp = { ...DEFAULT_SMTP, ...stored };
    const ready = smtp.method === 'graph' ? smtp.tenantId && smtp.clientId && smtp.clientSecretSealed : smtp.host;
    if (!ready || !smtp.fromAddress) return null;
    const { passwordSealed, clientSecretSealed, ...rest } = smtp;
    return {
      ...rest,
      password: passwordSealed ? open(this.keys, passwordSealed, smtpAad(orgId)) : '',
      clientSecret: clientSecretSealed ? open(this.keys, clientSecretSealed, graphAad(orgId)) : '',
    };
  }

  async saveSmtp(orgId: string, input: unknown): Promise<SmtpSettingsView> {
    const body = smtpSettingsSchema.parse(input);
    const current = { ...DEFAULT_SMTP, ...(await this.load(orgId)).smtp };
    // Omitted or null keeps what's stored; an empty string clears it.
    const sealed = (value: string | null | undefined, stored: string | null, aad: string) =>
      value === undefined || value === null ? stored : value === '' ? null : seal(this.keys, value, aad);
    const passwordSealed = sealed(body.password, current.passwordSealed, smtpAad(orgId));
    const clientSecretSealed = sealed(body.clientSecret, current.clientSecretSealed, graphAad(orgId));
    if (body.enabled && body.method === 'graph' && !clientSecretSealed)
      throw new HttpError(400, 'Enter the client secret from the app registration.', undefined, {
        clientSecret: 'Enter the client secret from the app registration.',
      });
    const { password: _password, clientSecret: _secret, ...rest } = body;
    await this.put(orgId, 'smtp', { ...rest, passwordSealed, clientSecretSealed });
    return this.smtpView(orgId);
  }

  async notifications(orgId: string): Promise<NotificationSettings> {
    return notificationSettingsSchema.parse((await this.load(orgId)).notifications ?? {});
  }

  async saveNotifications(orgId: string, input: unknown): Promise<NotificationSettings> {
    const body = notificationSettingsSchema.parse(input);
    body.alertDays = [...new Set(body.alertDays)].sort((a, b) => b - a);
    await this.put(orgId, 'notifications', body);
    return body;
  }

  async rmmHealth(orgId: string): Promise<RmmHealthSettings> {
    return rmmHealthSettingsSchema.parse((await this.load(orgId)).rmmHealth ?? {});
  }

  async saveRmmHealth(orgId: string, input: unknown): Promise<RmmHealthSettings> {
    const body = rmmHealthSettingsSchema.parse(input);
    await this.put(orgId, 'rmmHealth', body);
    return body;
  }

  async rotation(orgId: string): Promise<RotationSettings> {
    return rotationSettingsSchema.parse((await this.load(orgId)).rotation ?? {});
  }

  async saveRotation(orgId: string, input: unknown): Promise<RotationSettings> {
    const body = rotationSettingsSchema.parse(input);
    await this.put(orgId, 'rotation', body);
    return body;
  }

  async warranty(orgId: string): Promise<WarrantySettings> {
    const stored = (await this.load(orgId)).warranty;
    return {
      soonDays: warrantySettingsSchema.parse({ soonDays: stored?.soonDays }).soonDays,
      autoLookup: stored?.autoLookup ?? true,
    };
  }

  async saveWarranty(orgId: string, input: unknown): Promise<WarrantySettings> {
    const body = warrantySettingsSchema.parse(input);
    const current = (await this.load(orgId)).warranty;
    await this.put(orgId, 'warranty', {
      soonDays: body.soonDays,
      autoLookup: body.autoLookup ?? current?.autoLookup ?? true,
    });
    return this.warranty(orgId);
  }

  async assetStats(orgId: string): Promise<AssetStatsSettings> {
    return assetStatsSettingsSchema.parse((await this.load(orgId)).assetStats ?? {});
  }

  /** Saves which layouts count as which kind of device; "auto" entries aren't stored, since that's the default. */
  async saveAssetStats(orgId: string, input: unknown): Promise<AssetStatsSettings> {
    const body = assetStatsSettingsSchema.parse(input);
    body.layouts = Object.fromEntries(Object.entries(body.layouts).filter(([, v]) => v !== 'auto'));
    await this.put(orgId, 'assetStats', body);
    return body;
  }

  async trackers(orgId: string): Promise<TrackerSettings> {
    return trackerSettingsSchema.parse((await this.load(orgId)).trackers ?? {});
  }

  async saveTrackers(orgId: string, input: unknown): Promise<TrackerSettings> {
    const body = trackerSettingsSchema.parse(input);
    await this.put(orgId, 'trackers', body);
    return body;
  }

  async requestLog(orgId: string): Promise<RequestLogSettings> {
    return requestLogSettingsSchema.parse((await this.load(orgId)).requestLog ?? {});
  }

  async saveRequestLog(orgId: string, input: unknown): Promise<RequestLogSettings> {
    const body = requestLogSettingsSchema.parse(input);
    await this.put(orgId, 'requestLog', body);
    return body;
  }

  async branding(orgId: string): Promise<Branding> {
    return brandingSchema.parse((await this.load(orgId)).branding ?? {});
  }

  async saveBranding(orgId: string, input: unknown): Promise<Branding> {
    const body = brandingSchema.parse(input);
    await this.put(orgId, 'branding', body);
    return body;
  }

  /** Hudu connection for imports; the API key is sealed with the master key. */
  async hudu(orgId: string): Promise<{ url: string; apiKey: string } | null> {
    const saved = (await this.load(orgId)).hudu;
    return saved ? { url: saved.url, apiKey: open(this.keys, saved.keySealed, `org|${orgId}|hudu`) } : null;
  }

  async huduView(orgId: string): Promise<{ url: string; hasKey: boolean; options: HuduImportOptions } | null> {
    const saved = (await this.load(orgId)).hudu;
    return saved ? { url: saved.url, hasKey: true, options: huduImportOptionsSchema.parse(saved.options ?? {}) } : null;
  }

  /** What the Hudu import brings in; everything until an administrator narrows it. */
  async huduOptions(orgId: string): Promise<HuduImportOptions> {
    return huduImportOptionsSchema.parse((await this.load(orgId)).hudu?.options ?? {});
  }

  async saveHuduOptions(orgId: string, input: unknown): Promise<HuduImportOptions> {
    const saved = (await this.load(orgId)).hudu;
    if (!saved) throw new HttpError(400, 'Connect Hudu first: enter its address and an API key.');
    const options = huduImportOptionsSchema.parse(input);
    await this.put(orgId, 'hudu', { ...saved, options });
    return options;
  }

  async saveHudu(orgId: string, input: unknown) {
    const body = huduConnectionSchema.parse(input);
    const current = await this.hudu(orgId);
    const apiKey = body.apiKey ?? current?.apiKey;
    if (!apiKey) throw new HttpError(400, 'Enter the Hudu API key.');
    await this.put(orgId, 'hudu', {
      url: body.url.replace(/\/+$/, ''),
      keySealed: seal(this.keys, apiKey, `org|${orgId}|hudu`),
      // Changing the address or key keeps what the import is set to bring in.
      options: (await this.load(orgId)).hudu?.options,
    });
  }

  async forgetHudu(orgId: string) {
    await this.db
      .update(schema.orgs)
      .set({ settings: sql`${schema.orgs.settings} - 'hudu'` })
      .where(eq(schema.orgs.id, orgId));
  }

  /** ConnectWise RMM connection with the client secret decrypted, or null when not connected. */
  async cwRmm(orgId: string): Promise<(StoredCwRmm & { clientSecret: string }) | null> {
    const saved = (await this.load(orgId)).cwRmm;
    return saved
      ? { ...saved, map: saved.map ?? {}, clientSecret: open(this.keys, saved.secretSealed, cwAad(orgId)) }
      : null;
  }

  /** The company links and sync options, without the secret, for reading synced data. */
  async cwRmmLinks(orgId: string): Promise<Pick<StoredCwRmm, 'map' | 'options' | 'lastSyncAt'> | null> {
    const saved = (await this.load(orgId)).cwRmm;
    return saved ? { map: saved.map ?? {}, options: saved.options, lastSyncAt: saved.lastSyncAt } : null;
  }

  async cwRmmView(orgId: string): Promise<CwRmmView | null> {
    const saved = (await this.load(orgId)).cwRmm;
    return saved
      ? {
          region: saved.region,
          clientId: saved.clientId,
          hasSecret: true,
          autoSync: saved.autoSync,
          lastSyncAt: saved.lastSyncAt,
          options: cwRmmSyncOptionsSchema.parse(saved.options ?? {}),
        }
      : null;
  }

  async saveCwRmm(orgId: string, userId: string, input: unknown) {
    const body = cwRmmConnectionSchema.parse(input);
    const current = await this.cwRmm(orgId);
    const secret = body.clientSecret ?? current?.clientSecret;
    if (!secret)
      throw new HttpError(400, 'Enter the client secret.', undefined, { clientSecret: 'Enter the client secret.' });
    await this.put(orgId, 'cwRmm', {
      region: body.region,
      clientId: body.clientId,
      secretSealed: seal(this.keys, secret, cwAad(orgId)),
      autoSync: body.autoSync,
      connectedBy: userId,
      lastSyncAt: current?.lastSyncAt ?? null,
      options: current?.options,
      map: current?.map ?? {},
    } satisfies StoredCwRmm);
  }

  /** Updates the mapping or last-sync time without touching the secret. */
  async patchCwRmm(orgId: string, patch: Partial<Pick<StoredCwRmm, 'map' | 'lastSyncAt' | 'options'>>) {
    const saved = (await this.load(orgId)).cwRmm;
    if (!saved) throw new HttpError(400, 'Connect ConnectWise RMM first.');
    await this.put(orgId, 'cwRmm', { ...saved, ...patch });
  }

  async forgetCwRmm(orgId: string) {
    await this.db
      .update(schema.orgs)
      .set({ settings: sql`${schema.orgs.settings} - 'cwRmm'` })
      .where(eq(schema.orgs.id, orgId));
  }

  /** Microsoft 365 connection with the client secret decrypted, or null when not connected. */
  async m365(orgId: string): Promise<(StoredM365 & { clientSecret: string }) | null> {
    const saved = (await this.load(orgId)).m365;
    return saved
      ? { ...saved, tenants: saved.tenants ?? {}, clientSecret: open(this.keys, saved.secretSealed, m365Aad(orgId)) }
      : null;
  }

  async m365View(orgId: string, publicOrigin: string): Promise<M365View | null> {
    const saved = (await this.load(orgId)).m365;
    return saved
      ? {
          clientId: saved.clientId,
          hasSecret: true,
          autoSync: saved.autoSync,
          lastSyncAt: saved.lastSyncAt,
          options: m365SyncOptionsSchema.parse(saved.options ?? {}),
          redirectUri: `${publicOrigin}/api/integrations/m365/consent`,
        }
      : null;
  }

  async saveM365(orgId: string, userId: string, input: unknown) {
    const body = m365ConnectionSchema.parse(input);
    const current = await this.m365(orgId);
    const secret = body.clientSecret ?? current?.clientSecret;
    if (!secret)
      throw new HttpError(400, 'Enter the client secret.', undefined, { clientSecret: 'Enter the client secret.' });
    await this.put(orgId, 'm365', {
      clientId: body.clientId,
      secretSealed: seal(this.keys, secret, m365Aad(orgId)),
      autoSync: body.autoSync,
      connectedBy: userId,
      lastSyncAt: current?.lastSyncAt ?? null,
      options: current?.options,
      tenants: current?.tenants ?? {},
    } satisfies StoredM365);
  }

  /** Updates tenants, options, or the last-sync time without touching the secret. */
  async patchM365(orgId: string, patch: Partial<Pick<StoredM365, 'tenants' | 'lastSyncAt' | 'options'>>) {
    const saved = (await this.load(orgId)).m365;
    if (!saved) throw new HttpError(400, 'Connect Microsoft 365 first.');
    await this.put(orgId, 'm365', { ...saved, tenants: saved.tenants ?? {}, ...patch });
  }

  async forgetM365(orgId: string) {
    await this.db
      .update(schema.orgs)
      .set({ settings: sql`${schema.orgs.settings} - 'm365'` })
      .where(eq(schema.orgs.id, orgId));
  }

  async passwordHealth(orgId: string): Promise<PasswordHealthSettings & { lastRunAt?: string }> {
    const saved = (await this.load(orgId)).health;
    return { ...passwordHealthSettingsSchema.parse(saved ?? {}), lastRunAt: saved?.lastRunAt };
  }

  async savePasswordHealth(orgId: string, input: unknown) {
    const body = passwordHealthSettingsSchema.parse(input);
    await this.put(orgId, 'health', { ...body, lastRunAt: (await this.load(orgId)).health?.lastRunAt });
    return this.passwordHealth(orgId);
  }

  async saveHealthRun(orgId: string, at: string) {
    const current = await this.passwordHealth(orgId);
    await this.put(orgId, 'health', { breachChecks: current.breachChecks, lastRunAt: at });
  }

  /** Entra ID sign-in settings with the client secret decrypted, or null when not set up. */
  async entra(orgId: string): Promise<(StoredEntra & { clientSecret: string }) | null> {
    const saved = (await this.load(orgId)).entra;
    return saved ? { ...saved, clientSecret: open(this.keys, saved.secretSealed, entraAad(orgId)) } : null;
  }

  entraView(orgId: string, publicOrigin: string): Promise<EntraView | null> {
    return this.load(orgId).then((all) =>
      all.entra
        ? {
            tenantId: all.entra.tenantId,
            clientId: all.entra.clientId,
            hasSecret: true,
            enabled: all.entra.enabled,
            trustMfa: all.entra.trustMfa,
            requireSso: all.entra.requireSso,
            redirectUri: `${publicOrigin}/api/auth/entra/callback`,
          }
        : null,
    );
  }

  async saveEntra(orgId: string, input: unknown) {
    const body = entraSettingsSchema.parse(input);
    const current = await this.entra(orgId);
    const secret = body.clientSecret ?? current?.clientSecret;
    if (!secret)
      throw new HttpError(400, 'Enter the client secret.', undefined, { clientSecret: 'Enter the client secret.' });
    await this.put(orgId, 'entra', {
      tenantId: body.tenantId,
      clientId: body.clientId,
      secretSealed: seal(this.keys, secret, entraAad(orgId)),
      enabled: body.enabled,
      trustMfa: body.trustMfa,
      requireSso: body.requireSso && body.enabled,
    });
  }

  async forgetEntra(orgId: string) {
    await this.db
      .update(schema.orgs)
      .set({ settings: sql`${schema.orgs.settings} - 'entra'` })
      .where(eq(schema.orgs.id, orgId));
  }

  /** The organization whose Entra sign-in is on, for the sign-in page (Atlas serves one organization). */
  async entraOrg(): Promise<{ orgId: string; settings: StoredEntra } | null> {
    const rows = await this.db.select({ id: schema.orgs.id, settings: schema.orgs.settings }).from(schema.orgs);
    for (const r of rows) {
      const e = (r.settings as StoredSettings | null)?.entra;
      if (e?.enabled) return { orgId: r.id, settings: e };
    }
    return null;
  }

  async eraseRequest(orgId: string): Promise<EraseRequest | null> {
    return (await this.load(orgId)).erase ?? null;
  }

  async saveEraseRequest(orgId: string, request: EraseRequest | null) {
    if (request) await this.put(orgId, 'erase', request);
    else
      await this.db
        .update(schema.orgs)
        .set({ settings: sql`${schema.orgs.settings} - 'erase'` })
        .where(eq(schema.orgs.id, orgId));
  }

  async vaultPolicy(orgId: string): Promise<VaultPolicy> {
    return vaultPolicySchema.parse((await this.load(orgId)).vaultPolicy ?? {});
  }

  async saveVaultPolicy(orgId: string, input: unknown): Promise<VaultPolicy> {
    const body = vaultPolicySchema.parse(input);
    await this.put(orgId, 'vaultPolicy', body);
    return body;
  }

  /** SIEM streaming as stored, or null when it was never set up. */
  async siem(orgId: string): Promise<StoredSiem | null> {
    return (await this.load(orgId)).siem ?? null;
  }

  async siemConfig(orgId: string): Promise<SiemConfig | null> {
    const stored = await this.siem(orgId);
    if (!stored) return null;
    const { secretSealed, ...rest } = stored;
    return { ...rest, secret: secretSealed ? open(this.keys, secretSealed, siemAad(orgId)) : '' };
  }

  /**
   * Saves the SIEM settings. Streaming starts from the newest rows when it is first turned on (or a log is added), so
   * a new SIEM gets what happens from now on rather than the whole history; `start` gives those rows.
   */
  async saveSiem(orgId: string, input: unknown, start: { security: number; vault: number }): Promise<StoredSiem> {
    const body = siemSettingsSchema.parse(input);
    const current = await this.siem(orgId);
    const secretSealed =
      body.secret === undefined || body.secret === null
        ? (current?.secretSealed ?? null)
        : body.secret === ''
          ? null
          : seal(this.keys, body.secret, siemAad(orgId));
    const streaming = (log: 'security' | 'vault') => !!current?.enabled && current[log];
    const { secret: _secret, ...rest } = body;
    const saved: StoredSiem = {
      ...rest,
      secretSealed,
      cursor: {
        security: streaming('security') ? current!.cursor.security : start.security,
        vault: streaming('vault') ? current!.cursor.vault : start.vault,
      },
      lastSentAt: current?.lastSentAt ?? null,
      lastError: null,
    };
    await this.put(orgId, 'siem', saved);
    return saved;
  }

  /**
   * Records delivery progress without replacing the rest, so an administrator's save in the meantime isn't undone.
   * A cursor only moves forward.
   */
  async patchSiem(orgId: string, patch: Partial<Pick<StoredSiem, 'cursor' | 'lastSentAt' | 'lastError'>>) {
    const s = schema.orgs.settings;
    const { cursor, ...rest } = patch;
    let siem = sql`(${s} -> 'siem') || ${JSON.stringify(rest)}::jsonb`;
    if (cursor) {
      const ahead = (log: 'security' | 'vault') =>
        sql`greatest(coalesce((${s} #>> ${`{siem,cursor,${log}}`})::bigint, 0), ${cursor[log]}::bigint)`;
      siem = sql`${siem} || jsonb_build_object('cursor', jsonb_build_object('security', ${ahead('security')}, 'vault', ${ahead('vault')}))`;
    }
    await this.db
      .update(schema.orgs)
      .set({ settings: sql`${s} || jsonb_build_object('siem', ${siem})` })
      .where(and(eq(schema.orgs.id, orgId), sql`${s} ? 'siem'`));
  }

  async auditCheckpoint(orgId: string): Promise<AuditCheckpoint | undefined> {
    return (await this.load(orgId)).auditCheckpoint;
  }

  async saveAuditCheckpoint(orgId: string, checkpoint: AuditCheckpoint) {
    await this.put(orgId, 'auditCheckpoint', checkpoint);
  }
}
