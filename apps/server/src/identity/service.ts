import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  ROLE_INFO,
  createUserSchema,
  levelRank,
  resetUserSchema,
  setupSchema,
  updateUserSchema,
  userAccessSchema,
  type AccessLevel,
  type Actor,
  type Role,
  type SecurityEventView,
  type SessionStage,
  type UserView,
} from '@atlas/shared';
import { fail } from '../errors.js';
import { open, seal, type KeyProvider } from '../crypto/keys.js';
import { checkPassword, hashPassword, verifyPassword } from './passwords.js';
import { matchTotp, newTotpSecret, otpauthUri } from './totp.js';

export const LIMITS = {
  attempts: 5,
  lockMs: 15 * 60_000,
  idleMs: 2 * 3_600_000,
  absoluteMs: 12 * 3_600_000,
  sessionsPerUser: 10,
};
type UserRow = typeof schema.users.$inferSelect;
type SessionRow = typeof schema.sessions.$inferSelect;
export interface SessionContext {
  hash: string;
  session: SessionRow;
  user: UserRow;
  actor: Actor;
  stage: SessionStage;
  organization: { id: string; name: string };
}
interface RequestMeta {
  ip: string;
  userAgent?: string;
}

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const mfaAad = (userId: string) => `user|${userId}|mfa`;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** A second factor is an authenticator app, a passkey, or both. */
export const hasMfa = (user: Pick<UserRow, 'mfaSecret' | 'passkeyCount'>) => !!user.mfaSecret || user.passkeyCount > 0;
export const REAUTH_MS = 10 * 60_000;

export function actorFor(user: UserRow): Actor {
  return {
    id: user.id,
    orgId: user.orgId,
    name: user.name,
    email: user.email,
    role: user.role as Role,
    mfa: hasMfa(user),
    allClients: user.allClients as AccessLevel,
  };
}

export class IdentityService {
  private dummyHash?: string;

  constructor(
    private readonly db: Database,
    private readonly keys: KeyProvider,
    private readonly options: { requireStaffMfa: boolean },
  ) {}

  // ---------- events ----------
  async event(
    who: { id?: string | null; orgId?: string | null; name?: string } | null,
    action: string,
    detail = '',
    ip = '',
  ) {
    await this.db.insert(schema.securityEvents).values({
      orgId: who?.orgId ?? null,
      userId: who?.id ?? null,
      actor: who?.name ?? 'Unknown account',
      action,
      detail: detail.slice(0, 300),
      ip: ip.slice(0, 64),
    });
  }

  // ---------- setup ----------
  async needsSetup(): Promise<boolean> {
    const [row] = await this.db.select({ id: schema.users.id }).from(schema.users).limit(1);
    return !row;
  }

  async bootstrap(input: unknown, meta: RequestMeta): Promise<UserRow> {
    const body = setupSchema.omit({ setupCode: true }).parse(input);
    checkPassword(body.password, body.email);
    const passwordHash = await hashPassword(body.password);
    return this.db.transaction(async (tx) => {
      // Serialize concurrent setup attempts; only the first can create the owner.
      await tx.execute(sql`select pg_advisory_xact_lock(727275)`);
      const [existing] = await tx.select({ id: schema.users.id }).from(schema.users).limit(1);
      if (existing) fail(409, 'Atlas is already set up. Sign in instead.');
      const [org] = await tx.insert(schema.orgs).values({ name: body.organization }).returning();
      const [user] = await tx
        .insert(schema.users)
        .values({
          orgId: org!.id,
          email: body.email,
          name: body.name,
          role: 'owner',
          allClients: 'edit_passwords',
          passwordHash,
        })
        .returning();
      await tx.insert(schema.securityEvents).values({
        orgId: org!.id,
        userId: user!.id,
        actor: user!.name,
        action: 'Owner created',
        detail: 'First-run setup',
        ip: meta.ip,
      });
      return user!;
    });
  }

