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
export const IMPORT_SOURCES = ['hudu', 'csv', 'legacy'] as const;
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

// ---------- branding ----------
export const brandingSchema = z.object({
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #1f6f4a.')
    .nullable()
    .default(null),
  // A small PNG, JPEG, or SVG as a data: URL.
  logo: z
    .string()
    .max(200_000, 'Use a logo under 150 KB.')
    .regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/, 'Upload a PNG, JPEG, or SVG image.')
    .nullable()
    .default(null),
  portalWelcome: z.string().trim().max(500).default(''),
});
export type Branding = z.infer<typeof brandingSchema>;
