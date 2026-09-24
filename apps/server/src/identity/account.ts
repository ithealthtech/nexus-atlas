import { randomBytes } from 'node:crypto';
import { and, count, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { schema, type Database } from '@atlas/db';
import {
  forgotPasswordSchema,
  notificationPrefsSchema,
  passkeyNameSchema,
  resetPasswordSchema,
  type AccountSecurityView,
  type Actor,
} from '@atlas/shared';
import { fail } from '../errors.js';
import type { MailService } from '../services/mail.js';
import { checkPassword, hashPassword } from './passwords.js';
import {
  hashRecoveryCode,
  hasMfa,
  isUuid,
  newRecoveryCodes,
  tokenHash,
  type IdentityService,
  type SessionContext,
} from './service.js';

export const DEVICE_DAYS = 30;
const RESET_MS = 60 * 60_000;
const CHALLENGE_MS = 5 * 60_000;
type UserRow = typeof schema.users.$inferSelect;
interface RequestMeta {
  ip: string;
  userAgent?: string;
}
/** Where a WebAuthn ceremony happens: the relying party ID (host name) and the page origin. */
export interface RelyingParty {
  id: string;
  origin: string;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/**
 * Account security beyond passwords and TOTP: recovery codes, remembered devices, the session list,
 * passkeys (WebAuthn), and self-service password reset by email.
 */
export class AccountSecurity {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityService,
    private readonly mail: MailService,
    private readonly options: { publicOrigin: string; rpName: string },
  ) {}

  // ---------- overview ----------
  async overview(context: SessionContext): Promise<AccountSecurityView> {
    const { user } = context;
    const [fresh] = await this.db.select().from(schema.users).where(eq(schema.users.id, user.id));
    const [passkeys, sessions, devices] = await Promise.all([
      this.db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user.id)),
      this.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, user.id))
        .orderBy(sql`${schema.sessions.lastSeenAt} desc`),
      this.db
        .select()
        .from(schema.trustedDevices)
        .where(and(eq(schema.trustedDevices.userId, user.id), gt(schema.trustedDevices.expiresAt, new Date()))),
    ]);
    return {
      totp: !!fresh!.mfaSecret,
      recoveryCodesLeft: fresh!.recoveryCodes.length,
      passkeys: passkeys.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        current: s.tokenHash === context.hash,
        ip: s.ip,
        userAgent: s.userAgent,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
      })),
      devices: devices.map((d) => ({
        id: d.id,
        userAgent: d.userAgent,
        ip: d.ip,
        createdAt: d.createdAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
      })),
      notifyDigest: fresh!.notifyDigest,
    };
  }

  async setPreferences(context: SessionContext, input: unknown) {
    const body = notificationPrefsSchema.parse(input);
    await this.db
      .update(schema.users)
      .set({ notifyDigest: body.notifyDigest })
      .where(eq(schema.users.id, context.user.id));
  }

  // ---------- recovery codes ----------
  async useRecoveryCode(context: SessionContext, code: string, ip: string) {
    const { user } = context;
    if (!hasMfa(user)) fail(400, 'Two-step verification is not on for this account.');
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now())
      fail(429, 'Too many attempts. Try again in 15 minutes.');
    const hash = hashRecoveryCode(code);
    // Removing the code in the same statement that checks it makes each code single-use under concurrency.
    const used = await this.db
      .update(schema.users)
      .set({ recoveryCodes: sql`${schema.users.recoveryCodes} - ${hash}::text` })
      .where(and(eq(schema.users.id, user.id), sql`jsonb_exists(${schema.users.recoveryCodes}, ${hash}::text)`))
      .returning({ left: sql<number>`jsonb_array_length(${schema.users.recoveryCodes})` });
    if (!used.length) {
      await this.identity.recordFailure(user, 'Wrong recovery code', ip);
      fail(400, 'That recovery code is not valid or was already used.', 'mfa_invalid');
    }
    await this.identity.completeMfa(context, `Recovery code (${used[0]!.left} left)`, ip);
    return { left: used[0]!.left };
  }

  async regenerateRecoveryCodes(context: SessionContext, ip: string): Promise<{ recoveryCodes: string[] }> {
    this.identity.requireRecentAuth(context);
    if (!hasMfa(context.user)) fail(400, 'Turn on two-step verification first.');
    const codes = newRecoveryCodes();
    await this.db
      .update(schema.users)
      .set({ recoveryCodes: codes.map(hashRecoveryCode), updatedAt: new Date() })
      .where(eq(schema.users.id, context.user.id));
    await this.identity.event(context.user, 'Recovery codes replaced', 'Old codes no longer work', ip);
    return { recoveryCodes: codes };
  }

  // ---------- remembered devices ----------
  async rememberDevice(user: UserRow, meta: RequestMeta): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.delete(schema.trustedDevices).where(lt(schema.trustedDevices.expiresAt, new Date()));
    await this.db.insert(schema.trustedDevices).values({
      userId: user.id,
      tokenHash: tokenHash(token),
      userAgent: (meta.userAgent ?? '').slice(0, 200),
      ip: meta.ip.slice(0, 64),
      expiresAt: new Date(Date.now() + DEVICE_DAYS * 86_400_000),
    });
    await this.identity.event(user, 'Device remembered', `For ${DEVICE_DAYS} days`, meta.ip);
    return token;
  }

  /** Whether this browser's device token belongs to the user and is still valid. */
  async isTrusted(user: UserRow, token: string | undefined): Promise<boolean> {
    if (!token || token.length > 100) return false;
    const [row] = await this.db
      .select({ id: schema.trustedDevices.id })
      .from(schema.trustedDevices)
      .where(
        and(
          eq(schema.trustedDevices.tokenHash, tokenHash(token)),
          eq(schema.trustedDevices.userId, user.id),
          gt(schema.trustedDevices.expiresAt, new Date()),
        ),
      );
    return !!row;
  }

  async forgetDevice(context: SessionContext, id: string, ip: string) {
    if (!isUuid(id)) fail(404, 'Device not found.');
    const removed = await this.db
      .delete(schema.trustedDevices)
      .where(and(eq(schema.trustedDevices.id, id), eq(schema.trustedDevices.userId, context.user.id)))
      .returning({ id: schema.trustedDevices.id });
    if (!removed.length) fail(404, 'Device not found.');
    await this.identity.event(context.user, 'Remembered device removed', '', ip);
  }

  // ---------- sessions ----------
  async endSession(context: SessionContext, id: string, ip: string) {
    if (!isUuid(id)) fail(404, 'Session not found.');
    const removed = await this.db
      .delete(schema.sessions)
      .where(
        and(
          eq(schema.sessions.id, id),
          eq(schema.sessions.userId, context.user.id),
          ne(schema.sessions.tokenHash, context.hash),
        ),
      )
      .returning({ ip: schema.sessions.ip });
    if (!removed.length) fail(404, 'Session not found. To end this session, sign out.');
    await this.identity.event(context.user, 'Session ended remotely', `Session from ${removed[0]!.ip}`, ip);
  }

  async endOtherSessions(context: SessionContext, ip: string) {
    const removed = await this.db
      .delete(schema.sessions)
      .where(and(eq(schema.sessions.userId, context.user.id), ne(schema.sessions.tokenHash, context.hash)))
      .returning({ id: schema.sessions.id });
    await this.identity.event(context.user, 'Other sessions signed out', `${removed.length} sessions`, ip);
    return { ended: removed.length };
  }

  /** Administrators: end every session and forget every remembered device for a user. */
  async signOutUser(actor: Actor, id: string, ip: string) {
    if (!isUuid(id)) fail(404, 'User not found.');
    const [user] = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, id), eq(schema.users.orgId, actor.orgId)));
    if (!user) fail(404, 'User not found.');
    if (user!.role === 'owner' && actor.role !== 'owner') fail(403, 'Only an owner can sign out an owner.');
    await this.db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    await this.db.delete(schema.trustedDevices).where(eq(schema.trustedDevices.userId, id));
    await this.identity.event(actor, 'User signed out everywhere', user!.email, ip);
  }

  // ---------- password reset by email ----------
  async requestReset(input: unknown, meta: RequestMeta) {
    const { email } = forgotPasswordSchema.parse(input);
    const [row] = await this.db
      .select({ user: schema.users, org: schema.orgs })
      .from(schema.users)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.users.orgId))
      .where(eq(schema.users.email, email));
    // The response is the same whether or not the account exists.
    if (!row || row.user.disabled || !(await this.mail.enabled(row.org.id))) return;
    const { user, org } = row;
    const [recent] = await this.db
      .select({ n: count() })
      .from(schema.passwordResets)
      .where(
        and(
          eq(schema.passwordResets.userId, user.id),
          gt(schema.passwordResets.createdAt, new Date(Date.now() - RESET_MS)),
        ),
      );
    if ((recent?.n ?? 0) >= 3) return;
    const token = randomBytes(32).toString('base64url');
    await this.db.insert(schema.passwordResets).values({
      tokenHash: tokenHash(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + RESET_MS),
    });
    await this.identity.event(user, 'Password reset requested', 'Link emailed', meta.ip);
    await this.mail.send(org.id, org.name, {
      to: user.email,
      subject: 'Reset your MSP Atlas password',
      paragraphs: [
        `Hi ${user.name.split(' ')[0]},`,
        'Someone (hopefully you) asked to reset your MSP Atlas password. The link works once and expires in one hour.',
        'Two-step verification still applies when you sign in afterwards.',
        `If you didn't ask for this, you can ignore this email. The request came from ${meta.ip}.`,
      ],
      // The token is in the fragment so it never reaches server logs or Referer headers.
      action: { label: 'Choose a new password', url: `${this.options.publicOrigin}/reset-password#${token}` },
    });
  }

  async completeReset(input: unknown, ip: string) {
    const body = resetPasswordSchema.parse(input);
    const hash = tokenHash(body.token);
    const [row] = await this.db
      .select({ reset: schema.passwordResets, user: schema.users, org: schema.orgs })
      .from(schema.passwordResets)
      .innerJoin(schema.users, eq(schema.users.id, schema.passwordResets.userId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.users.orgId))
      .where(eq(schema.passwordResets.tokenHash, hash));
    if (!row || row.reset.usedAt || row.reset.expiresAt.getTime() < Date.now() || row.user.disabled)
      fail(400, 'This reset link has expired or was already used. Ask for a new one.', 'reset_invalid');
    const { user, org } = row!;
    checkPassword(body.password, user.email);
    const passwordHash = await hashPassword(body.password);
    await this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(schema.passwordResets)
        .set({ usedAt: new Date() })
        .where(and(eq(schema.passwordResets.tokenHash, hash), isNull(schema.passwordResets.usedAt)))
        .returning({ userId: schema.passwordResets.userId });
      if (!claimed.length) fail(400, 'This reset link was already used. Ask for a new one.', 'reset_invalid');
      // Any other outstanding links stop working too.
      await tx
        .update(schema.passwordResets)
        .set({ usedAt: new Date() })
        .where(and(eq(schema.passwordResets.userId, user.id), isNull(schema.passwordResets.usedAt)));
      await tx
        .update(schema.users)
        .set({ passwordHash, mustChangePassword: false, failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
      await tx.insert(schema.securityEvents).values({
        orgId: user.orgId,
        userId: user.id,
        actor: user.name,
        action: 'Password reset by email',
        detail: 'All sessions signed out',
        ip,
      });
    });
    await this.mail
      .send(org.id, org.name, {
        to: user.email,
        subject: 'Your MSP Atlas password was changed',
        paragraphs: [
          `Your password was just reset from ${ip}.`,
          'If this wasn’t you, contact your administrator right away.',
        ],
      })
      .catch(() => undefined);
  }

  // ---------- passkeys ----------
  private async credentials(userId: string) {
    return this.db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, userId));
  }

  async registrationOptions(context: SessionContext, rp: RelyingParty) {
    const { user } = context;
    // Adding a second factor when one already exists is sensitive; first-time enrollment is not.
    if (hasMfa(user)) this.identity.requireRecentAuth(context);
    const existing = await this.credentials(user.id);
    if (existing.length >= 10) fail(400, 'Remove a passkey before adding another (limit 10).');
    const options = await generateRegistrationOptions({
      rpName: this.options.rpName,
      rpID: rp.id,
      userID: new Uint8Array(Buffer.from(user.id)),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({
        id: c.id,
        transports: c.transports as AuthenticatorTransport[],
      })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    await this.db
      .update(schema.sessions)
      .set({ challenge: options.challenge })
      .where(eq(schema.sessions.tokenHash, context.hash));
    return options;
  }

  async register(context: SessionContext, input: unknown, rp: RelyingParty, ip: string) {
    const { user } = context;
    if (hasMfa(user)) this.identity.requireRecentAuth(context);
    const body = input as { name?: unknown; response?: RegistrationResponseJSON };
    const { name } = passkeyNameSchema.parse({ name: body?.name });
    const challenge = await this.takeSessionChallenge(context);
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
      });
    } catch {
      fail(400, 'The passkey could not be verified. Try again.');
    }
    if (!verification!.verified || !verification!.registrationInfo) fail(400, 'The passkey could not be verified.');
    const { credential } = verification!.registrationInfo!;
    const firstFactor = !hasMfa(user);
    const codes = user.recoveryCodes.length ? [] : newRecoveryCodes();
    await this.db.transaction(async (tx) => {
      const [taken] = await tx
        .select({ id: schema.passkeys.id })
        .from(schema.passkeys)
        .where(eq(schema.passkeys.id, credential.id));
      if (taken) fail(409, 'This passkey is already registered.');
      await tx.insert(schema.passkeys).values({
        id: credential.id,
        userId: user.id,
        name,
        publicKey: b64(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
      });
      await tx
        .update(schema.users)
        .set({
          passkeyCount: sql`${schema.users.passkeyCount} + 1`,
          ...(codes.length ? { recoveryCodes: codes.map(hashRecoveryCode) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, user.id));
      // Registering the first second factor completes this session's MFA, like confirming TOTP does.
      if (firstFactor)
        await tx.update(schema.sessions).set({ mfaVerified: true }).where(eq(schema.sessions.tokenHash, context.hash));
      await tx.insert(schema.securityEvents).values({
        orgId: user.orgId,
        userId: user.id,
        actor: user.name,
        action: 'Passkey added',
        detail: name,
        ip,
      });
    });
    return { recoveryCodes: codes };
  }

  async removePasskey(context: SessionContext, id: string, ip: string) {
    this.identity.requireRecentAuth(context);
    const { user } = context;
    const [key] = await this.db
      .select()
      .from(schema.passkeys)
      .where(and(eq(schema.passkeys.id, id), eq(schema.passkeys.userId, user.id)));
    if (!key) fail(404, 'Passkey not found.');
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.passkeys).where(eq(schema.passkeys.id, id));
      const [updated] = await tx
        .update(schema.users)
        .set({ passkeyCount: sql`greatest(${schema.users.passkeyCount} - 1, 0)`, updatedAt: new Date() })
        .where(eq(schema.users.id, user.id))
        .returning();
      if (!hasMfa(updated!))
        await tx.update(schema.users).set({ recoveryCodes: [] }).where(eq(schema.users.id, user.id));
      await tx.insert(schema.securityEvents).values({
        orgId: user.orgId,
        userId: user.id,
        actor: user.name,
        action: 'Passkey removed',
        detail: key!.name,
        ip,
      });
    });
  }

  private async takeSessionChallenge(context: SessionContext): Promise<string> {
    // Read and clear in one statement so a challenge can be answered only once.
    const result = await this.db.execute(sql`
      update sessions s set challenge = null
      from (select token_hash, challenge from sessions where token_hash = ${context.hash} for update) old
      where s.token_hash = old.token_hash
      returning old.challenge`);
    const challenge = (result.rows[0] as { challenge: string | null } | undefined)?.challenge;
    if (!challenge) fail(400, 'Start again: the passkey request expired.');
    return challenge!;
  }

  /** Options for using a passkey as the second step, after the password. */
  async secondFactorOptions(context: SessionContext, rp: RelyingParty) {
    const creds = await this.credentials(context.user.id);
    if (!creds.length) fail(400, 'This account has no passkeys.');
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports as AuthenticatorTransport[] })),
      userVerification: 'preferred',
    });
    await this.db
      .update(schema.sessions)
      .set({ challenge: options.challenge })
      .where(eq(schema.sessions.tokenHash, context.hash));
    return options;
  }

  async secondFactor(context: SessionContext, input: unknown, rp: RelyingParty, ip: string) {
    const response = (input as { response?: AuthenticationResponseJSON })?.response;
    const challenge = await this.takeSessionChallenge(context);
    const key = await this.verifyAssertion(response, challenge, rp, false);
    if (key.userId !== context.user.id) {
      await this.identity.recordFailure(context.user, 'Wrong passkey', ip);
      fail(400, 'That passkey belongs to a different account.', 'mfa_invalid');
    }
    await this.identity.completeMfa(context, `Password and passkey (${key.name})`, ip);
  }

  /** Options for signing in with a passkey alone (it must verify the user with a PIN or biometrics). */
  async passwordlessOptions(rp: RelyingParty) {
    const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' });
    await this.db.delete(schema.authChallenges).where(lt(schema.authChallenges.expiresAt, new Date()));
    const [row] = await this.db
      .insert(schema.authChallenges)
      .values({ challenge: options.challenge, expiresAt: new Date(Date.now() + CHALLENGE_MS) })
      .returning({ id: schema.authChallenges.id });
    return { challengeId: row!.id, options };
  }

  async passwordless(input: unknown, rp: RelyingParty): Promise<UserRow> {
    const body = input as { challengeId?: unknown; response?: AuthenticationResponseJSON };
    if (!isUuid(String(body?.challengeId ?? ''))) fail(400, 'Start again: the passkey request expired.');
    const [row] = await this.db
      .delete(schema.authChallenges)
      .where(eq(schema.authChallenges.id, String(body.challengeId)))
      .returning();
    if (!row || row.expiresAt.getTime() < Date.now()) fail(400, 'Start again: the passkey request expired.');
    const key = await this.verifyAssertion(body.response, row!.challenge, rp, true);
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, key.userId));
    if (!user || user.disabled) fail(401, 'This passkey cannot sign in.');
    if (user!.lockedUntil && user!.lockedUntil.getTime() > Date.now())
      fail(429, 'Too many attempts. Try again in 15 minutes.');
    return user!;
  }

  private async verifyAssertion(
    response: AuthenticationResponseJSON | undefined,
    challenge: string,
    rp: RelyingParty,
    requireUserVerification: boolean,
  ) {
    if (!response || typeof response.id !== 'string') fail(400, 'The passkey response is missing.');
    const [key] = await this.db.select().from(schema.passkeys).where(eq(schema.passkeys.id, response!.id));
    if (!key) fail(400, 'This passkey is not registered with MSP Atlas.', 'mfa_invalid');
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: response!,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification,
        credential: {
          id: key!.id,
          publicKey: new Uint8Array(Buffer.from(key!.publicKey, 'base64url')),
          counter: key!.counter,
          transports: key!.transports as AuthenticatorTransport[],
        },
      });
    } catch {
      fail(400, 'The passkey could not be verified. Try again.', 'mfa_invalid');
    }
    if (!result!.verified) fail(400, 'The passkey could not be verified. Try again.', 'mfa_invalid');
    await this.db
      .update(schema.passkeys)
      .set({ counter: result!.authenticationInfo.newCounter, lastUsedAt: new Date() })
      .where(eq(schema.passkeys.id, key!.id));
    return key!;
  }
}
