import { createHash, createPublicKey, randomBytes, randomInt, verify, type KeyObject } from 'node:crypto';
import { and, asc, eq, gt, isNull, lt } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  DEVICE_KIND_LABELS,
  ROLE_INFO,
  devicePairSchema,
  deviceSigningString,
  type Actor,
  type DeviceKind,
  type DevicePairingView,
  type DeviceSessionInfo,
  type Role,
} from '@atlas/shared';
import { HttpError, fail } from '../errors.js';
import { actorFor, isUuid, tokenHash, type IdentityService, type SessionContext } from './service.js';

export const DEVICE_LIMITS = {
  // How long a sign-in request waits for approval.
  pairingMs: 10 * 60_000,
  // A device session ends after a week unused, and a month after sign-in whatever happens.
  idleMs: 7 * 86_400_000,
  absoluteMs: 30 * 86_400_000,
  perUser: 10,
  // Signed requests must be this fresh; each nonce works once within it.
  skewMs: 2 * 60_000,
  perMinute: 240,
};
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const TOKEN = /^AtlasDevice (atlasd_[A-Za-z0-9_-]{43})$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

type DeviceSessionRow = typeof schema.deviceSessions.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

export interface DeviceContext {
  device: DeviceSessionRow;
  user: UserRow;
  actor: Actor;
  organization: { id: string; name: string };
}

