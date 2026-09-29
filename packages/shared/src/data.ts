import { z } from 'zod';

// ---------- REST API keys ----------
export const API_KEY_SCOPES = ['read', 'write', 'passwords'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  read: 'Read documentation',
  write: 'Create and change documentation',
  passwords: 'Use the password vault',
};
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Name the key, for example "ConnectWise sync".').max(80),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1, 'Choose at least one scope.'),
  expiresDays: z.number().int().min(1).max(3650).nullable().default(365),
});
export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  userName: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string;
  revoked: boolean;
  createdAt: string;
}

// ---------- imports ----------
export const IMPORT_SOURCES = ['hudu', 'csv', 'legacy', 'cw-rmm', 'm365'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];
export interface ImportCounts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}
export interface ImportJobView {
  id: string;
  source: ImportSource;
  status: 'running' | 'done' | 'failed';
  counts: Record<string, ImportCounts>;
  messages: string[];
  startedByName: string;
  createdAt: string;
  finishedAt: string | null;
}
export const huduConnectionSchema = z.object({
  url: z
    .string()
    .trim()
    .url('Enter your Hudu address, like https://yourcompany.huducloud.com.')
    .refine((u) => /^https:\/\//i.test(u), 'Use an https:// address.'),
  // Omitted keeps the saved key.
  apiKey: z.string().trim().min(10).max(200).optional(),
});
// ---------- ConnectWise RMM (Asio) ----------
export const CW_RMM_REGIONS = ['na', 'eu', 'au'] as const;
export type CwRmmRegion = (typeof CW_RMM_REGIONS)[number];
export const CW_RMM_REGION_LABELS: Record<CwRmmRegion, string> = {
  na: 'North America',
  eu: 'Europe',
  au: 'Australia',
};
export const cwRmmConnectionSchema = z.object({
  region: z.enum(CW_RMM_REGIONS).default('na'),
  clientId: z.string().trim().min(8, 'Enter the client ID from API Access.').max(200),
  // Omitted keeps the saved secret.
  clientSecret: z.string().trim().min(8).max(500).optional(),
  autoSync: z.boolean().default(true),
});
export interface CwRmmView {
  region: CwRmmRegion;
  clientId: string;
  hasSecret: boolean;
  autoSync: boolean;
  lastSyncAt: string | null;
  options: CwRmmSyncOptions;
}
/** What a ConnectWise RMM sync brings in. */
export const cwRmmSyncOptionsSchema = z.object({
  /** Sites, as locations. */
  locations: z.boolean().default(true),
  /** Devices, as assets. */
  devices: z.boolean().default(true),
});
export type CwRmmSyncOptions = z.infer<typeof cwRmmSyncOptionsSchema>;
/** A ConnectWise RMM company and what Atlas does with it. */
export interface CwRmmCompany {
  id: string;
  name: string;
  /** 'link' syncs into clientId; 'skip' ignores it; null means not decided yet. */
  action: 'link' | 'skip' | null;
  clientId: string | null;
  clientName: string | null;
  /** An Atlas client with the same name, offered when nothing is decided yet. */
  suggestedClientId: string | null;
}
export const cwRmmMappingSchema = z.object({
  mappings: z
    .array(
      z.object({
        companyId: z.string().trim().min(1).max(100),
        // 'create' makes a new Atlas client named after the company, then links it.
        action: z.enum(['link', 'create', 'skip', 'clear']),
        clientId: z.string().uuid().optional(),
      }),
    )
    .max(2000),
});

// ---------- RMM health ----------
export type RmmDeviceKind = 'server' | 'workstation' | 'other';
export type RmmProtection = 'running' | 'not_running' | 'missing';
/** Days since last check-in after which an agent counts as stale, and as very stale. */
export const RMM_STALE_DAYS = { stale: 7, veryStale: 30 } as const;
/** How long since check-in before an agent counts as stale, and very stale. Set per organization. */
export const rmmHealthSettingsSchema = z
  .object({
    staleDays: z.number().int().min(1).max(365).default(RMM_STALE_DAYS.stale),
    veryStaleDays: z.number().int().min(2).max(730).default(RMM_STALE_DAYS.veryStale),
  })
  .refine((v) => v.veryStaleDays > v.staleDays, {
    message: 'Very stale must be more days than stale.',
    path: ['veryStaleDays'],
  });
export type RmmHealthSettings = z.infer<typeof rmmHealthSettingsSchema>;
/** One day of the trend lines, summed over the clients in view. Days without a sync are left out. */
export interface RmmHealthTrendPoint {
  day: string;
  total: number;
  online: number;
  current: number;
  protectionRunning: number;
}
/** Device counts behind the RMM health charts. Unknown means the RMM didn't report it. */
export interface RmmHealthCounts {
  total: number;
  servers: number;
  workstations: number;
  online: number;
  offline: number;
  onlineUnknown: number;
  offlineServers: number;
  current: number;
  stale: number;
  veryStale: number;
  seenUnknown: number;
  protectionRunning: number;
  protectionNotRunning: number;
  protectionMissing: number;
  protectionUnknown: number;
}
export interface RmmHealthReport {
  staleDays: number;
  veryStaleDays: number;
  /** When the newest device status was written, or null before any sync. */
  updatedAt: string | null;
  totals: RmmHealthCounts;
  /** One row per client with synced devices, worst first. */
  clients: { clientId: string; clientName: string; counts: RmmHealthCounts }[];
}
/** Which devices to list when a chart slice is chosen. */
export const RMM_HEALTH_FILTERS = [
  'offline',
  'online_unknown',
  'stale',
  'very_stale',
  'seen_unknown',
  'protection_not_running',
  'protection_missing',
  'protection_unknown',
] as const;
export type RmmHealthFilter = (typeof RMM_HEALTH_FILTERS)[number];
export interface RmmHealthDevice {
  assetId: string;
  clientId: string;
  clientName: string;
  name: string;
  kind: RmmDeviceKind;
  online: boolean | null;
  lastSeenAt: string | null;
  protection: RmmProtection | null;
  protectionProduct: string;
}

// ---------- asset warranty ----------
/** Days ahead within which a warranty counts as expiring soon. Set per organization. */
export const warrantySettingsSchema = z.object({
  soonDays: z.number().int().min(1).max(365).default(90),
});
export type WarrantySettings = z.infer<typeof warrantySettingsSchema>;
/** Assets whose layout has a warranty date field, by where that date falls. Unknown means no date entered. */
export interface WarrantyCounts {
  total: number;
  expired: number;
  soon: number;
  active: number;
  unknown: number;
}
export interface WarrantyReport {
  soonDays: number;
  totals: WarrantyCounts;
  /** One row per client with hardware assets, most expired and unknown first. */
  clients: { clientId: string; clientName: string; counts: WarrantyCounts }[];
}
export const WARRANTY_FILTERS = ['expired', 'soon', 'active', 'unknown'] as const;
export type WarrantyFilter = (typeof WARRANTY_FILTERS)[number];
export interface WarrantyAsset {
  assetId: string;
  name: string;
  clientId: string;
  clientName: string;
  layoutName: string;
  /** YYYY-MM-DD, or null when no date is entered. */
  warrantyExpires: string | null;
  daysLeft: number | null;
}

// ---------- asset statistics ----------
/** What kind of device an asset is, for the count tiles. */
export const ASSET_KINDS = ['server', 'workstation', 'switch', 'network', 'printer', 'phone', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  server: 'Servers',
  workstation: 'Workstations',
  switch: 'Switches',
  network: 'Network devices',
  printer: 'Printers',
  phone: 'Phones',
  other: 'Other devices',
};
/**
 * Which layouts count as which kind of device. "auto" reads each asset's Type field (and its operating system);
 * "none" leaves the layout out of the statistics. Layouts not listed are "auto".
 */
export const assetStatsSettingsSchema = z.object({
  layouts: z
    .record(z.string().uuid(), z.enum([...ASSET_KINDS, 'auto', 'none']))
    .refine((r) => Object.keys(r).length <= 500, 'Too many layouts.')
    .default({}),
});
export type AssetStatsSettings = z.infer<typeof assetStatsSettingsSchema>;
/** Operating system families on the OS chart. */
export const ASSET_OS = [
  'windows-11',
  'windows-10',
  'windows-old',
  'server-2025',
  'server-2022',
  'server-2019',
  'server-2016',
  'server-old',
  'macos',
  'linux',
  'other',
  'unknown',
] as const;
export type AssetOs = (typeof ASSET_OS)[number];
export const ASSET_OS_INFO: Record<AssetOs, { label: string; endOfSupport: boolean }> = {
  'windows-11': { label: 'Windows 11', endOfSupport: false },
  'windows-10': { label: 'Windows 10', endOfSupport: true },
  'windows-old': { label: 'Windows 8.1 or older', endOfSupport: true },
  'server-2025': { label: 'Windows Server 2025', endOfSupport: false },
  'server-2022': { label: 'Windows Server 2022', endOfSupport: false },
  'server-2019': { label: 'Windows Server 2019', endOfSupport: false },
  'server-2016': { label: 'Windows Server 2016', endOfSupport: false },
  'server-old': { label: 'Windows Server 2012 R2 or older', endOfSupport: true },
  macos: { label: 'macOS', endOfSupport: false },
  linux: { label: 'Linux', endOfSupport: false },
  other: { label: 'Other', endOfSupport: false },
  unknown: { label: 'Not recorded', endOfSupport: false },
};
export type AssetKindCounts = Record<AssetKind, number> & { total: number };
export interface AssetStatsReport {
  totals: AssetKindCounts;
  /** Devices per operating system family; every family is present. */
  os: Record<AssetOs, number>;
  /** One row per client with devices, most devices first. */
  clients: { clientId: string; clientName: string; counts: AssetKindCounts; endOfSupport: number }[];
}
/** `kind:<AssetKind>`, `os:<AssetOs>`, or `eos` (every end-of-support device). */
export type AssetStatsFilter = `kind:${AssetKind}` | `os:${AssetOs}` | 'eos';
export function isAssetStatsFilter(v: unknown): v is AssetStatsFilter {
  if (v === 'eos') return true;
  if (typeof v !== 'string') return false;
  const [what, value] = v.split(':');
  return what === 'kind'
    ? (ASSET_KINDS as readonly string[]).includes(value!)
    : what === 'os' && (ASSET_OS as readonly string[]).includes(value!);
}
export interface AssetStatsAsset {
  assetId: string;
  name: string;
  clientId: string;
  clientName: string;
  layoutName: string;
  kind: AssetKind;
  os: AssetOs;
  /** The operating system as recorded on the asset. */
  osName: string;
}

// ---------- Microsoft 365 documentation sync ----------
/** One multi-tenant app registration in the MSP's tenant; each client tenant grants it admin consent. */
export const m365ConnectionSchema = z.object({
  // Any GUID shape: Microsoft's IDs aren't all RFC 4122 UUIDs.
  clientId: z.string().trim().pipe(z.guid('Enter the Application (client) ID: a GUID from the app’s Overview page.')),
  // Omitted keeps the saved secret.
  clientSecret: z.string().trim().min(8).max(500).optional(),
  autoSync: z.boolean().default(true),
});
/** What a Microsoft 365 sync brings in. */
export const m365SyncOptionsSchema = z.object({
  /** Users, as contacts. */
  users: z.boolean().default(true),
  /** Only users with a license (skips shared mailboxes, rooms, and service accounts). */
  licensedOnly: z.boolean().default(true),
  /** Subscriptions, as License assets. */
  licenses: z.boolean().default(true),
  /** Verified custom domains, as Domain assets. */
  domains: z.boolean().default(true),
});
export type M365SyncOptions = z.infer<typeof m365SyncOptionsSchema>;
export interface M365View {
  clientId: string;
  hasSecret: boolean;
  autoSync: boolean;
  lastSyncAt: string | null;
  options: M365SyncOptions;
  /** The address to add as the app's Web redirect URI, for admin consent. */
  redirectUri: string;
}
/** An Atlas client and the Microsoft 365 tenant linked to it. */
export interface M365TenantLink {
  clientId: string;
  clientName: string;
  tenantId: string;
  tenantName: string | null;
  /** Whether the last check or sync could sign in to the tenant. */
  status: 'unchecked' | 'ok' | 'failed';
  detail: string | null;
  checkedAt: string | null;
  consentUrl: string;
}
export const m365LinkSchema = z.object({
  clientId: z.string().uuid(),
  // A tenant ID (GUID) or one of the tenant's domains, like contoso.onmicrosoft.com.
  tenant: z
    .string()
    .trim()
    .min(3)
    .max(255)
    .regex(/^[A-Za-z0-9.-]+$/, 'Enter the tenant ID or a domain, like contoso.onmicrosoft.com.'),
});

export interface HuduPreview {
  companies: number;
  assetLayouts: number;
  assets: number;
  articles: number;
  passwords: number;
  /** For choosing what to import: each company, and each asset layout with how many assets use it. */
  companyList: { id: number; name: string }[];
  layoutList: { id: number; name: string; assets: number }[];
}

/** What a Hudu import brings in. null lists mean "all", including ones added in Hudu later. */
export const huduImportOptionsSchema = z.object({
  clients: z.boolean().default(true),
  /** Each company's address, as its main location. */
  locations: z.boolean().default(true),
  assets: z.boolean().default(true),
  documents: z.boolean().default(true),
  passwords: z.boolean().default(true),
  companyIds: z.array(z.number().int()).max(5000).nullable().default(null),
  layoutIds: z.array(z.number().int()).max(1000).nullable().default(null),
});
export type HuduImportOptions = z.infer<typeof huduImportOptionsSchema>;

export const CSV_TARGETS = ['clients', 'contacts', 'locations', 'assets', 'passwords'] as const;
export type CsvTarget = (typeof CSV_TARGETS)[number];
export const csvImportSchema = z.object({
  target: z.enum(CSV_TARGETS),
  // Required for assets: which layout the rows use.
  layoutId: z.string().uuid().optional(),
  // Rows already mapped in the browser: Atlas field name → value. "client" names the client by name.
  rows: z
    .array(z.record(z.string(), z.string().max(20000)))
    .min(1)
    .max(5000),
  dryRun: z.boolean().default(false),
});
export interface CsvImportResult {
  created: number;
  updated: number;
  errors: { row: number; message: string }[];
}

// ---------- branding and theme ----------
// Set by administrators under Administration → Theme; one theme for the whole organization (staff, client
// portal, and sign-in pages). Every field defaults, so settings saved before the theme manager still load.
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #1f6f4a.')
  .nullable()
  .default(null);
// Images are stored as data: URLs (base64 is about 4/3 of the file size).
const image = (types: string, kb: number, what: string) =>
  z
    .string()
    .max(Math.ceil((kb * 1024 * 4) / 3) + 64, `Use ${what} under ${kb} KB.`)
    .regex(
      new RegExp(`^data:image\\/(${types});base64,[A-Za-z0-9+/=]+$`),
      `That file type isn't supported for ${what}.`,
    )
    .nullable()
    .default(null);

export const THEME_FONT_SCALES = ['small', 'default', 'large'] as const;
export const THEME_RADII = ['square', 'default', 'round'] as const;
export const THEME_SIDEBAR_WIDTHS = ['narrow', 'default', 'wide'] as const;
export const THEME_DENSITIES = ['comfortable', 'compact'] as const;
export const THEME_NAV_STYLES = ['filled', 'bar', 'subtle'] as const;

export const brandingSchema = z.object({
  // Identity
  brandName: z.string().trim().max(60).default(''),
  tagline: z.string().trim().max(80).default(''),
  browserTitle: z.string().trim().max(60).default(''),
  logo: image('png|jpeg|svg\\+xml', 150, 'a logo'),
  logoDark: image('png|jpeg|svg\\+xml', 150, 'a logo'),
  favicon: image('png|svg\\+xml|x-icon|vnd\\.microsoft\\.icon', 50, 'a favicon'),
  // Colours (null = Atlas default). Text on them is chosen automatically for contrast.
  accent: hex,
  accentDark: hex,
  sidebar: hex,
  sidebarDark: hex,
  // Sign-in pages
  loginHeadline: z.string().trim().max(80).default(''),
  loginText: z.string().trim().max(300).default(''),
  loginBackground: image('png|jpeg|webp', 400, 'a background image'),
  // Client portal
  portalWelcome: z.string().trim().max(500).default(''),
  // Layout
  fontScale: z.enum(THEME_FONT_SCALES).default('default'),
  radius: z.enum(THEME_RADII).default('default'),
  sidebarWidth: z.enum(THEME_SIDEBAR_WIDTHS).default('default'),
  density: z.enum(THEME_DENSITIES).default('comfortable'),
  navStyle: z.enum(THEME_NAV_STYLES).default('filled'),
  motion: z.boolean().default(true),
});
export type Branding = z.infer<typeof brandingSchema>;
export const DEFAULT_BRANDING: Branding = brandingSchema.parse({});

// ---------- duplicates ----------
export const DUPLICATE_TYPES = ['assets', 'clients', 'contacts', 'locations'] as const;
export type DuplicateType = (typeof DUPLICATE_TYPES)[number];
/** Records that look like the same thing: same name (ignoring case and spacing) in the same client. */
export interface DuplicateGroup {
  type: DuplicateType;
  name: string;
  clientId: string | null;
  clientName: string | null;
  items: {
    id: string;
    name: string;
    /** What tells them apart: the asset layout, a contact's email, a location's address, a client's item count. */
    detail: string;
    /** How many fields hold a value (assets) or how much the record holds, to suggest which one to keep. */
    filled: number;
    createdAt: string;
    updatedAt: string;
  }[];
}
export const mergeDuplicatesSchema = z.object({
  type: z.enum(DUPLICATE_TYPES),
  keepId: z.string().uuid(),
  mergeIds: z.array(z.string().uuid()).min(1).max(50),
});
export interface MergeResult {
  keptId: string;
  merged: number;
  /** Fields added to the kept asset's layout for values it had no field for. */
  fieldsAdded: string[];
}

// ---------- Microsoft Entra ID sign-in ----------
export const entraSettingsSchema = z.object({
  /** The directory (tenant) ID, or its domain name. */
  tenantId: z
    .string()
    .trim()
    .min(3, 'Enter the Directory (tenant) ID.')
    .max(200)
    .regex(/^[A-Za-z0-9.-]+$/, 'Enter the Directory (tenant) ID from the app’s Overview page.'),
  clientId: z.string().trim().uuid('Enter the Application (client) ID from the app’s Overview page.'),
  // Omitted keeps the saved secret.
  clientSecret: z.string().trim().min(8).max(500).optional(),
  enabled: z.boolean().default(false),
  /** Accept Microsoft's own multi-factor sign-in as the second step, instead of also asking for an Atlas code. */
  trustMfa: z.boolean().default(false),
  /** Staff must sign in with Microsoft; only the owner can still use a password (break-glass). */
  requireSso: z.boolean().default(false),
});
export interface EntraView {
  tenantId: string;
  clientId: string;
  hasSecret: boolean;
  enabled: boolean;
  trustMfa: boolean;
  requireSso: boolean;
  /** Add this as the app registration's Web redirect URI. */
  redirectUri: string;
}
