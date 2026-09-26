import { z } from 'zod';

export const PASSWORD_KINDS = ['login', 'bitlocker'] as const;
export type PasswordKind = (typeof PASSWORD_KINDS)[number];

/** What a login is for. Stored when someone picks one; otherwise guessed from the name, username, and address. */
export const PASSWORD_CATEGORIES = [
  'domain',
  'cloud',
  'email',
  'network',
  'wifi',
  'server',
  'database',
  'remote',
  'application',
  'vendor',
  'website',
  'device',
  'other',
] as const;
export type PasswordCategory = (typeof PASSWORD_CATEGORIES)[number];
export const PASSWORD_CATEGORY_LABELS: Record<PasswordCategory, string> = {
  domain: 'Domain / Active Directory',
  cloud: 'Microsoft 365 / cloud admin',
  email: 'Email account',
  network: 'Firewall / network device',
  wifi: 'Wi-Fi',
  server: 'Server / local admin',
  database: 'Database',
  remote: 'Remote access / VPN',
  application: 'Application',
  vendor: 'Vendor / portal',
  website: 'Website / hosting / DNS',
  device: 'Printer / camera / other device',
  other: 'Other',
};

// First match wins, so the more specific kinds come first.
const CATEGORY_RULES: [PasswordCategory, RegExp][] = [
  ['wifi', /\b(wi-?fi|wlan|ssid|wireless|wpa2?|psk)\b/],
  [
    'cloud',
    /(microsoft 365|office ?365|\bm365\b|\bo365\b|onmicrosoft|\bazure\b|\bentra\b|\bintune\b|google workspace|\bgcp\b|\baws\b|admin\.microsoft|portal\.azure)/,
  ],
  [
    'domain',
    /(\bdomain\b|active directory|\bad\b|\bdc\d*\b|\\\\|\b[a-z0-9-]+\\[a-z0-9._$-]+|\.local\b|\bldap\b|\bkrbtgt\b|\bdsrm\b)/,
  ],
  [
    'network',
    /\b(network|firewall|fw|fortigate|fortinet|sonicwall|meraki|unifi|ubiquiti|pfsense|opnsense|watchguard|palo ?alto|cisco|aruba|switch|router|\bap\b|access point|mikrotik|juniper)\b/,
  ],
  ['remote', /\b(vpn|rdp|remote desktop|anydesk|teamviewer|screenconnect|splashtop|bomgar|citrix|rd ?gateway|ssh)\b/],
  ['database', /\b(sql|mssql|mysql|postgres|oracle|mongodb|\bsa\b|database|\bdb\b)\b/],
  [
    'server',
    /\b(server|local admin|localadmin|administrator|idrac|ilo|ipmi|esxi|vcenter|hyper-?v|vmware|proxmox|nas|synology|qnap)\b/,
  ],
  // Before email: "Copier scan-to-email" is the copier's login, not a mailbox.
  ['device', /\b(printer|copier|mfp|camera|nvr|dvr|ups|pbx|phone system|door|alarm|thermostat)\b/],
  ['email', /\b(email|e-mail|mailbox|imap|smtp|pop3|exchange|gmail|outlook)\b/],
  ['website', /\b(wordpress|cpanel|plesk|godaddy|namecheap|cloudflare|registrar|dns|hosting|web ?site|ftp|sftp)\b/],
  ['vendor', /\b(vendor|portal|support|billing|account|supplier|isp|carrier|comcast|spectrum|at&t|verizon)\b/],
  ['application', /\b(app|application|software|quickbooks|erp|crm|ehr|emr|dentrix|eaglesoft|line of business|lob)\b/],
];

/** Best guess at what a login is for, from its name, username, and address. */
export function guessPasswordCategory(name: string, username = '', url = ''): PasswordCategory {
  const text = `${name} ${username} ${url}`.toLowerCase();
  for (const [category, rule] of CATEGORY_RULES) if (rule.test(text)) return category;
  // An email-shaped username with nothing else to go on is usually a mailbox or cloud account.
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(username.toLowerCase())) return 'email';
  return 'other';
}

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

const expiryDate = z
  .string()
  .regex(/^d{4}-d{2}-d{2}$/, 'Choose a valid date.')
  .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d), 'Choose a valid date.');

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
  expiresOn: expiryDate.nullable().default(null),
  restricted: z.boolean().default(false),
  clientVisible: z.boolean().default(false),
  // null: let Atlas guess from the name, username, and address.
  category: z.enum(PASSWORD_CATEGORIES).nullable().default(null),
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
  expiresOn: expiryDate.nullable().optional(),
  restricted: z.boolean().optional(),
  clientVisible: z.boolean().optional(),
  category: z.enum(PASSWORD_CATEGORIES).nullable().optional(),
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
  /** YYYY-MM-DD the account stops working, if it does. */
  expiresOn: string | null;
  changedAt: string;
  rotationDue: string | null;
  restricted: boolean;
  clientVisible: boolean;
  version: number;
  archived: boolean;
  updatedAt: string;
  updatedByName: string | null;
  requireReason: boolean;
  /** What the login is for: the one someone chose, or Atlas's guess (categoryGuessed). */
  category: PasswordCategory;
  categoryGuessed: boolean;
  /** Assets this password is linked to, so similar logins can be told apart. */
  linkedAssets: { id: string; name: string }[];
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