/** What a signed request carries, taken from the HTTP request. */
export interface SignedRequest {
  method: string;
  /** Path and query exactly as sent. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** The request body as sent ('' when there is none). */
  body: string;
  ip: string;
  userAgent: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const header = (req: SignedRequest, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** Reads a device key, accepting only an uncompressed or compressed P-256 key in SPKI form. */
function deviceKey(publicKey: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
  } catch {
    throw new HttpError(400, 'The device key could not be read.');
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    fail(400, 'The device key must be a P-256 key.');
  return key;
}

const clockError = () =>
  new HttpError(401, 'The device clock is out of step with Atlas. Check the time on this device.', 'device_clock');

/**
 * Sign-in for apps on a person's own device, such as the browser extension (and later the Windows app).
 *
 * 1. The device makes a P-256 key pair it can't export and asks to sign in with the public half. It gets a short code.
 * 2. The person opens Atlas in the browser, checks the code matches, and approves. That needs a recent password.
 * 3. The device collects its session token, signing the request with its key.
 * 4. Every later request carries the token and is signed with the key over the method, path, time, a one-time
 *    nonce, and a hash of the body. A copied token without the key is useless, and a captured request can't be
 *    replayed.
 *
 * Device sessions act as their person, reach only the device routes, and end on their own after a week unused or a
 * month in total. The person or an administrator can sign them out, and anything that signs someone out everywhere
 * (a password change or reset, disabling, a lockout) signs out their devices too.
 */
export class DeviceService {
  private readonly nonces = new Map<string, number>();
  private readonly hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly db: Database,
    private readonly identity: IdentityService,
  ) {}

  // ---------- pairing ----------
  /** A device asks to sign in. Needs no account; the caller rate-limits it. */
  async pair(input: unknown, meta: { ip: string; userAgent: string }) {
    const body = devicePairSchema.parse(input);
    deviceKey(body.publicKey);
    await this.db.delete(schema.devicePairings).where(lt(schema.devicePairings.expiresAt, new Date()));
    const expiresAt = new Date(Date.now() + DEVICE_LIMITS.pairingMs);
    // A clash with a live code is vanishingly unlikely; try again rather than fail.
    for (let attempt = 0; ; attempt++) {
      const raw = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
      const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
      const [row] = await this.db
        .insert(schema.devicePairings)
        .values({
          code,
          kind: body.kind,
          name: body.name,
          publicKey: body.publicKey,
          ip: meta.ip.slice(0, 64),
          userAgent: meta.userAgent.slice(0, 200),
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.devicePairings.id });
      if (row) return { id: row.id, code, expiresAt: expiresAt.toISOString() };
      if (attempt > 5) fail(503, 'Try again.');
    }
  }

  private requireStaff(actor: Actor) {
    if (!ROLE_INFO[actor.role].staff) fail(403, 'Only staff accounts can use the browser extension.');
  }

  private async pendingPairing(code: string) {
    const normalized = code.trim().toUpperCase();
    const [row] = CODE.test(normalized)
      ? await this.db
          .select()
          .from(schema.devicePairings)
          .where(
            and(
              eq(schema.devicePairings.code, normalized),
              isNull(schema.devicePairings.approvedAt),
              gt(schema.devicePairings.expiresAt, new Date()),
            ),
          )
      : [];
    if (!row) fail(404, 'This sign-in request has expired or was already answered. Start again from the extension.');
    return row!;
  }

  /** The request behind a code, for the person to check before approving. */
  async pairing(actor: Actor, code: string): Promise<DevicePairingView> {
    this.requireStaff(actor);
    const row = await this.pendingPairing(code);
    return {
      code: row.code,
      kind: row.kind as DeviceKind,
      name: row.name,
      ip: row.ip,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async approve(context: SessionContext, code: string, ip: string) {
    this.requireStaff(context.actor);
    this.identity.requireRecentAuth(context);
    const row = await this.pendingPairing(code);
    const [approved] = await this.db
      .update(schema.devicePairings)
      .set({ userId: context.user.id, approvedAt: new Date() })
      .where(and(eq(schema.devicePairings.id, row.id), isNull(schema.devicePairings.approvedAt)))
      .returning({ id: schema.devicePairings.id });
    if (!approved) fail(404, 'This sign-in request was already answered.');
    await this.identity.event(
      context.user,
      'Device sign-in approved',
      `${DEVICE_KIND_LABELS[row.kind as DeviceKind]}: ${row.name} · requested from ${row.ip || 'an unknown address'}`,
      ip,
    );
  }

  async deny(actor: Actor, code: string) {
    this.requireStaff(actor);
    const row = await this.pendingPairing(code);
    await this.db.delete(schema.devicePairings).where(eq(schema.devicePairings.id, row.id));
  }

  /**
   * The device collects its session once approved, signing with the key it asked with. Until then it hears
   * "pending"; a denied or expired request is not found.
   */
  async collect(
    pairingId: string,
    req: SignedRequest,
  ): Promise<{ status: 'pending' } | { status: 'approved'; token: string; session: DeviceSessionInfo }> {
    const [pairing] = isUuid(pairingId)
      ? await this.db
          .select()
          .from(schema.devicePairings)
          .where(and(eq(schema.devicePairings.id, pairingId), gt(schema.devicePairings.expiresAt, new Date())))
      : [];
    if (!pairing) fail(404, 'This sign-in request has expired. Start again.');
    this.verify(pairing!.publicKey, `pair:${pairing!.id}`, req);
    if (!pairing!.approvedAt || !pairing!.userId) return { status: 'pending' };

    const token = `atlasd_${randomBytes(32).toString('base64url')}`;
    const now = Date.now();
    const created = await this.db.transaction(async (tx) => {
      // Collecting is once only: whoever deletes the request first gets the session.
      const claimed = await tx
        .delete(schema.devicePairings)
        .where(eq(schema.devicePairings.id, pairing!.id))
        .returning({ id: schema.devicePairings.id });
      if (!claimed.length) return null;
      const [row] = await tx
        .select({ user: schema.users, org: schema.orgs })
        .from(schema.users)
        .innerJoin(schema.orgs, eq(schema.orgs.id, schema.users.orgId))
        .where(eq(schema.users.id, pairing!.userId!));
      if (!row || row.user.disabled || !ROLE_INFO[row.user.role as Role].staff) return null;
      // Keep each person to a handful of devices: the least recently used go first.
      const existing = await tx
        .select({ id: schema.deviceSessions.id })
        .from(schema.deviceSessions)
        .where(eq(schema.deviceSessions.userId, row.user.id))
        .orderBy(asc(schema.deviceSessions.lastSeenAt));
      const excess = existing.length - (DEVICE_LIMITS.perUser - 1);
      for (const old of existing.slice(0, Math.max(0, excess)))
        await tx.delete(schema.deviceSessions).where(eq(schema.deviceSessions.id, old.id));
      const [device] = await tx
        .insert(schema.deviceSessions)
        .values({
          orgId: row.user.orgId,
          userId: row.user.id,
          kind: pairing!.kind,
          name: pairing!.name,
          publicKey: pairing!.publicKey,
          tokenHash: tokenHash(token),
          ip: pairing!.ip,
          userAgent: pairing!.userAgent,
          lastSeenIp: req.ip.slice(0, 64),
          expiresAt: new Date(now + DEVICE_LIMITS.absoluteMs),
        })
        .returning();
      await tx.insert(schema.securityEvents).values({
        orgId: row.user.orgId,
        userId: row.user.id,
        actor: row.user.name,
        action: 'Signed in',
        detail: `${DEVICE_KIND_LABELS[pairing!.kind as DeviceKind]}: ${pairing!.name}`,
        ip: req.ip.slice(0, 64),
      });
      return { device: device!, user: row.user, org: row.org };
    });
    if (!created) fail(404, 'This sign-in request has expired. Start again.');
    return { status: 'approved', token, session: this.info(created!.device, created!.user, created!.org) };
  }

  // ---------- signed requests ----------
  /**
   * Checks the request is signed by this key and hasn't been seen before. `bind` ties the nonce to the session or
   * pairing, so a nonce used against one can't be replayed against another.
   */
  private verify(publicKey: string, bind: string, req: SignedRequest) {
    const timestamp = header(req, 'x-atlas-timestamp') ?? '';
    const nonce = header(req, 'x-atlas-nonce') ?? '';
    const signature = header(req, 'x-atlas-signature') ?? '';
    if (!/^\d{13}$/.test(timestamp) || !NONCE.test(nonce) || !SIGNATURE.test(signature))
      fail(401, 'Sign this request with the device key.', 'device_signature');
    const now = Date.now();
    if (Math.abs(now - Number(timestamp)) > DEVICE_LIMITS.skewMs) throw clockError();
    const signed = deviceSigningString({
      method: req.method,
      path: req.url,
      timestamp,
      nonce,
      bodySha256: sha256(req.body),
    });
    const ok = verify(
      'sha256',
      Buffer.from(signed),
      { key: deviceKey(publicKey), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    if (!ok) fail(401, 'The request signature is not valid.', 'device_signature');
    const seen = `${bind}|${nonce}`;
    if (this.nonces.size > 50_000) for (const [k, until] of this.nonces) if (until < now) this.nonces.delete(k);
    if ((this.nonces.get(seen) ?? 0) > now) fail(401, 'This request was already used.', 'device_signature');
    this.nonces.set(seen, now + 2 * DEVICE_LIMITS.skewMs);
  }

  /** Resolves a signed device request, or throws 401 with code "device_session" when it must sign in again. */
  async authenticate(req: SignedRequest): Promise<DeviceContext> {
    const token = TOKEN.exec(header(req, 'authorization') ?? '')?.[1];
    if (!token) fail(401, 'Sign in to Atlas from the extension.', 'device_session');
    const hash = tokenHash(token!);
    const [row] = await this.db
      .select({ device: schema.deviceSessions, user: schema.users, org: schema.orgs })
      .from(schema.deviceSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.deviceSessions.userId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.users.orgId))
      .where(eq(schema.deviceSessions.tokenHash, hash));
    const now = Date.now();
    if (
      !row ||
      row.user.disabled ||
      !ROLE_INFO[row.user.role as Role].staff ||
      row.device.expiresAt.getTime() < now ||
      row.device.lastSeenAt.getTime() < now - DEVICE_LIMITS.idleMs
    ) {
      if (row) await this.db.delete(schema.deviceSessions).where(eq(schema.deviceSessions.id, row.device.id));
      fail(401, 'Your Atlas sign-in has ended. Sign in again from the extension.', 'device_session');
    }
    const { device, user, org } = row!;
    this.verify(device.publicKey, device.id, req);

    const bucket = this.hits.get(device.id);
    if (!bucket || bucket.reset < now) this.hits.set(device.id, { count: 1, reset: now + 60_000 });
    else if (++bucket.count > DEVICE_LIMITS.perMinute) fail(429, 'Too many requests. Wait a minute and try again.');

    if (now - device.lastSeenAt.getTime() > 60_000)
      await this.db
        .update(schema.deviceSessions)
        .set({ lastSeenAt: new Date(now), lastSeenIp: req.ip.slice(0, 64) })
        .where(eq(schema.deviceSessions.id, device.id));
    const actor = actorFor(user);
    return {
      device,
      user,
      // Vault entries name the device as well as the person using it.
      actor: {
        ...actor,
        name: `${actor.name} (${DEVICE_KIND_LABELS[device.kind as DeviceKind]}: ${device.name})`.slice(0, 120),
      },
      organization: { id: org.id, name: org.name },
    };
  }

  info(device: DeviceSessionRow, user: UserRow, org: { name: string }): DeviceSessionInfo {
    return {
      user: { name: user.name, email: user.email },
      organization: { name: org.name },
      device: { id: device.id, name: device.name, expiresAt: device.expiresAt.toISOString() },
    };
  }

  // ---------- signing out ----------
  async signOut(context: DeviceContext, ip: string) {
    await this.db.delete(schema.deviceSessions).where(eq(schema.deviceSessions.id, context.device.id));
    await this.identity.event(
      context.user,
      'Signed out',
      `${DEVICE_KIND_LABELS[context.device.kind as DeviceKind]}: ${context.device.name}`,
      ip,
    );
  }

  /** The person signs out one of their devices from their account page. */
  async remove(context: SessionContext, id: string, ip: string) {
    const [removed] = isUuid(id)
      ? await this.db
          .delete(schema.deviceSessions)
          .where(and(eq(schema.deviceSessions.id, id), eq(schema.deviceSessions.userId, context.user.id)))
          .returning()
      : [];
    if (!removed) fail(404, 'That app is already signed out.');
    await this.identity.event(
      context.user,
      'App signed out remotely',
      `${DEVICE_KIND_LABELS[removed!.kind as DeviceKind]}: ${removed!.name}`,
      ip,
    );
  }
}
