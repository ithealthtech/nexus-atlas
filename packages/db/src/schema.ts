import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// The MSP tenant. v1 runs one organization per installation; every tenant table still carries org_id.
export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: created(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    email: text('email').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    // Baseline level for every client (staff only). Explicit grants can raise it for specific clients.
    allClients: text('all_clients').notNull().default('none'),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    mfaSecret: text('mfa_secret'),
    mfaPending: text('mfa_pending'),
    mfaLastStep: bigint('mfa_last_step', { mode: 'number' }).notNull().default(0),
    disabled: boolean('disabled').notNull().default(false),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    check(
      'users_role_check',
      sql`${t.role} in ('owner','admin','technician','readonly_technician','client_editor','client_viewer')`,
    ),
    check('users_all_clients_check', sql`${t.allClients} in ('none','read','edit','edit_passwords')`),
    check('users_email_lower', sql`${t.email} = lower(${t.email})`),
  ],
);

export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    type: text('type').notNull().default('Customer'),
    status: text('status').notNull().default('active'),
    notes: text('notes').notNull().default(''),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('clients_org').on(t.orgId, t.name),
    check('clients_status_check', sql`${t.status} in ('active','prospect','inactive')`),
  ],
);

export const groups = pgTable('groups', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id),
  name: text('name').notNull(),
  createdAt: created(),
});

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

// Per-client grants for a user or a group. The effective level is the highest grant, capped by the user's role.
export const clientAccess = pgTable(
  'client_access',
  {
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => groups.id, { onDelete: 'cascade' }),
    level: text('level').notNull(),
  },
  (t) => [
    uniqueIndex('client_access_user')
      .on(t.clientId, t.userId)
      .where(sql`${t.userId} is not null`),
    uniqueIndex('client_access_group')
      .on(t.clientId, t.groupId)
      .where(sql`${t.groupId} is not null`),
    index('client_access_by_user').on(t.userId),
    check('client_access_principal', sql`(${t.userId} is null) <> (${t.groupId} is null)`),
    check('client_access_level_check', sql`${t.level} in ('read','edit','edit_passwords')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrf: text('csrf').notNull(),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    createdAt: created(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

export const securityEvents = pgTable(
  'security_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id').references(() => orgs.id),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    detail: text('detail').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: created(),
  },
  (t) => [index('security_events_org').on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------- M1: documentation

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const createdBy = () => uuid('created_by').references(() => users.id, { onDelete: 'set null' });
const updatedBy = () => uuid('updated_by').references(() => users.id, { onDelete: 'set null' });

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title').notNull().default(''),
    email: text('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    mobile: text('mobile').notNull().default(''),
    notes: text('notes').notNull().default(''),
    primary: boolean('is_primary').notNull().default(false),
    createdAt: created(),
    updatedAt: updated(),
    search: tsvector('search').generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(title,'') || ' ' || coalesce(email,'') || ' ' || coalesce(phone,''))`,
    ),
  },
  (t) => [index('contacts_client').on(t.clientId), index('contacts_search').using('gin', t.search)],
);

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    address: text('address').notNull().default(''),
    city: text('city').notNull().default(''),
    region: text('region').notNull().default(''),
    postalCode: text('postal_code').notNull().default(''),
    country: text('country').notNull().default(''),
    phone: text('phone').notNull().default(''),
    notes: text('notes').notNull().default(''),
    primary: boolean('is_primary').notNull().default(false),
    createdAt: created(),
    updatedAt: updated(),
    search: tsvector('search').generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(address,'') || ' ' || coalesce(city,''))`,
    ),
  },
  (t) => [index('locations_client').on(t.clientId), index('locations_search').using('gin', t.search)],
);

// Admin-defined templates for assets ("flexible assets"). Fields are validated by the API.
export const assetLayouts = pgTable(
  'asset_layouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    icon: text('icon').notNull().default('box'),
    description: text('description').notNull().default(''),
    fields: jsonb('fields').notNull().default([]),
    builtIn: boolean('built_in').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    position: integer('position').notNull().default(0),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('asset_layouts_key').on(t.orgId, t.key)],
);

export const assets = pgTable(
  'assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    layoutId: uuid('layout_id')
      .notNull()
      .references(() => assetLayouts.id),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    fields: jsonb('fields').notNull().default({}),
    notes: text('notes').notNull().default(''),
    version: integer('version').notNull().default(1),
    archived: boolean('archived').notNull().default(false),
    createdBy: createdBy(),
    updatedBy: updatedBy(),
    createdAt: created(),
    updatedAt: updated(),
    search: tsvector('search').generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(fields::text,'') || ' ' || coalesce(notes,''))`,
    ),
  },
  (t) => [
    index('assets_client').on(t.clientId, t.layoutId),
    index('assets_search').using('gin', t.search),
    index('assets_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    check('assets_status_check', sql`${t.status} in ('active','inactive','retired')`),
  ],
);

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    // Null client: the MSP-wide knowledge base.
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: created(),
  },
  (t) => [index('folders_scope').on(t.orgId, t.clientId)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    content: jsonb('content').notNull(),
    contentText: text('content_text').notNull().default(''),
    status: text('status').notNull().default('current'),
    reviewDate: date('review_date', { mode: 'string' }),
    version: integer('version').notNull().default(1),
    archived: boolean('archived').notNull().default(false),
    createdBy: createdBy(),
    updatedBy: updatedBy(),
    createdAt: created(),
    updatedAt: updated(),
    search: tsvector('search').generatedAlwaysAs(
      (): ReturnType<typeof sql> =>
        sql`setweight(to_tsvector('simple', coalesce(title,'')), 'A') || to_tsvector('simple', coalesce(content_text,''))`,
    ),
  },
  (t) => [
    index('documents_scope').on(t.orgId, t.clientId),
    index('documents_search').using('gin', t.search),
    index('documents_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
    check('documents_status_check', sql`${t.status} in ('current','needs_review','draft')`),
  ],
);

// Snapshots of assets and documents; restoring a revision creates a new version.
export const revisions = pgTable(
  'revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    version: integer('version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('revisions_entity_version').on(t.entityType, t.entityId, t.version)],
);

// Undirected links between items, stored once with (a, b) in a stable order.
export const relations = pgTable(
  'relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    aType: text('a_type').notNull(),
    aId: uuid('a_id').notNull(),
    bType: text('b_type').notNull(),
    bId: uuid('b_id').notNull(),
    note: text('note').notNull().default(''),
    createdBy: createdBy(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('relations_pair').on(t.aType, t.aId, t.bType, t.bId),
    index('relations_b').on(t.bType, t.bId),
    check('relations_not_self', sql`${t.aId} <> ${t.bId}`),
  ],
);

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: created(),
  },
  (t) => [index('attachments_entity').on(t.entityType, t.entityId)],
);

export const activity = pgTable(
  'activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    title: text('title').notNull(),
    createdAt: created(),
  },
  (t) => [index('activity_scope').on(t.orgId, t.clientId, t.createdAt)],
);
