import { z } from 'zod';

// ---------- automated password rotation ----------

/** Which kind of account a rotation changes: a device's local administrator, or an Active Directory account. */
export const ROTATION_ACCOUNT_TYPES = ['local_admin', 'ad_service'] as const;
export type RotationAccountType = (typeof ROTATION_ACCOUNT_TYPES)[number];
export const ROTATION_ACCOUNT_TYPE_LABELS: Record<RotationAccountType, string> = {
  local_admin: 'Local administrator',
  ad_service: 'AD service account',
};

export const ROTATION_RUN_STATUSES = ['dispatched', 'candidate', 'succeeded', 'failed', 'cancelled'] as const;
export type RotationRunStatus = (typeof ROTATION_RUN_STATUSES)[number];

/** Character rules a new password must meet. The device generates it; Atlas checks it before it is set. */
export const rotationComplexitySchema = z
  .object({
    length: z.number().int().min(12, 'Use at least 12 characters.').max(128).default(24),
    upper: z.boolean().default(true),
    lower: z.boolean().default(true),
    digits: z.boolean().default(true),
    symbols: z.boolean().default(true),
  })
  .refine((c) => [c.upper, c.lower, c.digits, c.symbols].filter(Boolean).length >= 2, {
    message: 'Choose at least two kinds of character.',
    path: ['upper'],
  });
export type RotationComplexity = z.infer<typeof rotationComplexitySchema>;

/** A policy for one account type, for one client or (clientId null) every client without its own. */
export const rotationPolicySchema = z.object({
  clientId: z.string().uuid().nullable().default(null),
  accountType: z.enum(ROTATION_ACCOUNT_TYPES),
  intervalDays: z.number().int().min(1).max(365).default(30),
  complexity: rotationComplexitySchema.prefault({}),
  enabled: z.boolean().default(true),
});
export interface RotationPolicyView {
  id: string;
  clientId: string | null;
  clientName: string | null;
  accountType: RotationAccountType;
  intervalDays: number;
  complexity: RotationComplexity;
  enabled: boolean;
  updatedAt: string;
}

/** Puts a vault password under automatic rotation, carried out on a ConnectWise RMM device. */
export const rotationTargetSchema = z.object({
  passwordId: z.string().uuid(),
  /** The synced RMM device the script runs on: the machine itself, or for AD accounts a domain controller. */
  assetId: z.string().uuid(),
  accountType: z.enum(ROTATION_ACCOUNT_TYPES),
});
export const rotationTargetUpdateSchema = z.object({ enabled: z.boolean() });
export interface RotationTargetView {
  id: string;
  clientId: string;
  clientName: string;
  passwordId: string;
  passwordName: string;
  username: string;
  assetId: string;
  assetName: string;
  accountType: RotationAccountType;
  enabled: boolean;
  /** The policy that applies now, or null when none does (the account is not rotated). */
  policyId: string | null;
  intervalDays: number | null;
  lastRotatedAt: string | null;
  nextDueAt: string | null;
  lastStatus: RotationRunStatus | null;
  lastError: string;
}
export interface RotationRunView {
  id: string;
  targetId: string | null;
  clientName: string;
  passwordId: string | null;
  passwordName: string;
  assetName: string;
  status: RotationRunStatus;
  error: string;
  startedByName: string;
  createdAt: string;
  expiresAt: string;
  finishedAt: string | null;
}

/** The ConnectWise RMM side of rotation: whether it runs, and the script it runs. */
export const rotationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  /** ID of the Atlas rotation script as imported into ConnectWise RMM (Automation → Scripts). */
  scriptId: z.string().trim().max(100).default(''),
});
export type RotationSettings = z.infer<typeof rotationSettingsSchema>;

/** What the rotation script sends back. The token in the Authorization header names the run. */
export const rotationCandidateSchema = z.object({ password: z.string().min(1).max(256) });
export const rotationResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().max(500).default(''),
});

/** Why a password doesn't meet a policy, or null when it does. */
export function complexityProblem(password: string, c: RotationComplexity): string | null {
  if (password.length < c.length) return `It is shorter than ${c.length} characters.`;
  if ([...password].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
    return 'It contains control characters.';
  const needs: [boolean, RegExp, string][] = [
    [c.upper, /[A-Z]/, 'an upper-case letter'],
    [c.lower, /[a-z]/, 'a lower-case letter'],
    [c.digits, /[0-9]/, 'a digit'],
    [c.symbols, /[^A-Za-z0-9]/, 'a symbol'],
  ];
  const missing = needs.filter(([on, re]) => on && !re.test(password)).map(([, , label]) => label);
  return missing.length ? `It has no ${missing.join(' or ')}.` : null;
}
