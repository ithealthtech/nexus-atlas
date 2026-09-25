import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  brandingSchema,
  huduConnectionSchema,
  type Branding,
  notificationSettingsSchema,
  smtpSettingsSchema,
  type MailMethod,
  type NotificationSettings,
  type SmtpPreset,
  type SmtpSecurity,
  type SmtpSettingsView,
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
  hudu?: { url: string; keySealed: string };
  smtp?: StoredSmtp;
  notifications?: NotificationSettings;
  auditCheckpoint?: AuditCheckpoint;
}
/** Email settings ready to send with (secrets decrypted). */
export interface SmtpConfig extends Omit<StoredSmtp, 'passwordSealed' | 'clientSecretSealed'> {
  password: string;
  clientSecret: string;
}

const smtpAad = (orgId: string) => `org|${orgId}|smtp`;
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

  async huduView(orgId: string): Promise<{ url: string; hasKey: boolean } | null> {
    const saved = (await this.load(orgId)).hudu;
    return saved ? { url: saved.url, hasKey: true } : null;
  }

  async saveHudu(orgId: string, input: unknown) {
    const body = huduConnectionSchema.parse(input);
    const current = await this.hudu(orgId);
    const apiKey = body.apiKey ?? current?.apiKey;
    if (!apiKey) throw new HttpError(400, 'Enter the Hudu API key.');
    await this.put(orgId, 'hudu', {
      url: body.url.replace(/\/+$/, ''),
      keySealed: seal(this.keys, apiKey, `org|${orgId}|hudu`),
    });
  }

  async forgetHudu(orgId: string) {
    await this.db
      .update(schema.orgs)
      .set({ settings: sql`${schema.orgs.settings} - 'hudu'` })
      .where(eq(schema.orgs.id, orgId));
  }

  async auditCheckpoint(orgId: string): Promise<AuditCheckpoint | undefined> {
    return (await this.load(orgId)).auditCheckpoint;
  }

  async saveAuditCheckpoint(orgId: string, checkpoint: AuditCheckpoint) {
    await this.put(orgId, 'auditCheckpoint', checkpoint);
  }
}