  // ---------- sign-in ----------
  async authenticate(email: unknown, password: unknown, meta: RequestMeta): Promise<UserRow> {
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 256)
      fail(400, 'Enter your email and password.');
    const address = (email as string).trim().toLowerCase();
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, address));
    this.dummyHash ??= await hashPassword(randomBytes(16).toString('hex'));
    // Always run one scrypt verification so unknown accounts take the same time.
    const valid = await verifyPassword(password as string, user?.passwordHash ?? this.dummyHash);
    if (!user) {
      await this.event(null, 'Sign-in failed', `Unknown account ${address.slice(0, 80)}`, meta.ip);
      fail(401, 'Email or password is incorrect.');
    }
    const u = user!;
    if (u.lockedUntil && u.lockedUntil.getTime() > Date.now()) {
      await this.event(u, 'Sign-in blocked', 'Account is temporarily locked', meta.ip);
      fail(429, 'Too many attempts. Try again in 15 minutes.');
    }
    if (!valid) {
      await this.recordFailure(u, 'Incorrect password', meta.ip);
      fail(401, 'Email or password is incorrect.');
    }
    if (u.disabled) {
      await this.event(u, 'Sign-in blocked', 'Account is disabled', meta.ip);
      fail(401, 'Email or password is incorrect.');
    }
    await this.db.update(schema.users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(schema.users.id, u.id));
    return u;
  }

  async recordFailure(user: UserRow, reason: string, ip: string) {
    const attempts = user.failedAttempts + 1;
    const lock = attempts >= LIMITS.attempts;
    await this.db
      .update(schema.users)
      .set({ failedAttempts: lock ? 0 : attempts, lockedUntil: lock ? new Date(Date.now() + LIMITS.lockMs) : null })
      .where(eq(schema.users.id, user.id));
    if (lock) await this.db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
    await this.event(
      user,
      lock ? 'Account locked' : reason === 'Incorrect password' ? 'Sign-in failed' : 'MFA verification failed',
      lock ? `${LIMITS.attempts} failed attempts` : reason,
      ip,
    );
    if (lock) fail(429, 'Too many attempts. Try again in 15 minutes.');
  }

  async createSession(user: UserRow, meta: RequestMeta, mfaVerified = false, detail = ''): Promise<{ token: string }> {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.sessions)
        .where(
          or(
            lt(schema.sessions.lastSeenAt, new Date(now - LIMITS.idleMs)),
            lt(schema.sessions.createdAt, new Date(now - LIMITS.absoluteMs)),
          ),
        );
      const existing = await tx
        .select({ tokenHash: schema.sessions.tokenHash })
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, user.id))
        .orderBy(desc(schema.sessions.lastSeenAt))
        .offset(LIMITS.sessionsPerUser - 1);
      for (const row of existing) await tx.delete(schema.sessions).where(eq(schema.sessions.tokenHash, row.tokenHash));
      await tx.insert(schema.sessions).values({
        tokenHash: tokenHash(token),
        userId: user.id,
        csrf: randomBytes(32).toString('base64url'),
        mfaVerified,
        // Entering the password counts as a fresh confirmation for sensitive actions.
        reauthAt: new Date(now),
        ip: meta.ip.slice(0, 64),
        userAgent: (meta.userAgent ?? '').slice(0, 200),
      });
      if (mfaVerified || !hasMfa(user)) {
        await tx.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
        await tx.insert(schema.securityEvents).values({
          orgId: user.orgId,
          userId: user.id,
          actor: user.name,
          action: 'Signed in',
          detail: detail || (hasMfa(user) ? 'Password and MFA' : 'Password'),
          ip: meta.ip,
        });
      }
    });
    return { token };
  }

  stageFor(user: UserRow, session: SessionRow): SessionStage {
    if (hasMfa(user) && !session.mfaVerified) return 'mfa';
    if (user.mustChangePassword) return 'password';
    if (this.options.requireStaffMfa && ROLE_INFO[user.role as Role].staff && !hasMfa(user)) return 'mfa-setup';
    return 'active';
  }

  async resolve(token: string | undefined): Promise<SessionContext | null> {
    if (!token) return null;
    const hash = tokenHash(token);
    const [row] = await this.db
      .select({ session: schema.sessions, user: schema.users, org: schema.orgs })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.users.orgId))
      .where(eq(schema.sessions.tokenHash, hash));
    if (!row) return null;
    const now = Date.now();
    const { session, user, org } = row;
    if (
      user.disabled ||
      session.lastSeenAt.getTime() < now - LIMITS.idleMs ||
      session.createdAt.getTime() < now - LIMITS.absoluteMs
    ) {
      await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hash));
      return null;
    }
    if (now - session.lastSeenAt.getTime() > 60_000)
      await this.db
        .update(schema.sessions)
        .set({ lastSeenAt: new Date(now) })
        .where(eq(schema.sessions.tokenHash, hash));
    return {
      hash,
      session,
      user,
      actor: actorFor(user),
      stage: this.stageFor(user, session),
      organization: { id: org.id, name: org.name },
    };
  }

  async signOut(context: SessionContext, ip: string) {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, context.hash));
    await this.event(context.user, 'Signed out', '', ip);
  }

  private revokeAll(userId: string, keepHash = '') {
    return this.db
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.tokenHash, keepHash)));
  }

  // ---------- MFA ----------
  /** Throws unless the user confirmed their password within the last few minutes. */
  requireRecentAuth(context: SessionContext) {
    const at = context.session.reauthAt?.getTime() ?? 0;
    if (Date.now() - at > REAUTH_MS) fail(403, 'Confirm your password to continue.', 'reauth');
  }

  async reauthenticate(context: SessionContext, password: string, ip: string) {
    const { user } = context;
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now())
      fail(429, 'Too many attempts. Try again in 15 minutes.');
    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.recordFailure(user, 'Incorrect password', ip);
      fail(400, 'That password is incorrect.', 'reauth_invalid');
    }
    await this.db
      .update(schema.sessions)
      .set({ reauthAt: new Date() })
      .where(eq(schema.sessions.tokenHash, context.hash));
    await this.db.update(schema.users).set({ failedAttempts: 0 }).where(eq(schema.users.id, user.id));
  }

  /** Marks the session's second factor as done (after TOTP, a passkey, or a recovery code). */
  async completeMfa(context: SessionContext, detail: string, ip: string) {
    const { user } = context;
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ failedAttempts: 0, lastLoginAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await tx.update(schema.sessions).set({ mfaVerified: true }).where(eq(schema.sessions.tokenHash, context.hash));
      await tx.insert(schema.securityEvents).values({
        orgId: user.orgId,
        userId: user.id,
        actor: user.name,
        action: 'Signed in',
        detail,
        ip,
      });
    });
  }

  async verifyMfa(context: SessionContext, code: string, ip: string) {
    const { user } = context;
    if (!user.mfaSecret) fail(400, 'MFA is not enabled for this account.');
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now())
      fail(429, 'Too many attempts. Try again in 15 minutes.');
    const step = matchTotp(open(this.keys, user.mfaSecret!, mfaAad(user.id)), code, user.mfaLastStep);
    if (!step) {
      await this.recordFailure(user, 'Wrong MFA code', ip);
      fail(400, 'That code did not match. Check your authenticator app and try again.', 'mfa_invalid');
    }
    await this.db.transaction(async (tx) => {
      // The step check in WHERE makes concurrent use of the same code fail.
      const updated = await tx
        .update(schema.users)
        .set({ mfaLastStep: step, failedAttempts: 0, lastLoginAt: new Date() })
        .where(and(eq(schema.users.id, user.id), lt(schema.users.mfaLastStep, step)))
        .returning({ id: schema.users.id });
      if (!updated.length) fail(400, 'That code was already used. Wait for the next one.', 'mfa_invalid');
      await tx.update(schema.sessions).set({ mfaVerified: true }).where(eq(schema.sessions.tokenHash, context.hash));
      await tx.insert(schema.securityEvents).values({
        orgId: user.orgId,
        userId: user.id,
        actor: user.name,
        action: 'Signed in',
        detail: 'Password and MFA',
        ip,
      });
    });
  }

  async beginMfa(context: SessionContext): Promise<{ secret: string; uri: string }> {
    const { user } = context;
    if (user.mfaSecret) fail(409, 'MFA is already on. Ask an administrator to reset it.');
    // Reuse an unconfirmed key so reloading the setup page doesn't invalidate an app entry already added.
    const secret = user.mfaPending ? open(this.keys, user.mfaPending, mfaAad(user.id)) : newTotpSecret();
    if (!user.mfaPending)
      await this.db
        .update(schema.users)
        .set({ mfaPending: seal(this.keys, secret, mfaAad(user.id)), updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
    return { secret, uri: otpauthUri(secret, user.email) };
  }

  async confirmMfa(context: SessionContext, code: string, ip: string): Promise<{ recoveryCodes: string[] }> {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, context.user.id));
    if (!user?.mfaPending) fail(400, 'Start MFA setup first.');
    const secret = open(this.keys, user!.mfaPending!, mfaAad(user!.id));
    const step = matchTotp(secret, code, 0);
    if (!step) fail(400, 'That code did not match. Check the time on your device and try again.');
    // First second factor: issue recovery codes. Adding TOTP next to a passkey keeps the existing ones.
    const codes = user!.recoveryCodes.length ? [] : newRecoveryCodes();
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({
          mfaSecret: seal(this.keys, secret, mfaAad(user!.id)),
          mfaPending: null,
          mfaLastStep: step,
          ...(codes.length ? { recoveryCodes: codes.map(hashRecoveryCode) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user!.id));
      await tx.update(schema.sessions).set({ mfaVerified: true }).where(eq(schema.sessions.tokenHash, context.hash));
      await tx
        .delete(schema.sessions)
        .where(and(eq(schema.sessions.userId, user!.id), ne(schema.sessions.tokenHash, context.hash)));
      await tx.insert(schema.securityEvents).values({
        orgId: user!.orgId,
        userId: user!.id,
        actor: user!.name,
        action: 'MFA enabled',
        detail: 'Authenticator app',
        ip,
      });
    });
    return { recoveryCodes: codes };
  }

  // ---------- account ----------
  async changePassword(context: SessionContext, current: string, next: string, ip: string) {
    const { user } = context;
    if (!(await verifyPassword(current, user.passwordHash))) {
      await this.event(user, 'Password change failed', 'Current password incorrect', ip);
      fail(400, 'Your current password is incorrect.');
    }
    checkPassword(next, user.email);
    if (current === next) fail(400, 'Choose a password you have not just used.');
    const passwordHash = await hashPassword(next);
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await tx
        .delete(schema.sessions)
        .where(and(eq(schema.sessions.userId, user.id), ne(schema.sessions.tokenHash, context.hash)));
      await tx.insert(schema.securityEvents).values({
        orgId: user.orgId,
        userId: user.id,
        actor: user.name,
        action: 'Password changed',
        detail: 'Other sessions signed out',
        ip,
      });
    });
  }

  // ---------- administration ----------
  private async userView(user: UserRow): Promise<UserView> {
    const grants = await this.db
      .select({ clientId: schema.clientAccess.clientId, level: schema.clientAccess.level })
      .from(schema.clientAccess)
      .where(eq(schema.clientAccess.userId, user.id));
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
      allClients: ROLE_INFO[user.role as Role].admin ? 'edit_passwords' : (user.allClients as AccessLevel),
      grants: grants.map((g) => ({ clientId: g.clientId, level: g.level as AccessLevel })),
      mfa: hasMfa(user),
      disabled: user.disabled,
      locked: !!user.lockedUntil && user.lockedUntil.getTime() > Date.now(),
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private requireAdmin(actor: Actor) {
    if (!ROLE_INFO[actor.role].admin) fail(403, 'Administrator access is required.');
  }

  private async findUser(actor: Actor, id: string): Promise<UserRow> {
    const [user] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.users)
          .where(and(eq(schema.users.id, id), eq(schema.users.orgId, actor.orgId)))
      : [];
    if (!user) fail(404, 'User not found.');
    return user!;
  }

  /** Checks a role/level/grants combination and that every client belongs to the organization. */
  private async validateAccess(
    actor: Actor,
    role: Role,
    allClients: AccessLevel,
    grants: { clientId: string; level: AccessLevel }[],
  ) {
    const info = ROLE_INFO[role];
    if (role === 'owner' && actor.role !== 'owner') fail(403, 'Only an owner can create or change owners.');
    if (!info.staff && allClients !== 'none') fail(400, 'Client accounts can only be given specific clients.');
    if (levelRank(allClients) > levelRank(info.cap) || grants.some((g) => levelRank(g.level) > levelRank(info.cap)))
      fail(
        400,
        `${info.label} accounts can have at most ${info.cap === 'read' ? 'read' : info.cap === 'edit' ? 'edit' : 'edit + password'} access.`,
      );
    const unique = new Map(grants.filter((g) => g.level !== 'none').map((g) => [g.clientId, g.level]));
    if (unique.size) {
      const found = await this.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(and(eq(schema.clients.orgId, actor.orgId), inArray(schema.clients.id, [...unique.keys()])));
      if (found.length !== unique.size) fail(400, 'Choose clients from this workspace.');
    }
    if (!info.admin && allClients === 'none' && !unique.size)
      fail(400, 'Give access to at least one client, or to all clients.');
    return {
      allClients: info.admin ? ('edit_passwords' as const) : allClients,
      grants: info.admin ? [] : [...unique].map(([clientId, level]) => ({ clientId, level })),
    };
  }

  async listUsers(actor: Actor): Promise<UserView[]> {
    this.requireAdmin(actor);
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.orgId, actor.orgId))
      .orderBy(sql`lower(${schema.users.name})`);
    return Promise.all(rows.map((u) => this.userView(u)));
  }

  async createUser(actor: Actor, input: unknown, ip: string): Promise<UserView> {
    this.requireAdmin(actor);
    const body = createUserSchema.parse(input);
    const access = await this.validateAccess(actor, body.role, body.allClients, body.grants);
    checkPassword(body.password, body.email);
    const passwordHash = await hashPassword(body.password);
    const user = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, body.email));
      if (existing) fail(409, 'An account with this email already exists.');
      const [created] = await tx
        .insert(schema.users)
        .values({
          orgId: actor.orgId,
          email: body.email,
          name: body.name,
          role: body.role,
          allClients: access.allClients,
          passwordHash,
          mustChangePassword: true,
        })
        .returning();
      if (access.grants.length)
        await tx.insert(schema.clientAccess).values(access.grants.map((g) => ({ ...g, userId: created!.id })));
      await tx.insert(schema.securityEvents).values({
        orgId: actor.orgId,
        userId: actor.id,
        actor: actor.name,
        action: 'User created',
        detail: `${body.email} · ${ROLE_INFO[body.role].label}`,
        ip,
      });
      return created!;
    });
    return this.userView(user);
  }

  async updateUser(actor: Actor, id: string, input: unknown, ip: string): Promise<UserView> {
    this.requireAdmin(actor);
    const user = await this.findUser(actor, id);
    const body = updateUserSchema.parse(input);
    if (user.role === 'owner' && actor.role !== 'owner') fail(403, 'Only an owner can change an owner.');
    const role = body.role ?? (user.role as Role);
    const disabled = body.disabled ?? user.disabled;
    const current = await this.userView(user);
    const access = userAccessSchema.parse({
      role,
      allClients: body.allClients ?? current.allClients,
      grants: body.grants ?? current.grants,
    });
    // An admin role implies full access; carry that over only when the new role is also admin.
    const allClients = ROLE_INFO[role].admin
      ? 'edit_passwords'
      : ROLE_INFO[user.role as Role].admin && body.allClients === undefined
        ? 'none'
        : access.allClients;
    const validated = await this.validateAccess(actor, role, allClients, access.grants);
    if (id === actor.id && (role !== actor.role || disabled))
      fail(400, 'You cannot change your own role or disable your own account.');
    return this.db
      .transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(727276)`);
        if (user.role === 'owner' && (role !== 'owner' || disabled)) {
          const [{ count }] = (
            await tx.execute(
              sql`select count(*)::int as count from users where org_id = ${actor.orgId} and role = 'owner' and not disabled`,
            )
          ).rows as [{ count: number }];
          if (count <= 1) fail(400, 'Keep at least one active owner.');
        }
        await tx
          .update(schema.users)
          .set({
            name: body.name ?? user.name,
            role,
            allClients: validated.allClients,
            disabled,
            updatedAt: new Date(),
          })
          .where(eq(schema.users.id, id));
        await tx.delete(schema.clientAccess).where(eq(schema.clientAccess.userId, id));
        if (validated.grants.length)
          await tx.insert(schema.clientAccess).values(validated.grants.map((g) => ({ ...g, userId: id })));
        // Access changes apply on the next request; disabling also ends every session.
        if (disabled) await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
        await tx.insert(schema.securityEvents).values({
          orgId: actor.orgId,
          userId: actor.id,
          actor: actor.name,
          action: 'User updated',
          detail: `${user.email} · ${ROLE_INFO[role].label}${disabled ? ' · disabled' : ''}`,
          ip,
        });
        const [updated] = await tx.select().from(schema.users).where(eq(schema.users.id, id));
        return updated!;
      })
      .then((u) => this.userView(u));
  }

  async resetUser(actor: Actor, id: string, input: unknown, ip: string): Promise<UserView> {
    this.requireAdmin(actor);
    const user = await this.findUser(actor, id);
    if (id === actor.id) fail(400, 'Use your account page to change your own password.');
    if (user.role === 'owner' && actor.role !== 'owner') fail(403, 'Only an owner can reset an owner.');
    const body = resetUserSchema.parse(input);
    checkPassword(body.password, user.email);
    const passwordHash = await hashPassword(body.password);
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({
          passwordHash,
          mustChangePassword: true,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: new Date(),
          ...(body.resetMfa
            ? { mfaSecret: null, mfaPending: null, mfaLastStep: 0, recoveryCodes: [], passkeyCount: 0 }
            : {}),
        })
        .where(eq(schema.users.id, id));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      if (body.resetMfa) {
        await tx.delete(schema.passkeys).where(eq(schema.passkeys.userId, id));
        await tx.delete(schema.trustedDevices).where(eq(schema.trustedDevices.userId, id));
      }
      await tx.insert(schema.securityEvents).values({
        orgId: actor.orgId,
        userId: actor.id,
        actor: actor.name,
        action: 'Password reset',
        detail: `${user.email}${body.resetMfa ? ' · MFA reset' : ''}`,
        ip,
      });
    });
    return this.userView(await this.findUser(actor, id));
  }

  async events(actor: Actor): Promise<SecurityEventView[]> {
    this.requireAdmin(actor);
    const rows = await this.db
      .select()
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.orgId, actor.orgId))
      .orderBy(desc(schema.securityEvents.id))
      .limit(200);
    return rows.map((e) => ({
      id: String(e.id),
      actor: e.actor,
      action: e.action,
      detail: e.detail,
      ip: e.ip,
      createdAt: e.createdAt.toISOString(),
    }));
  }
}

// Recovery codes: 10 characters from an unambiguous 31-letter alphabet (about 49 bits each), shown as xxxxx-xxxxx.
const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
export const hashRecoveryCode = (code: string) =>
  createHash('sha256')
    .update(`atlas-recovery|${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`)
    .digest('hex');

export const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export { isUuid };
