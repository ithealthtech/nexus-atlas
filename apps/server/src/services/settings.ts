import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  notificationSettingsSchema,
  smtpSettingsSchema,
  type NotificationSettings,
  type SmtpPreset,
  type SmtpSecurity,
  type SmtpSettingsView,
} from '@atlas/shared';
import { open, seal, type KeyProvider } from '../crypto/keys.js';

/** SMTP settings as stored: the password is sealed with the master key. */
interface StoredSmtp {
  enabled: boolean;
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
  smtp?: StoredSmtp;
  notifications?: NotificationSettings;
  auditCheckpoint?: AuditCheckpoint;
}
/** SMTP settings ready to connect with (password decrypted). */
export interface SmtpConfig extends Omit<StoredSmtp, 'passwordSealed'> {
  password: string;
}

const smtpAad = (orgId: string) => `org|${orgId}|smtp`;
const DEFAULT_SMTP: StoredSmtp = {
  enabled: false,
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

  async smtpView(orgId: string): Promise<SmtpSettingsView> {
    const { passwordSealed, ...rest } = { ...DEFAULT_SMTP, ...(await this.load(orgId)).smtp };
    return { ...rest, hasPassword: !!passwordSealed };
  }

  async smtpConfig(orgId: string): Promise<SmtpConfig | null> {
    const smtp = (await this.load(orgId)).smtp;
    if (!smtp?.enabled || !smtp.host || !smtp.fromAddress) return null;
    const { passwordSealed, ...rest } = smtp;
    return { ...rest, password: passwordSealed ? open(this.keys, passwordSealed, smtpAad(orgId)) : '' };
  }

  async saveSmtp(orgId: string, input: unknown): Promise<SmtpSettingsView> {
    const body = smtpSettingsSchema.parse(input);
    const current = { ...DEFAULT_SMTP, ...(await this.load(orgId)).smtp };
    const passwordSealed =
      body.password === undefined || body.password === null
        ? current.passwordSealed
        : body.password === ''
          ? null
          : seal(this.keys, body.password, smtpAad(orgId));
    const { password: _password, ...rest } = body;
    await this.put(orgId, 'smtp', { ...rest, passwordSealed });
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

  async auditCheckpoint(orgId: string): Promise<AuditCheckpoint | undefined> {
    return (await this.load(orgId)).auditCheckpoint;
  }

  async saveAuditCheckpoint(orgId: string, checkpoint: AuditCheckpoint) {
    await this.put(orgId, 'auditCheckpoint', checkpoint);
  }
}
