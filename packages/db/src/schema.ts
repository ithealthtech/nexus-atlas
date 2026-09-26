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
  // Email (SMTP), notification, and audit settings. The SMTP password inside is sealed with the master key.
  settings: jsonb('settings').notNull().default({}),
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
    // SHA-256 hashes of unused one-time recovery codes.
    recoveryCodes: jsonb('recovery_codes').$type<string[]>().notNull().default([]),
    passkeyCount: integer('passkey_count').notNull().default(0),
    notifyDigest: boolean('notify_digest').notNull().default(true),
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
    // When true, technicians must give a reason before revealing a password for this client.
    requireRevealReason: boolean('require_reveal_reason').notNull().default(false),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('clients_org').on(t.orgId, t.name),
    // Search matches names anywhere in the text (ILIKE '%…%'); trigram indexes keep that from scanning every row.
    index('clients_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    check('clients_status_check', sql`${t.status} in ('active','prospect','inactive')`),
  ],
);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [uniqueIndex('groups_org_name').on(t.orgId, sql`lower(${t.name})`)],
);

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
    // Public identifier for the session list; the token hash is never sent to the browser.
    id: uuid('id').notNull().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    csrf: text('csrf').notNull(),
    mfaVerified: boolean('mfa_verified').notNull().default(false),
    // Last time the user re-entered their password; sensitive actions need this to be recent.
    reauthAt: timestamp('reauth_at', { withTimezone: true }),
    // Pending WebAuthn challenge for this session (passkey sign-in or registration).
    challenge: text('challenge'),
    createdAt: created(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
  },
  (t) => [index('sessions_user').on(t.userId), uniqueIndex('sessions_id').on(t.id)],
);

// "Remember this device": skips the second factor on this browser for 30 days.
export const trustedDevices = pgTable(
  'trusted_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    ip: text('ip').notNull().default(''),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('trusted_devices_token').on(t.tokenHash), index('trusted_devices_user').on(t.userId)],
);

export const passkeys = pgTable(
  'passkeys',
  {
    // WebAuthn credential ID (base64url).
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: jsonb('transports').$type<string[]>().notNull().default([]),
    createdAt: created(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [index('passkeys_user').on(t.userId)],
);

// Challenges for passwordless passkey sign-in, before any session exists.
export const authChallenges = pgTable('auth_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  challenge: text('challenge').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const passwordResets = pgTable(
  'password_resets',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index('password_resets_user').on(t.userId)],
);

// Keeps notification emails from being sent twice (one row per user, kind, and day or item).
export const notificationLog = pgTable(
  'notification_log',
  {
    key: text('key').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_log_sent').on(t.sentAt)],
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
    // Hash chain (set by a database trigger): each row's hash covers the row and the previous row's hash.
    prevHash: text('prev_hash').notNull().default(''),
    hash: text('hash').notNull().default(''),
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
  (t) => [
    index('contacts_client').on(t.clientId),
    index('contacts_search').using('gin', t.search),
    index('contacts_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
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
  (t) => [
    index('locations_client').on(t.clientId),
    index('locations_search').using('gin', t.search),
    index('locations_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
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

// ---------------------------------------------------------------- M2: password vault

// Per-organization data keys, stored only wrapped (encrypted) by the master key. The newest active key encrypts new data.
export const vaultKeys = pgTable(
  'vault_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    wrappedKey: text('wrapped_key').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: created(),
  },
  (t) => [index('vault_keys_org').on(t.orgId)],
);

// Folders organize one client's passwords (one level; a password is in at most one folder).
export const passwordFolders = pgTable(
  'password_folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('password_folders_name').on(t.clientId, sql`lower(${t.name})`)],
);

export const passwords = pgTable(
  'passwords',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('login'),
    // PASSWORD_CATEGORIES, or null to show a guess from the name, username, and URL.
    category: text('category'),
    // Deleting a folder leaves its passwords in place, just unfiled.
    folderId: uuid('folder_id').references(() => passwordFolders.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    // Username and URL stay searchable; secrets below are ciphertext only.
    username: text('username').notNull().default(''),
    url: text('url').notNull().default(''),
    secret: text('secret').notNull(),
    notes: text('notes'),
    totp: text('totp'),
    // Keyed hash of the secret, used only to spot reuse within the organization.
    fingerprint: text('fingerprint').notNull(),
    strength: integer('strength').notNull().default(0),
    rotationDays: integer('rotation_days'),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    restricted: boolean('restricted').notNull().default(false),
    // Shown to client accounts (read-only) in the client portal.
    clientVisible: boolean('client_visible').notNull().default(false),
    version: integer('version').notNull().default(1),
    archived: boolean('archived').notNull().default(false),
    createdBy: createdBy(),
    updatedBy: updatedBy(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('passwords_client').on(t.clientId),
    index('passwords_fingerprint').on(t.orgId, t.fingerprint),
    index('passwords_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    check('passwords_kind_check', sql`${t.kind} in ('login','bitlocker')`),
  ],
);

export const passwordHistory = pgTable(
  'password_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    passwordId: uuid('password_id')
      .notNull()
      .references(() => passwords.id, { onDelete: 'cascade' }),
    secret: text('secret').notNull(),
    changedBy: uuid('changed_by').references(() => users.id, { onDelete: 'set null' }),
    changedByName: text('changed_by_name').notNull(),
    createdAt: created(),
  },
  (t) => [index('password_history_item').on(t.passwordId, t.createdAt)],
);

// For restricted items: the only non-admins who may use them.
export const passwordAccess = pgTable(
  'password_access',
  {
    passwordId: uuid('password_id')
      .notNull()
      .references(() => passwords.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.passwordId, t.userId] })],
);

// Groups whose members may use a restricted item.
export const passwordGroupAccess = pgTable(
  'password_group_access',
  {
    passwordId: uuid('password_id')
      .notNull()
      .references(() => passwords.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.passwordId, t.groupId] })],
);

// One-time share links. The server holds only browser-encrypted ciphertext; the key lives in the link's #fragment.
export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    passwordId: uuid('password_id')
      .notNull()
      .references(() => passwords.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    ciphertext: text('ciphertext').notNull(),
    maxViews: integer('max_views').notNull(),
    views: integer('views').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdBy: createdBy(),
    createdByName: text('created_by_name').notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex('share_links_token').on(t.tokenHash), index('share_links_item').on(t.passwordId)],
);

export const vaultAudit = pgTable(
  'vault_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    passwordId: uuid('password_id'),
    passwordName: text('password_name').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    reason: text('reason').notNull().default(''),
    ip: text('ip').notNull().default(''),
    createdAt: created(),
  },
  (t) => [index('vault_audit_item').on(t.passwordId, t.createdAt), index('vault_audit_org').on(t.orgId, t.createdAt)],
);

// Passwords a person pinned for quick access (per person, not shared).
export const passwordFavorites = pgTable(
  'password_favorites',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    passwordId: uuid('password_id')
      .notNull()
      .references(() => passwords.id, { onDelete: 'cascade' }),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.passwordId] })],
);

