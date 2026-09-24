import { z } from 'zod';

export const PASSWORD_KINDS = ['login', 'bitlocker'] as const;
export type PasswordKind = (typeof PASSWORD_KINDS)[number];

/** A BitLocker numerical recovery password: eight groups of six digits. */
export const BITLOCKER_KEY = /^\d{6}(-\d{6}){7}$/;

const totpSecret = z
  .string()
  .trim()
  .transform((v) => v.replace(/\s+/g, '').toUpperCase())
  .refine(
    (v) => v === '' || /^[A-Z2-7]{16,128}=*$/.test(v),
    'Enter the authenticator setup key (letters A–Z and digits 2–7), or leave it empty.',
  );

const base = {
  name: z.string().trim().min(1, 'Name is required.').max(200),
  username: z.string().trim().max(254).default(''),
  url: z
    .string()
    .trim()
    .max(2000)
    .default('')
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), 'Enter an http:// or https:// address.'),
  secret: z.string().min(1, 'The password is required.').max(4096),
  notes: z.string().max(20000).default(''),
  totp: totpSecret.default(''),
  rotationDays: z.number().int().min(1).max(3650).nullable().default(null),
  restricted: z.boolean().default(false),
  clientVisible: z.boolean().default(false),
};

export const createPasswordSchema = z
  .object({ kind: z.enum(PASSWORD_KINDS).default('login'), ...base })
  .refine((p) => p.kind !== 'bitlocker' || BITLOCKER_KEY.test(p.secret.trim()), {
    message: 'A BitLocker recovery key is 8 groups of 6 digits, separated by dashes.',
    path: ['secret'],
  });
export const updatePasswordSchema = z.object({
  name: base.name.optional(),
  username: z.string().trim().max(254).optional(),
  url: base.url.optional(),
  secret: base.secret.optional(),
  notes: z.string().max(20000).optional(),
  totp: totpSecret.optional(),
  rotationDays: z.number().int().min(1).max(3650).nullable().optional(),
  restricted: z.boolean().optional(),
  clientVisible: z.boolean().optional(),
  version: z.number().int().positive(),
});
export const revealSchema = z.object({
  field: z.enum(['secret', 'notes', 'totp']).default('secret'),
  reason: z.string().trim().max(300).default(''),
  copy: z.boolean().default(false),
});
export const shareSchema = z.object({
  // Browser-encrypted payload (AES-GCM, key never sent). Base64url, bounded in size.
  ciphertext: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .min(24)
    .max(40000),
  maxViews: z.number().int().min(1).max(20).default(1),
  expiresHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24),
  reason: z.string().trim().max(300).default(''),
});
export const passwordAccessSchema = z.object({
  userIds: z.array(z.string().uuid()).max(500),
  groupIds: z.array(z.string().uuid()).max(200).default([]),
});

export interface PasswordView {
  id: string;
  clientId: string;
  clientName: string;
  kind: PasswordKind;
  name: string;
  username: string;
  url: string;
  hasNotes: boolean;
  hasTotp: boolean;
  strength: number;
  reused: number;
  rotationDays: number | null;
  changedAt: string;
  rotationDue: string | null;
  restricted: boolean;
  clientVisible: boolean;
  version: number;
  archived: boolean;
  updatedAt: string;
  updatedByName: string | null;
  requireReason: boolean;
}
export interface PasswordHistoryView {
  id: string;
  changedByName: string;
  createdAt: string;
}
export interface VaultAuditView {
  id: string;
  passwordId: string | null;
  passwordName: string;
  clientName: string | null;
  actorName: string;
  action: string;
  reason: string;
  ip: string;
  createdAt: string;
}
export interface ShareView {
  id: string;
  maxViews: number;
  views: number;
  expiresAt: string;
  revoked: boolean;
  createdByName: string;
  createdAt: string;
}
export interface RevealResult {
  value: string;
  /** For TOTP: seconds until the code changes. */
  expiresIn?: number;
}

/** Rough strength score (0–4) from length and character variety. Shown as guidance, not a guarantee. */
export function passwordStrength(value: string): number {
  if (!value) return 0;
  let pool = 0;
  if (/[a-z]/.test(value)) pool += 26;
  if (/[A-Z]/.test(value)) pool += 26;
  if (/\d/.test(value)) pool += 10;
  if (/[^A-Za-z0-9]/.test(value)) pool += 33;
  const unique = new Set(value).size;
  const bits = Math.log2(Math.max(pool, 2)) * Math.min(value.length, unique * 2);
  if (/^(password|letmein|welcome|qwerty|admin|123456)/i.test(value)) return 0;
  return bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
}
export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;
