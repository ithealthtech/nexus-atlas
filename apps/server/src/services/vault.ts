import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import {
  ROLE_INFO,
  createPasswordSchema,
  passwordAccessSchema,
  passwordStrength,
  revealSchema,
  shareSchema,
  updatePasswordSchema,
  type PasswordHistoryView,
  type PasswordKind,
  type PasswordView,
  type RevealResult,
  type ShareView,
  type VaultAuditView,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { VaultKeys } from '../crypto/vault-keys.js';
import { totp } from '../identity/totp.js';
import { recordActivity } from './activity.js';
import { isUuid, type Scope } from './scope.js';

type Row = typeof schema.passwords.$inferSelect;
const editor = alias(schema.users, 'pw_editor');
const aad = (id: string, field: 'secret' | 'notes' | 'totp') => `pw|${id}|${field}`;
const historyAad = (id: string) => `pwh|${id}`;
const notFound = () => new HttpError(404, 'Password not found.');
const conflict = () =>
  new HttpError(409, 'Someone else changed this password entry. Reload before saving.', 'conflict');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const REVEAL_ACTIONS = { secret: 'Revealed password', notes: 'Viewed notes', totp: 'Viewed one-time code' } as const;

export class VaultService {
  constructor(private readonly keys: VaultKeys) {}

  // ---------- access ----------
  private isAdmin(scope: Scope) {
    return ROLE_INFO[scope.actor.role].admin;
  }

  /** Clients where the actor may use the vault ("edit + passwords" access). */
  private async vaultClients(scope: Scope): Promise<string[]> {
    return [...(await scope.levels())].filter(([, level]) => level === 'edit_passwords').map(([id]) => id);
  }

  /** Restricted items are visible to admins and to the people listed on them. */
  private async allowedRestricted(scope: Scope, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await scope.db
      .select({ id: schema.passwordAccess.passwordId })
      .from(schema.passwordAccess)
      .where(and(inArray(schema.passwordAccess.passwordId, ids), eq(schema.passwordAccess.userId, scope.actor.id)));
    return new Set(rows.map((r) => r.id));
  }

  private async load(scope: Scope, id: string) {
    const [row] = isUuid(id)
      ? await scope.db
          .select({
            p: schema.passwords,
            clientName: schema.clients.name,
            requireReason: schema.clients.requireRevealReason,
            editor: editor.name,
          })
          .from(schema.passwords)
          .innerJoin(schema.clients, eq(schema.clients.id, schema.passwords.clientId))
          .leftJoin(editor, eq(editor.id, schema.passwords.updatedBy))
          .where(and(eq(schema.passwords.id, id), eq(schema.passwords.orgId, scope.actor.orgId)))
      : [];
    // Anyone without vault access to the client, or outside a restricted item's list, gets the same 404.
    if (!row || (await scope.level(row.p.clientId)) !== 'edit_passwords') throw notFound();
    if (row.p.restricted && !this.isAdmin(scope) && !(await this.allowedRestricted(scope, [id])).has(id))
      throw notFound();
    return row;
  }

  /** Summary for links and search results, or null when the actor can't use this item. */
  async ref(scope: Scope, id: string) {
    try {
      const row = await this.load(scope, id);
      return {
        clientId: row.p.clientId,
        clientName: row.clientName,
        title: row.p.name,
        subtitle: row.p.kind === 'bitlocker' ? 'BitLocker key' : 'Password',
        archived: row.p.archived,
      };
    } catch {
      return null;
    }
  }

  private async reuseCounts(scope: Scope, rows: Row[]) {
    const prints = [...new Set(rows.map((r) => r.fingerprint))];
    if (!prints.length) return new Map<string, number>();
    const counts = await scope.db
      .select({ fingerprint: schema.passwords.fingerprint, n: count() })
      .from(schema.passwords)
      .where(
        and(
          eq(schema.passwords.orgId, scope.actor.orgId),
          eq(schema.passwords.archived, false),
          inArray(schema.passwords.fingerprint, prints),
        ),
      )
      .groupBy(schema.passwords.fingerprint);
    return new Map(counts.map((c) => [c.fingerprint, Number(c.n)]));
  }

  private view(
    r: { p: Row; clientName: string; requireReason: boolean; editor: string | null },
    reuse: Map<string, number>,
  ): PasswordView {
    const due = r.p.rotationDays
      ? new Date(r.p.changedAt.getTime() + r.p.rotationDays * 86_400_000).toISOString().slice(0, 10)
      : null;
    return {
      id: r.p.id,
      clientId: r.p.clientId,
      clientName: r.clientName,
      kind: r.p.kind as PasswordKind,
      name: r.p.name,
      username: r.p.username,
      url: r.p.url,
      hasNotes: !!r.p.notes,
      hasTotp: !!r.p.totp,
      strength: r.p.strength,
      reused: Math.max(0, (reuse.get(r.p.fingerprint) ?? 1) - 1),
      rotationDays: r.p.rotationDays,
      changedAt: r.p.changedAt.toISOString(),
      rotationDue: due,
      restricted: r.p.restricted,
      version: r.p.version,
      archived: r.p.archived,
      updatedAt: r.p.updatedAt.toISOString(),
      updatedByName: r.editor,
      requireReason: r.requireReason,
    };
  }

  private async audit(scope: Scope, row: Pick<Row, 'id' | 'clientId' | 'name'>, action: string, reason = '', ip = '') {
    await scope.db.insert(schema.vaultAudit).values({
      orgId: scope.actor.orgId,
      clientId: row.clientId,
      passwordId: row.id,
      passwordName: row.name,
      actorId: scope.actor.id,
      actorName: scope.actor.name,
      action,
      reason,
      ip: ip.slice(0, 64),
    });
  }

  // ---------- list and read ----------
  async list(scope: Scope, filter: { clientId?: string; archived?: boolean }): Promise<PasswordView[]> {
    let ids = await this.vaultClients(scope);
    if (filter.clientId) {
      const level = await scope.require(filter.clientId, 'read', 'Client');
      if (level !== 'edit_passwords') throw new HttpError(403, 'You don’t have password access for this client.');
      ids = [filter.clientId];
    }
    if (!ids.length) return [];
    const conditions: SQL[] = [
      eq(schema.passwords.orgId, scope.actor.orgId),
      inArray(schema.passwords.clientId, ids),
      eq(schema.passwords.archived, !!filter.archived),
    ];
    const rows = await scope.db
      .select({
        p: schema.passwords,
        clientName: schema.clients.name,
        requireReason: schema.clients.requireRevealReason,
        editor: editor.name,
      })
      .from(schema.passwords)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.passwords.clientId))
      .leftJoin(editor, eq(editor.id, schema.passwords.updatedBy))
      .where(and(...conditions))
      .orderBy(asc(sql`lower(${schema.passwords.name})`))
      .limit(5000);
    const allowed = this.isAdmin(scope)
      ? null
      : await this.allowedRestricted(
          scope,
          rows.filter((r) => r.p.restricted).map((r) => r.p.id),
        );
    const visible = rows.filter((r) => !r.p.restricted || !allowed || allowed.has(r.p.id));
    const reuse = await this.reuseCounts(
      scope,
      visible.map((r) => r.p),
    );
    return visible.map((r) => this.view(r, reuse));
  }

  async get(scope: Scope, id: string): Promise<PasswordView> {
    const row = await this.load(scope, id);
    return this.view(row, await this.reuseCounts(scope, [row.p]));
  }

  // ---------- write ----------
  async create(scope: Scope, clientId: string, input: unknown, ip: string): Promise<PasswordView> {
    const level = await scope.require(clientId, 'read', 'Client');
    if (level !== 'edit_passwords') throw new HttpError(403, 'You don’t have password access for this client.');
    const body = createPasswordSchema.parse(input);
    if (body.restricted && !this.isAdmin(scope))
      throw new HttpError(403, 'Only administrators can restrict a password to specific people.');
    const id = randomUUID();
    const org = scope.actor.orgId;
    const secret = body.kind === 'bitlocker' ? body.secret.trim() : body.secret;
    const values = {
      id,
      orgId: org,
      clientId,
      kind: body.kind,
      name: body.name,
      username: body.username,
      url: body.url,
      secret: await this.keys.seal(org, secret, aad(id, 'secret')),
      notes: body.notes ? await this.keys.seal(org, body.notes, aad(id, 'notes')) : null,
      totp: body.totp ? await this.keys.seal(org, body.totp, aad(id, 'totp')) : null,
      fingerprint: await this.keys.fingerprint(org, secret),
      strength: body.kind === 'bitlocker' ? 4 : passwordStrength(secret),
      rotationDays: body.rotationDays,
      restricted: body.restricted,
      createdBy: scope.actor.id,
      updatedBy: scope.actor.id,
    };
    await scope.db.transaction(async (tx) => {
      await tx.insert(schema.passwords).values(values);
      await tx.insert(schema.vaultAudit).values({
        orgId: org,
        clientId,
        passwordId: id,
        passwordName: body.name,
        actorId: scope.actor.id,
        actorName: scope.actor.name,
        action: 'Created',
        ip,
      });
      await recordActivity(tx, scope.actor, {
        clientId,
        action: 'Added a password',
        entityType: 'password',
        entityId: id,
        title: body.name,
      });
    });
    return this.get(scope, id);
  }

  async update(scope: Scope, id: string, input: unknown, ip: string): Promise<PasswordView> {
    const { p } = await this.load(scope, id);
    const body = updatePasswordSchema.parse(input);
    if (body.version !== p.version) throw conflict();
    if (body.restricted !== undefined && body.restricted !== p.restricted && !this.isAdmin(scope))
      throw new HttpError(403, 'Only administrators can change who may use a password.');
    const org = scope.actor.orgId;
    const secret = body.secret !== undefined ? (p.kind === 'bitlocker' ? body.secret.trim() : body.secret) : undefined;
    if (secret !== undefined && p.kind === 'bitlocker' && !/^\d{6}(-\d{6}){7}$/.test(secret))
      throw new HttpError(400, 'A BitLocker recovery key is 8 groups of 6 digits, separated by dashes.');
    const changedSecret = secret !== undefined && secret !== (await this.keys.open(org, p.secret, aad(id, 'secret')));
    const set: Partial<typeof schema.passwords.$inferInsert> = {
      name: body.name,
      username: body.username,
      url: body.url,
      rotationDays: body.rotationDays,
      restricted: body.restricted,
      version: p.version + 1,
      updatedBy: scope.actor.id,
      updatedAt: new Date(),
    };
    if (body.notes !== undefined)
      set.notes = body.notes ? await this.keys.seal(org, body.notes, aad(id, 'notes')) : null;
    if (body.totp !== undefined) set.totp = body.totp ? await this.keys.seal(org, body.totp, aad(id, 'totp')) : null;
    if (changedSecret) {
      set.secret = await this.keys.seal(org, secret!, aad(id, 'secret'));
      set.fingerprint = await this.keys.fingerprint(org, secret!);
      set.strength = p.kind === 'bitlocker' ? 4 : passwordStrength(secret!);
      set.changedAt = new Date();
    }
    const historyId = randomUUID();
    // The previous secret is re-sealed for its history row, bound to that row.
    const previous = changedSecret
      ? await this.keys.seal(org, await this.keys.open(org, p.secret, aad(id, 'secret')), historyAad(historyId))
      : null;
    await scope.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.passwords)
        .set(set)
        .where(and(eq(schema.passwords.id, id), eq(schema.passwords.version, p.version)))
        .returning({ id: schema.passwords.id });
      if (!updated.length) throw conflict();
      if (previous)
        await tx.insert(schema.passwordHistory).values({
          id: historyId,
          passwordId: id,
          secret: previous,
          changedBy: scope.actor.id,
          changedByName: scope.actor.name,
        });
      await tx.insert(schema.vaultAudit).values({
        orgId: org,
        clientId: p.clientId,
        passwordId: id,
        passwordName: body.name ?? p.name,
        actorId: scope.actor.id,
        actorName: scope.actor.name,
        action: changedSecret ? 'Changed password' : 'Edited details',
        ip,
      });
      await recordActivity(tx, scope.actor, {
        clientId: p.clientId,
        action: changedSecret ? 'Changed the password for' : 'Updated',
        entityType: 'password',
        entityId: id,
        title: body.name ?? p.name,
      });
    });
    return this.get(scope, id);
  }

  async setArchived(scope: Scope, id: string, archived: boolean, ip: string): Promise<PasswordView> {
    const { p } = await this.load(scope, id);
    await scope.db
      .update(schema.passwords)
      .set({ archived, updatedBy: scope.actor.id, updatedAt: new Date() })
      .where(eq(schema.passwords.id, id));
    await this.audit(scope, p, archived ? 'Archived' : 'Restored', '', ip);
    await recordActivity(scope.db, scope.actor, {
      clientId: p.clientId,
      action: archived ? 'Archived' : 'Restored',
      entityType: 'password',
      entityId: id,
      title: p.name,
    });
    return this.get(scope, id);
  }

  // ---------- reveal ----------
  async reveal(scope: Scope, id: string, input: unknown, ip: string): Promise<RevealResult> {
    const { p, requireReason } = await this.load(scope, id);
    const body = revealSchema.parse(input ?? {});
    if (requireReason && !body.reason)
      throw new HttpError(400, 'This client requires a reason before revealing passwords.', 'reason_required');
    const stored = body.field === 'secret' ? p.secret : body.field === 'notes' ? p.notes : p.totp;
    if (!stored) throw new HttpError(404, 'Nothing is stored in that field.');
    const value = await this.keys.open(scope.actor.orgId, stored, aad(id, body.field));
    await this.audit(
      scope,
      p,
      body.copy && body.field === 'secret' ? 'Copied password' : REVEAL_ACTIONS[body.field],
      body.reason,
      ip,
    );
    if (body.field === 'totp') return { value: totp(value), expiresIn: 30 - (Math.floor(Date.now() / 1000) % 30) };
    return { value };
  }

  async history(scope: Scope, id: string): Promise<PasswordHistoryView[]> {
    await this.load(scope, id);
    const rows = await scope.db
      .select()
      .from(schema.passwordHistory)
      .where(eq(schema.passwordHistory.passwordId, id))
      .orderBy(desc(schema.passwordHistory.createdAt));
    return rows.map((r) => ({ id: r.id, changedByName: r.changedByName, createdAt: r.createdAt.toISOString() }));
  }

  async revealHistory(scope: Scope, id: string, historyId: string, input: unknown, ip: string): Promise<RevealResult> {
    const { p, requireReason } = await this.load(scope, id);
    const body = revealSchema.parse(input ?? {});
    if (requireReason && !body.reason)
      throw new HttpError(400, 'This client requires a reason before revealing passwords.', 'reason_required');
    const [row] = isUuid(historyId)
      ? await scope.db
          .select()
          .from(schema.passwordHistory)
          .where(and(eq(schema.passwordHistory.id, historyId), eq(schema.passwordHistory.passwordId, id)))
      : [];
    if (!row) throw new HttpError(404, 'That previous password was not found.');
    await this.audit(scope, p, 'Revealed a previous password', body.reason, ip);
    return { value: await this.keys.open(scope.actor.orgId, row.secret, historyAad(historyId)) };
  }

  // ---------- restriction list ----------
  async access(scope: Scope, id: string): Promise<{ userIds: string[] }> {
    await this.load(scope, id);
    const rows = await scope.db
      .select({ userId: schema.passwordAccess.userId })
      .from(schema.passwordAccess)
      .where(eq(schema.passwordAccess.passwordId, id));
    return { userIds: rows.map((r) => r.userId) };
  }

  async setAccess(scope: Scope, id: string, input: unknown, ip: string): Promise<{ userIds: string[] }> {
    if (!this.isAdmin(scope)) throw new HttpError(403, 'Only administrators can change who may use a password.');
    const { p } = await this.load(scope, id);
    const { userIds } = passwordAccessSchema.parse(input);
    const unique = [...new Set(userIds)];
    if (unique.length) {
      const found = await scope.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.orgId, scope.actor.orgId), inArray(schema.users.id, unique)));
      if (found.length !== unique.length) throw new HttpError(400, 'Choose people from this workspace.');
    }
    await scope.db.transaction(async (tx) => {
      await tx.delete(schema.passwordAccess).where(eq(schema.passwordAccess.passwordId, id));
      if (unique.length)
        await tx.insert(schema.passwordAccess).values(unique.map((userId) => ({ passwordId: id, userId })));
    });
    await this.audit(scope, p, 'Changed who may use it', `${unique.length} people`, ip);
    return { userIds: unique };
  }

  // ---------- audit ----------
  async auditFor(scope: Scope, id: string): Promise<VaultAuditView[]> {
    await this.load(scope, id);
    return this.auditQuery(scope, [eq(schema.vaultAudit.passwordId, id)]);
  }

  async auditAll(scope: Scope): Promise<VaultAuditView[]> {
    if (!this.isAdmin(scope)) throw new HttpError(403, 'Administrator access is required.');
    return this.auditQuery(scope, []);
  }

  private async auditQuery(scope: Scope, extra: SQL[]): Promise<VaultAuditView[]> {
    const rows = await scope.db
      .select({ a: schema.vaultAudit, clientName: schema.clients.name })
      .from(schema.vaultAudit)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.vaultAudit.clientId))
      .where(and(eq(schema.vaultAudit.orgId, scope.actor.orgId), ...extra))
      .orderBy(desc(schema.vaultAudit.id))
      .limit(300);
    return rows.map(({ a, clientName }) => ({
      id: String(a.id),
      passwordId: a.passwordId,
      passwordName: a.passwordName,
      clientName,
      actorName: a.actorName,
      action: a.action,
      reason: a.reason,
      ip: a.ip,
      createdAt: a.createdAt.toISOString(),
    }));
  }

  /** Items whose rotation date has passed or falls within `withinDays`. */
  async rotationDue(scope: Scope, withinDays = 14): Promise<PasswordView[]> {
    const cutoff = new Date(Date.now() + withinDays * 86_400_000).toISOString().slice(0, 10);
    return (await this.list(scope, {}))
      .filter((p) => p.rotationDue && p.rotationDue <= cutoff)
      .sort((a, b) => a.rotationDue!.localeCompare(b.rotationDue!));
  }

  // ---------- share links ----------
  async createShare(
    scope: Scope,
    id: string,
    input: unknown,
    ip: string,
  ): Promise<{ id: string; token: string; expiresAt: string }> {
    const { p, requireReason } = await this.load(scope, id);
    const body = shareSchema.parse(input);
    if (requireReason && !body.reason)
      throw new HttpError(400, 'This client requires a reason before sharing passwords.', 'reason_required');
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + body.expiresHours * 3_600_000);
    const [row] = await scope.db
      .insert(schema.shareLinks)
      .values({
        orgId: scope.actor.orgId,
        passwordId: id,
        tokenHash: hashToken(token),
        ciphertext: body.ciphertext,
        maxViews: body.maxViews,
        expiresAt,
        createdBy: scope.actor.id,
        createdByName: scope.actor.name,
      })
      .returning({ id: schema.shareLinks.id });
    await this.audit(
      scope,
      p,
      `Created a share link (${body.maxViews} view${body.maxViews === 1 ? '' : 's'}, ${body.expiresHours} h)`,
      body.reason,
      ip,
    );
    return { id: row!.id, token, expiresAt: expiresAt.toISOString() };
  }

  async shares(scope: Scope, id: string): Promise<ShareView[]> {
    await this.load(scope, id);
    const rows = await scope.db
      .select()
      .from(schema.shareLinks)
      .where(eq(schema.shareLinks.passwordId, id))
      .orderBy(desc(schema.shareLinks.createdAt));
    return rows.map((s) => ({
      id: s.id,
      maxViews: s.maxViews,
      views: s.views,
      expiresAt: s.expiresAt.toISOString(),
      revoked: s.revoked,
      createdByName: s.createdByName,
      createdAt: s.createdAt.toISOString(),
    }));
  }

  async revokeShare(scope: Scope, id: string, shareId: string, ip: string) {
    const { p } = await this.load(scope, id);
    const updated = isUuid(shareId)
      ? await scope.db
          .update(schema.shareLinks)
          .set({ revoked: true })
          .where(and(eq(schema.shareLinks.id, shareId), eq(schema.shareLinks.passwordId, id)))
          .returning({ id: schema.shareLinks.id })
      : [];
    if (!updated.length) throw new HttpError(404, 'Share link not found.');
    await this.audit(scope, p, 'Revoked a share link', '', ip);
  }
}

