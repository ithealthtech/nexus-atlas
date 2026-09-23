import { z } from 'zod';

// ---------- asset layouts ----------
export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'checkbox',
  'url',
  'email',
  'phone',
  'ip',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  date: 'Date',
  select: 'Choice',
  multiselect: 'Multiple choice',
  checkbox: 'Yes / no',
  url: 'Web address',
  email: 'Email',
  phone: 'Phone',
  ip: 'IP address or subnet',
};

export const layoutFieldSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Field keys use lowercase letters, numbers, and underscores.'),
    label: z.string().trim().min(1).max(80),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
    help: z.string().max(200).default(''),
    showInList: z.boolean().default(false),
    // Date fields that mark an expiry (domains, certificates, licenses, warranties) feed the M3 expirations dashboard.
    expires: z.boolean().default(false),
  })
  .refine((f) => !['select', 'multiselect'].includes(f.type) || f.options.length > 0, {
    message: 'Choice fields need at least one option.',
    path: ['options'],
  });
export type LayoutField = z.infer<typeof layoutFieldSchema>;

export const layoutSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required.').max(80),
    icon: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .default('box'),
    description: z.string().max(300).default(''),
    fields: z.array(layoutFieldSchema).max(60),
  })
  .refine((l) => new Set(l.fields.map((f) => f.key)).size === l.fields.length, {
    message: 'Each field needs a unique key.',
    path: ['fields'],
  });
export const updateLayoutSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  icon: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
  description: z.string().max(300).optional(),
  fields: z.array(layoutFieldSchema).max(60).optional(),
  archived: z.boolean().optional(),
});

// ---------- assets ----------
export const ASSET_STATUSES = ['active', 'inactive', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const assetSchema = z.object({
  layoutId: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required.').max(200),
  status: z.enum(ASSET_STATUSES).default('active'),
  fields: z.record(z.string(), z.unknown()).default({}),
  notes: z.string().max(20000).default(''),
});
export const updateAssetSchema = assetSchema
  .omit({ layoutId: true })
  .partial()
  .extend({ version: z.number().int().positive() });

// ---------- documents ----------
export const DOCUMENT_STATUSES = ['current', 'needs_review', 'draft'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];
export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  current: 'Current',
  needs_review: 'Needs review',
  draft: 'Draft',
};
/** Rich-text content as TipTap/ProseMirror JSON. The server checks node and mark types and link targets. */
export type RichText = { type: 'doc'; content?: unknown[] };
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().startsWith(d), 'Choose a valid date.');
export const documentSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(200),
  content: z.object({ type: z.literal('doc'), content: z.array(z.unknown()).optional() }).passthrough(),
  status: z.enum(DOCUMENT_STATUSES).default('current'),
  reviewDate: isoDate.nullable().default(null),
  folderId: z.string().uuid().nullable().default(null),
});
export const createDocumentSchema = documentSchema.extend({ clientId: z.string().uuid().nullable().default(null) });
export const updateDocumentSchema = documentSchema.partial().extend({ version: z.number().int().positive() });
export const folderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  clientId: z.string().uuid().nullable().default(null),
});

// ---------- contacts and locations ----------
const optionalText = (max: number) => z.string().trim().max(max).default('');
export const contactSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  title: optionalText(120),
  email: z
    .union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email address.').max(254)])
    .default(''),
  phone: optionalText(40),
  mobile: optionalText(40),
  notes: optionalText(5000),
  primary: z.boolean().default(false),
});
export const locationSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  address: optionalText(300),
  city: optionalText(120),
  region: optionalText(120),
  postalCode: optionalText(20),
  country: optionalText(80),
  phone: optionalText(40),
  notes: optionalText(5000),
  primary: z.boolean().default(false),
});

// ---------- links, search, activity ----------
export const ITEM_TYPES = ['asset', 'document', 'contact', 'location'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const relationSchema = z.object({
  type: z.enum(ITEM_TYPES),
  id: z.string().uuid(),
  note: z.string().max(200).default(''),
});

export interface ItemRef {
  type: ItemType | 'client';
  id: string;
  title: string;
  subtitle: string;
  clientId: string | null;
  clientName: string | null;
}
export interface SearchResult extends ItemRef {
  snippet: string;
}

export interface LayoutView {
  id: string;
  key: string;
  name: string;
  icon: string;
  description: string;
  fields: LayoutField[];
  builtIn: boolean;
  archived: boolean;
  assetCount: number;
}
export interface AssetView {
  id: string;
  clientId: string;
  clientName: string;
  layoutId: string;
  layoutName: string;
  layoutIcon: string;
  name: string;
  status: AssetStatus;
  fields: Record<string, unknown>;
  notes: string;
  version: number;
  archived: boolean;
  updatedAt: string;
  updatedByName: string | null;
}
export interface DocumentSummary {
  id: string;
  clientId: string | null;
  clientName: string | null;
  folderId: string | null;
  title: string;
  status: DocumentStatus;
  reviewDate: string | null;
  version: number;
  archived: boolean;
  updatedAt: string;
  updatedByName: string | null;
}
export interface DocumentView extends DocumentSummary {
  content: RichText;
  canEdit: boolean;
}
export interface FolderView {
  id: string;
  clientId: string | null;
  name: string;
  documentCount: number;
}
export interface ContactView extends z.infer<typeof contactSchema> {
  id: string;
  clientId: string;
  updatedAt: string;
}
export interface LocationView extends z.infer<typeof locationSchema> {
  id: string;
  clientId: string;
  updatedAt: string;
}
export interface RevisionView {
  version: number;
  authorName: string;
  createdAt: string;
}
export interface RelationView extends ItemRef {
  relationId: string;
  note: string;
}
export interface AttachmentView {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedByName: string | null;
  createdAt: string;
  previewable: boolean;
}
export interface ActivityView {
  id: string;
  clientId: string | null;
  clientName: string | null;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string | null;
  title: string;
  createdAt: string;
}
