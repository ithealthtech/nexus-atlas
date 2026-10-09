import { z } from 'zod';
import type { Role } from './access.js';

// ---------- vault policies ----------
/** Roles that can only read. They never get "edit + passwords", but a client viewer can still reveal shared passwords. */
export const READ_ONLY_ROLES: readonly Role[] = ['readonly_technician', 'client_viewer'];

/** The shortest a generator policy may set; below this the policy would weaken the generator's own default. */
export const GENERATOR_MIN_LENGTH = 12;

export const vaultPolicySchema = z.object({
  generator: z
    .object({
      /** Shortest password the generator makes (character passwords). */
      minLength: z.number().int().min(GENERATOR_MIN_LENGTH).max(64).default(GENERATOR_MIN_LENGTH),
      requireDigits: z.boolean().default(false),
      requireSymbols: z.boolean().default(false),
      /** Whether the generator offers PINs, which are too short for most accounts. */
      allowPins: z.boolean().default(true),
    })
    .default({ minLength: GENERATOR_MIN_LENGTH, requireDigits: false, requireSymbols: false, allowPins: true }),
  /** Every reveal, copy, and share needs a reason, in every client (on top of the per-client setting). */
  requireRevealReason: z.boolean().default(false),
  /** Read-only roles can't reveal or copy passwords, even ones shared with their client. */
  blockReadOnlyReveal: z.boolean().default(false),
  /**
   * Restricted passwords are for the people and groups listed on them: administrators other than the owner must be
   * listed too, or use emergency access.
   */
  restrictedListedOnly: z.boolean().default(false),
  /** Staff each get a personal vault that only they can open. Turning it off hides the vaults; nothing is deleted. */
  personalVaults: z.boolean().default(true),
});
export type VaultPolicy = z.infer<typeof vaultPolicySchema>;
export const DEFAULT_VAULT_POLICY: VaultPolicy = vaultPolicySchema.parse({});

/** The policy with what the administrator needs to see about MFA. */
export interface VaultPolicyView extends VaultPolicy {
  mfa: {
    /** Staff must set up MFA before they can use Atlas (ATLAS_REQUIRE_STAFF_MFA). */
    requiredForStaff: boolean;
    /** Active accounts that can reveal passwords but have no authenticator app or passkey. */
    withoutMfa: { id: string; name: string; email: string; role: Role }[];
  };
}

// ---------- emergency access ----------
/** How long emergency access lasts once it starts. */
export const EMERGENCY_ACCESS_HOURS = 24;

export const emergencyContactSchema = z.object({
  userId: z.string().uuid(),
  /** How long the owner has to deny a request before access starts. */
  waitHours: z.number().int().min(1).max(720).default(48),
});
export const emergencyRequestSchema = z.object({
  reason: z.string().trim().min(1, 'Say why you need emergency access.').max(300),
});

export type EmergencyStatus = 'pending' | 'active' | 'denied' | 'ended' | 'expired';
export interface EmergencyContactView {
  userId: string;
  name: string;
  email: string;
  waitHours: number;
  addedByName: string;
  createdAt: string;
}
export interface EmergencyRequestView {
  id: string;
  userId: string | null;
  userName: string;
  reason: string;
  status: EmergencyStatus;
  requestedAt: string;
  /** When access starts unless the owner denies it (or started, if approved sooner). */
  availableAt: string;
  endsAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
}
export interface EmergencyAccessView {
  /** Only the owner manages trusted administrators and decides requests. */
  canManage: boolean;
  /** The signed-in administrator's own place on the list, if any. */
  me: { trusted: boolean; waitHours: number | null };
  contacts: EmergencyContactView[];
  requests: EmergencyRequestView[];
}

// ---------- SIEM ----------
export const SIEM_METHODS = ['webhook', 'syslog'] as const;
export type SiemMethod = (typeof SIEM_METHODS)[number];
export const SYSLOG_TRANSPORTS = ['tls', 'tcp', 'udp'] as const;
export type SyslogTransport = (typeof SYSLOG_TRANSPORTS)[number];

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

export const siemSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    method: z.enum(SIEM_METHODS).default('webhook'),
    url: z
      .string()
      .trim()
      .max(2000)
      .refine((v) => v === '' || isHttpsUrl(v), 'Enter an https:// address.')
      .default(''),
    // Signs each webhook body (HMAC-SHA256). Omitted or null keeps the stored secret; an empty string clears it.
    secret: z.string().max(512).nullable().optional(),
    host: z
      .string()
      .trim()
      .max(253)
      .regex(/^[A-Za-z0-9.:-]*$/, 'Enter a host name or IP address.')
      .default(''),
    port: z.number().int().min(1).max(65535).default(6514),
    transport: z.enum(SYSLOG_TRANSPORTS).default('tls'),
    security: z.boolean().default(true),
    vault: z.boolean().default(true),
  })
  .refine((s) => !s.enabled || s.method !== 'webhook' || s.url, {
    message: 'Enter the webhook address to turn streaming on.',
    path: ['url'],
  })
  .refine((s) => !s.enabled || s.method !== 'syslog' || s.host, {
    message: 'Enter the syslog server to turn streaming on.',
    path: ['host'],
  })
  .refine((s) => !s.enabled || s.security || s.vault, {
    message: 'Choose at least one log to stream.',
    path: ['security'],
  });
export interface SiemSettingsView {
  enabled: boolean;
  method: SiemMethod;
  url: string;
  hasSecret: boolean;
  host: string;
  port: number;
  transport: SyslogTransport;
  security: boolean;
  vault: boolean;
  lastSentAt: string | null;
  lastError: string | null;
  /** Events written since the last successful send. */
  pending: number;
}
/** One audit log row as sent to a SIEM. */
export interface SiemEvent {
  source: 'msp-atlas';
  log: 'security' | 'vault';
  id: string;
  time: string;
  organization: string;
  actor: string;
  action: string;
  detail: string;
  ip: string;
  client?: string | null;
  password?: string;
  reason?: string;
}