/**
 * Opens a share link without signing in. Each successful open uses one view; the update is atomic,
 * so a one-view link can't be opened twice even by simultaneous requests.
 */
export async function openShare(
  db: Scope['db'],
  token: string,
  ip: string,
): Promise<{ ciphertext: string; remainingViews: number }> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new HttpError(404, 'This link is invalid or has expired.');
  const [row] = await db
    .update(schema.shareLinks)
    .set({ views: sql`${schema.shareLinks.views} + 1` })
    .where(
      and(
        eq(schema.shareLinks.tokenHash, hashToken(token)),
        eq(schema.shareLinks.revoked, false),
        sql`${schema.shareLinks.views} < ${schema.shareLinks.maxViews}`,
        sql`${schema.shareLinks.expiresAt} > now()`,
      ),
    )
    .returning();
  if (!row) throw new HttpError(404, 'This link is invalid, has expired, or has already been used.');
  const [item] = await db
    .select({ name: schema.passwords.name, clientId: schema.passwords.clientId })
    .from(schema.passwords)
    .where(eq(schema.passwords.id, row.passwordId));
  await db.insert(schema.vaultAudit).values({
    orgId: row.orgId,
    clientId: item?.clientId ?? null,
    passwordId: row.passwordId,
    passwordName: item?.name ?? 'Deleted password',
    actorName: 'Share link recipient',
    action: `Opened a share link (view ${row.views} of ${row.maxViews})`,
    ip: ip.slice(0, 64),
  });
  return { ciphertext: row.ciphertext, remainingViews: row.maxViews - row.views };
}
