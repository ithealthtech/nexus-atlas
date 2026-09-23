import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
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
