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
export const IMPORT_SOURCES = ['hudu', 'csv', 'legacy', 'cw-rmm'] as const;
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
}
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

export interface HuduPreview {
  companies: number;
  assetLayouts: number;
  assets: number;
  articles: number;
  passwords: number;
}

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