// ---------------------------------------------------------------- M3b: API, imports

// REST API keys. Only a SHA-256 hash of the secret is stored; the prefix identifies the key in lists and logs.
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    // The key acts with this user's access, limited further by its scopes.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(),
    secretHash: text('secret_hash').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    lastUsedIp: text('last_used_ip').notNull().default(''),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('api_keys_prefix').on(t.prefix), index('api_keys_org').on(t.orgId)],
);

// Maps records from another system (Hudu, IT Glue, 0.2) to Atlas records, so re-running an import updates instead of duplicating.
export const externalRefs = pgTable(
  'external_refs',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    source: text('source').notNull(),
    kind: text('kind').notNull(),
    externalId: text('external_id').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: created(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.source, t.kind, t.externalId] })],
);

export const importJobs = pgTable(
  'import_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id),
    source: text('source').notNull(),
    status: text('status').notNull().default('running'),
    // Counts per kind: { clients: { created, updated, failed }, ... }.
    counts: jsonb('counts').notNull().default({}),
    messages: jsonb('messages').$type<string[]>().notNull().default([]),
    startedBy: uuid('started_by').references(() => users.id, { onDelete: 'set null' }),
    startedByName: text('started_by_name').notNull(),
    createdAt: created(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    // Refreshed while the import runs; a running job with an old heartbeat was abandoned (restart or crash).
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('import_jobs_org').on(t.orgId, t.createdAt),
    // One running import per organization, enforced by the database so concurrent starts can't both win.
    uniqueIndex('import_jobs_one_running')
      .on(t.orgId)
      .where(sql`${t.status} = 'running'`),
    check('import_jobs_status_check', sql`${t.status} in ('running','done','failed')`),
  ],
);

// Backups cover the whole installation, so runs aren't tied to an organization. The files live in the backup folder.
export const backupRuns = pgTable(
  'backup_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('running'),
    fileName: text('file_name'),
    size: bigint('size', { mode: 'number' }),
    rows: integer('rows'),
    files: integer('files'),
    error: text('error'),
    startedByName: text('started_by_name').notNull(),
    createdAt: created(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('backup_runs_created').on(t.createdAt),
    check('backup_runs_trigger_check', sql`${t.trigger} in ('schedule','manual')`),
    check('backup_runs_status_check', sql`${t.status} in ('running','done','failed')`),
  ],
);
