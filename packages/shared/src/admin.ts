import { z } from 'zod';
import { ACCESS_LEVELS, type AccessLevel } from './access.js';
import { emailSchema, passwordSchema } from './schemas.js';

// ---------- account security ----------
export const recoveryCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .max(40)
    .transform((v) => v.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .refine((v) => v.length === 10, 'Enter a recovery code, like abcde-12345.'),
  remember: z.boolean().default(false),
});
export const reauthSchema = z.object({ password: z.string().min(1, 'Enter your password.').max(256) });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/, 'This reset link is not valid.'),
  password: passwordSchema,
});
export const passkeyNameSchema = z.object({ name: z.string().trim().min(1, 'Name the passkey.').max(60) });
export const notificationPrefsSchema = z.object({ notifyDigest: z.boolean() });

export interface SessionListItem {
  id: string;
  current: boolean;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
}
export interface TrustedDeviceView {
  id: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  expiresAt: string;
}
export interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface AccountSecurityView {
  totp: boolean;
  recoveryCodesLeft: number;
  passkeys: PasskeyView[];
  sessions: SessionListItem[];
  devices: TrustedDeviceView[];
  notifyDigest: boolean;
}

// ---------- groups ----------
export const groupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(80),
  description: z.string().trim().max(300).default(''),
  memberIds: z.array(z.string().uuid()).max(2000).default([]),
  grants: z
    .array(z.object({ clientId: z.string().uuid(), level: z.enum(ACCESS_LEVELS) }))
    .max(5000)
    .default([]),
});
export interface GroupView {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
  grants: { clientId: string; level: AccessLevel }[];
  updatedAt: string;
}

// ---------- email and notifications ----------
export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];
export const SMTP_PRESETS = {
  m365: { label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls' as SmtpSecurity },
  custom: { label: 'Other SMTP server', host: '', port: 587, security: 'starttls' as SmtpSecurity },
} as const;
export type SmtpPreset = keyof typeof SMTP_PRESETS;

export const smtpSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    preset: z.enum(['m365', 'custom']).default('custom'),
    host: z
      .string()
      .trim()
      .max(253)
      .regex(/^[A-Za-z0-9.-]*$/, 'Enter a host name, like smtp.office365.com.')
      .default(''),
    port: z.number().int().min(1).max(65535).default(587),
    security: z.enum(SMTP_SECURITY).default('starttls'),
    username: z.string().trim().max(254).default(''),
    // Omitted or null keeps the stored password; an empty string clears it.
    password: z.string().max(512).nullable().optional(),
    fromAddress: z.union([z.literal(''), emailSchema]).default(''),
    fromName: z.string().trim().max(80).default('MSP Atlas'),
  })
  .refine((s) => !s.enabled || (s.host && s.fromAddress), {
    message: 'Enter the server and the From address to turn email on.',
    path: ['host'],
  });
export interface SmtpSettingsView {
  enabled: boolean;
  preset: SmtpPreset;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string;
}
export const testEmailSchema = z.object({ to: emailSchema });

export const notificationSettingsSchema = z.object({
  // Days before an expiry when alerts are emailed; the weekly digest lists everything within the largest window.
  alertDays: z.array(z.number().int().min(1).max(365)).max(6).default([30, 14, 7]),
  weeklyDigest: z.boolean().default(true),
  auditRetentionDays: z.number().int().min(30).max(3650).nullable().default(null),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

// ---------- expirations ----------
export const EXPIRY_KINDS = ['asset', 'password', 'document'] as const;
export type ExpiryKind = (typeof EXPIRY_KINDS)[number];
export interface ExpirationItem {
  kind: ExpiryKind;
  /** Item ID (asset, password, or document). */
  id: string;
  title: string;
  /** What expires, for example "SSL certificate · Expires" or "Password rotation". */
  label: string;
  clientId: string | null;
  clientName: string | null;
  date: string;
  daysLeft: number;
}

// ---------- audit log ----------
export interface AuditVerification {
  ok: boolean;
  checked: number;
  firstId: string | null;
  lastId: string | null;
  /** The first row whose hash or link doesn't match, when the chain is broken. */
  brokenAt: string | null;
  /** Whether the newest row still matches the last signed checkpoint (catches deleted recent rows). */
  checkpoint: 'ok' | 'missing' | 'mismatch';
  checkedAt: string;
}
