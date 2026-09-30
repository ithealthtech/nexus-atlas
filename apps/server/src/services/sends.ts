import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, desc, eq, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { MultipartFile, MultipartValue } from '@fastify/multipart';
import { schema, type Database } from '@atlas/db';
import {
  ROLE_INFO,
  sendFileSchema,
  sendTextSchema,
  type SendCreated,
  type SendKind,
  type SendView,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { isUuid, type Scope } from './scope.js';
import { TooLargeError, readLimited, type FileStorage } from './storage.js';

type Row = typeof schema.sends.$inferSelect;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
// Browser encryption adds a 12-byte IV and a 16-byte tag to the file.
const OVERHEAD = 64;
const gone = () => new HttpError(404, 'This Send is invalid, has expired, or has already been used.');
const openable = (s: Pick<Row, 'revoked' | 'views' | 'maxViews' | 'expiresAt'>) =>
  !s.revoked && s.views < s.maxViews && s.expiresAt.getTime() > Date.now();

export type OpenedSend =
  | { kind: 'text'; ciphertext: string; remainingViews: number }
  | { kind: 'file'; meta: string; data: Buffer; remainingViews: number };

/**
 * Send: one-time text and files for someone without an account, in the same model as password share links. The
 * browser encrypts the content and keeps the key in the link's #fragment, so the server only ever holds ciphertext,
 * and deletes even that once the Send can't be opened any more.
 */
export class SendService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly db: Database,
    private readonly storage: FileStorage,
    // The largest file, before encryption.
    private readonly maxBytes: number,
  ) {}

  /** Clears used-up, revoked, and expired Sends every hour (and on each list and create). */
  start() {
    this.timer = setInterval(() => void this.purge().catch(() => undefined), 3_600_000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }

  private requireStaff(scope: Scope) {
    if (!ROLE_INFO[scope.actor.role].staff) throw new HttpError(403, 'Client accounts can’t create Sends.');
  }

  private async event(orgId: string, action: string, detail: string, ip: string, actor?: Scope['actor']) {
    await this.db.insert(schema.securityEvents).values({
      orgId,
      userId: actor?.id ?? null,
      actor: actor?.name ?? 'Send recipient',
      action,
      detail,
      ip: ip.slice(0, 64),
    });
  }

  private async insert(
    scope: Scope,
    values: { kind: SendKind; name: string; maxViews: number; expiresHours: number; ciphertext: string },
    file: { key: string; size: number } | null,
    ip: string,
  ): Promise<SendCreated> {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + values.expiresHours * 3_600_000);
    const [row] = await this.db
      .insert(schema.sends)
      .values({
        orgId: scope.actor.orgId,
        kind: values.kind,
        name: values.name,
        tokenHash: hashToken(token),
        ciphertext: values.ciphertext,
        storageKey: file?.key ?? null,
        size: file?.size ?? values.ciphertext.length,
        maxViews: values.maxViews,
        expiresAt,
        createdBy: scope.actor.id,
        createdByName: scope.actor.name,
      })
      .returning({ id: schema.sends.id });
    await this.event(
      scope.actor.orgId,
      'Created a Send',
      `${values.name} (${values.kind}, ${values.maxViews} view${values.maxViews === 1 ? '' : 's'}, ${values.expiresHours} h)`,
      ip,
      scope.actor,
    );
    return { id: row!.id, token, expiresAt: expiresAt.toISOString() };
  }

  async createText(scope: Scope, input: unknown, ip: string): Promise<SendCreated> {
    this.requireStaff(scope);
    const body = sendTextSchema.parse(input);
    await this.purge(scope.actor.orgId);
    return this.insert(scope, { ...body, kind: 'text' }, null, ip);
  }

  /** A file Send: the form's fields (name, encrypted file name, limits) come before the encrypted file. */
  async createFile(scope: Scope, file: MultipartFile | undefined, ip: string): Promise<SendCreated> {
    this.requireStaff(scope);
    if (!file) throw new HttpError(400, 'Choose a file to send.');
    const field = (name: string) => (file.fields[name] as MultipartValue | undefined)?.value;
    const body = sendFileSchema.parse({
      name: field('name'),
      meta: field('meta'),
      maxViews: field('maxViews'),
      expiresHours: field('expiresHours'),
    });
    const tooLarge = () => new HttpError(413, `Files can be up to ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    let data: Buffer;
    try {
      data = await readLimited(file.file, this.maxBytes + OVERHEAD);
    } catch (error) {
      if (error instanceof TooLargeError) throw tooLarge();
      throw error;
    }
    if (file.file.truncated) throw tooLarge();
    if (data.length <= 28) throw new HttpError(400, 'That file is empty.');
    await this.purge(scope.actor.orgId);
    const stored = await this.storage.put(scope.actor.orgId, Readable.from([data]), data.length);
    try {
      return await this.insert(
        scope,
        {
          name: body.name,
          maxViews: body.maxViews,
          expiresHours: body.expiresHours,
          ciphertext: body.meta,
          kind: 'file',
        },
        { key: stored.key, size: data.length },
        ip,
      );
    } catch (error) {
      await this.storage.remove(stored.key);
      throw error;
    }
  }

  /** The person's own Sends; administrators can list everyone's. */
  async list(scope: Scope, all = false): Promise<SendView[]> {
    this.requireStaff(scope);
    if (all && !ROLE_INFO[scope.actor.role].admin) throw new HttpError(403, 'Administrator access is required.');
    await this.purge(scope.actor.orgId);
    const where: SQL[] = [eq(schema.sends.orgId, scope.actor.orgId)];
    if (!all) where.push(eq(schema.sends.createdBy, scope.actor.id));
    const rows = await this.db
      .select()
      .from(schema.sends)
      .where(and(...where))
      .orderBy(desc(schema.sends.createdAt))
      .limit(300);
    return rows.map((s) => ({
      id: s.id,
      kind: s.kind as SendKind,
      name: s.name,
      size: s.size,
      maxViews: s.maxViews,
      views: s.views,
      expiresAt: s.expiresAt.toISOString(),
      revoked: s.revoked,
      active: openable(s),
      createdByName: s.createdByName,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  /** Revokes a Send and deletes its content. Its sender and administrators can. */
  async revoke(scope: Scope, id: string, ip: string) {
    this.requireStaff(scope);
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.sends)
          .where(and(eq(schema.sends.id, id), eq(schema.sends.orgId, scope.actor.orgId)))
      : [];
    if (!row || (row.createdBy !== scope.actor.id && !ROLE_INFO[scope.actor.role].admin))
      throw new HttpError(404, 'Send not found.');
    await this.db
      .update(schema.sends)
      .set({ revoked: true, ciphertext: null, storageKey: null })
      .where(eq(schema.sends.id, row.id));
    if (row.storageKey) await this.storage.remove(row.storageKey).catch(() => undefined);
    await this.event(scope.actor.orgId, 'Revoked a Send', row.name, ip, scope.actor);
  }

  /**
   * Opens a Send without signing in. Each open uses one view; the update is atomic, so a one-view Send can't be
   * opened twice even by simultaneous requests. The last view deletes the content.
   */
  async open(token: string, ip: string): Promise<OpenedSend> {
    if (!TOKEN.test(token)) throw gone();
    const s = schema.sends;
    const [row] = await this.db
      .update(s)
      .set({ views: sql`${s.views} + 1` })
      .where(
        and(
          eq(s.tokenHash, hashToken(token)),
          eq(s.revoked, false),
          isNotNull(s.ciphertext),
          sql`${s.views} < ${s.maxViews}`,
          sql`${s.expiresAt} > now()`,
        ),
      )
      .returning();
    if (!row) throw gone();
    let data: Buffer | undefined;
    if (row.kind === 'file') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of await this.storage.get(row.storageKey!)) chunks.push(chunk as Buffer);
        data = Buffer.concat(chunks);
      } catch {
        throw gone();
      }
    }
    const remainingViews = row.maxViews - row.views;
    if (remainingViews === 0) await this.clear(row);
    await this.event(row.orgId, 'Opened a Send', `${row.name} (view ${row.views} of ${row.maxViews})`, ip);
    return row.kind === 'file'
      ? { kind: 'file', meta: row.ciphertext!, data: data!, remainingViews }
      : { kind: 'text', ciphertext: row.ciphertext!, remainingViews };
  }

  private async clear(row: Pick<Row, 'id' | 'storageKey'>) {
    await this.db.update(schema.sends).set({ ciphertext: null, storageKey: null }).where(eq(schema.sends.id, row.id));
    if (row.storageKey) await this.storage.remove(row.storageKey).catch(() => undefined);
  }

  /** Deletes the content of Sends that can no longer be opened. The row stays, for the sender's list. */
  async purge(orgId?: string) {
    const s = schema.sends;
    const rows = await this.db
      .select({ id: s.id, storageKey: s.storageKey })
      .from(s)
      .where(
        and(
          orgId ? eq(s.orgId, orgId) : undefined,
          or(isNotNull(s.ciphertext), isNotNull(s.storageKey)),
          or(eq(s.revoked, true), sql`${s.views} >= ${s.maxViews}`, lte(s.expiresAt, sql`now()`)),
        ),
      )
      .limit(500);
    for (const row of rows) await this.clear(row);
    return rows.length;
  }
}
