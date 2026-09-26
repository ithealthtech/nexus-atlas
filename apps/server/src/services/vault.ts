import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import {
  ROLE_INFO,
  createPasswordSchema,
  guessPasswordCategory,
  passwordAccessSchema,
  passwordFolderSchema,
  passwordStrength,
  revealSchema,
  shareSchema,
  updatePasswordSchema,
  bulkPasswordSchema,
  type BulkPasswordResult,
  type PasswordCategory,
  type PasswordFolderView,
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
import { allowedRestricted } from './items.js';

type Row = typeof schema.passwords.$inferSelect;
const editor = alias(schema.users, 'pw_editor');
const aad = (id: string, field: 'secret' | 'notes' | 'totp' | `custom:${string}`) => `pw|${id}|${field}`;
type StoredField = { id: string; label: string; secret: boolean; value: string };
const historyAad = (id: string) => `pwh|${id}`;
const notFound = () => new HttpError(404, 'Password not found.');
const conflict = () =>
  new HttpError(409, 'Someone else changed this password entry. Reload before saving.', 'conflict');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const REVEAL_ACTIONS = {
  secret: 'Revealed password',
  notes: 'Viewed notes',
  totp: 'Viewed one-time code',
  custom: 'Viewed custom field',
} as const;
// Audit actions that count as "using" a password, for Recently used (plus creating a share link).
const USED_ACTIONS = ['Revealed password', 'Copied password', 'Viewed one-time code', 'Viewed notes'] as const;
type Personal = { favorites: Set<string>; lastUsed: Map<string, string> };

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

  /** Restricted items are visible to admins and to the people and groups listed on them. */
  private async allowedRestricted(scope: Scope, ids: string[]): Promise<Set<string>> {
    return allowedRestricted(scope, ids);
  }

  /** Client accounts (the portal) see only items shared with the client, read-only. */
  private isPortal(scope: Scope) {
    return !ROLE_INFO[scope.actor.role].staff;
  }

  private async load(scope: Scope, id: string, portalOk = false) {
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
    if (!row) throw notFound();
    if (this.isPortal(scope)) {
      if (!portalOk || !row.p.clientVisible || row.p.restricted || (await scope.level(row.p.clientId)) === 'none')
        throw notFound();
      return row;
    }
    if ((await scope.level(row.p.clientId)) !== 'edit_passwords') throw notFound();
    if (row.p.restricted && !this.isAdmin(scope) && !(await this.allowedRestricted(scope, [id])).has(id))
      throw notFound();
    return row;
  }

  /** Summary for links and search results, or null when the actor can't use this item. */
  async ref(scope: Scope, id: string) {
    try {
      const row = await this.load(scope, id, true);
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

  /** The non-archived assets each password is linked to (links are stored in either direction). */
  private async linkedAssets(scope: Scope, ids: string[]) {
    const out = new Map<string, { id: string; name: string }[]>();
    if (!ids.length) return out;
    const r = schema.relations;
    const rows = await scope.db
      .select({
        passwordId: sql<string>`case when ${r.aType} = 'password' then ${r.aId} else ${r.bId} end`,
        id: schema.assets.id,
        name: schema.assets.name,
      })
      .from(r)
      .innerJoin(
        schema.assets,
        sql`${schema.assets.id} = case when ${r.aType} = 'asset' then ${r.aId} else ${r.bId} end`,
      )
      .where(
        and(
          eq(r.orgId, scope.actor.orgId),
          eq(schema.assets.archived, false),
          sql`((${r.aType} = 'password' and ${r.bType} = 'asset' and ${inArray(r.aId, ids)})
            or (${r.bType} = 'password' and ${r.aType} = 'asset' and ${inArray(r.bId, ids)}))`,
        ),
      )
      .orderBy(asc(sql`lower(${schema.assets.name})`));
    for (const row of rows)
      out.set(row.passwordId, [...(out.get(row.passwordId) ?? []), { id: row.id, name: row.name }]);
    return out;
  }

  private view(
    r: { p: Row; clientName: string; requireReason: boolean; editor: string | null },
    reuse: Map<string, number>,
    links: Map<string, { id: string; name: string }[]> = new Map(),
    folders: Map<string, string> = new Map(),
    mine: Personal = { favorites: new Set(), lastUsed: new Map() },
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
      clientVisible: r.p.clientVisible,
      version: r.p.version,
      archived: r.p.archived,
      updatedAt: r.p.updatedAt.toISOString(),
      updatedByName: r.editor,
      requireReason: r.requireReason,
      category: (r.p.category as PasswordCategory | null) ?? guessPasswordCategory(r.p.name, r.p.username, r.p.url),
      categoryGuessed: !r.p.category,
      linkedAssets: links.get(r.p.id) ?? [],
      customFields: r.p.customFields.map((f) => ({
        id: f.id,
        label: f.label,
        secret: f.secret,
        value: f.secret ? null : f.value,
      })),
      folderId: r.p.folderId,
      folderName: r.p.folderId ? (folders.get(r.p.folderId) ?? null) : null,
      favorite: mine.favorites.has(r.p.id),
      lastUsedAt: mine.lastUsed.get(r.p.id) ?? null,
    };
  }

  /** The viewer's own favorites and when they last used each password (revealed, copied, or shared). */
  private async personal(scope: Scope, ids: string[]): Promise<Personal> {
    if (!ids.length) return { favorites: new Set(), lastUsed: new Map() };
    const favorites = await scope.db
      .select({ id: schema.passwordFavorites.passwordId })
      .from(schema.passwordFavorites)
      .where(
        and(eq(schema.passwordFavorites.userId, scope.actor.id), inArray(schema.passwordFavorites.passwordId, ids)),
      );
    const a = schema.vaultAudit;
    const used = await scope.db
      .select({ id: a.passwordId, at: sql<Date>`max(${a.createdAt})` })
      .from(a)
      .where(
        and(
          eq(a.orgId, scope.actor.orgId),
          eq(a.actorId, scope.actor.id),
          inArray(a.passwordId, ids),
          sql`(${inArray(a.action, [...USED_ACTIONS])} or ${a.action} like 'Created a share link%')`,
        ),
      )
      .groupBy(a.passwordId);
    return {
      favorites: new Set(favorites.map((f) => f.id)),
      lastUsed: new Map(used.map((u) => [u.id!, new Date(u.at).toISOString()])),
    };
  }

  async setFavorite(scope: Scope, id: string, favorite: boolean): Promise<PasswordView> {
    const { p } = await this.load(scope, id);
    if (favorite)
      await scope.db
        .insert(schema.passwordFavorites)
        .values({ userId: scope.actor.id, passwordId: p.id })
        .onConflictDoNothing();
    else
      await scope.db
        .delete(schema.passwordFavorites)
        .where(and(eq(schema.passwordFavorites.userId, scope.actor.id), eq(schema.passwordFavorites.passwordId, p.id)));
    return this.get(scope, id);
  }

  /** Folder names for the folders these passwords are in. */
  private async folderNames(scope: Scope, rows: Row[]) {
    const ids = [...new Set(rows.map((r) => r.folderId).filter((f): f is string => !!f))];
    if (!ids.length) return new Map<string, string>();
    const found = await scope.db
      .select({ id: schema.passwordFolders.id, name: schema.passwordFolders.name })
      .from(schema.passwordFolders)
      .where(and(eq(schema.passwordFolders.orgId, scope.actor.orgId), inArray(schema.passwordFolders.id, ids)));
    return new Map(found.map((f) => [f.id, f.name]));
  }

  /** A password's folder must belong to the same client. */
  private async checkFolder(scope: Scope, clientId: string, folderId: string | null | undefined) {
    if (!folderId) return;
    const [folder] = await scope.db
      .select({ id: schema.passwordFolders.id })
      .from(schema.passwordFolders)
      .where(
        and(
          eq(schema.passwordFolders.id, folderId),
          eq(schema.passwordFolders.clientId, clientId),
          eq(schema.passwordFolders.orgId, scope.actor.orgId),
        ),
      );
    if (!folder)
      throw new HttpError(400, 'Choose a folder from this client.', undefined, {
        folderId: 'Choose a folder from this client.',
      });
  }

  // ---------- folders ----------
  private async requireVaultClient(scope: Scope, clientId: string) {
    const level = await scope.require(clientId, 'read', 'Client');
    if (level !== 'edit_passwords') throw new HttpError(403, 'You don’t have password access for this client.');
  }

  async folders(scope: Scope, clientId: string): Promise<PasswordFolderView[]> {
    await this.requireVaultClient(scope, clientId);
    const f = schema.passwordFolders;
    const rows = await scope.db
      .select({ id: f.id, clientId: f.clientId, name: f.name })
      .from(f)
      .where(and(eq(f.orgId, scope.actor.orgId), eq(f.clientId, clientId)))
      .orderBy(asc(sql`lower(${f.name})`));
    // Active passwords in each folder.
    const counts = await scope.db
      .select({ folderId: schema.passwords.folderId, n: count() })
      .from(schema.passwords)
      .where(
        and(
          eq(schema.passwords.orgId, scope.actor.orgId),
          eq(schema.passwords.clientId, clientId),
          eq(schema.passwords.archived, false),
        ),
      )
      .groupBy(schema.passwords.folderId);
    const byFolder = new Map(counts.map((c) => [c.folderId, Number(c.n)]));
    return rows.map((r) => ({ ...r, count: byFolder.get(r.id) ?? 0 }));
  }

  private async folderRow(scope: Scope, folderId: string) {
    const [row] = isUuid(folderId)
      ? await scope.db
          .select()
          .from(schema.passwordFolders)
          .where(and(eq(schema.passwordFolders.id, folderId), eq(schema.passwordFolders.orgId, scope.actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'Folder not found.');
    await this.requireVaultClient(scope, row.clientId);
    return row;
  }

  private duplicate(error: unknown): never {
    // Unique violation; the pg error may be wrapped by drizzle.
    const e = error as { code?: string; cause?: { code?: string } };
    if (e.code === '23505' || e.cause?.code === '23505')
      throw new HttpError(409, 'This client already has a folder with that name.', undefined, {
        name: 'This client already has a folder with that name.',
      });
    throw error;
  }

  async createFolder(scope: Scope, clientId: string, input: unknown): Promise<PasswordFolderView> {
    await this.requireVaultClient(scope, clientId);
    const { name } = passwordFolderSchema.parse(input);
    const [row] = await scope.db
      .insert(schema.passwordFolders)
      .values({ orgId: scope.actor.orgId, clientId, name })
      .returning()
      .catch((e) => this.duplicate(e));
    return { id: row!.id, clientId, name, count: 0 };
  }

  async renameFolder(scope: Scope, folderId: string, input: unknown): Promise<PasswordFolderView> {
    const row = await this.folderRow(scope, folderId);
    const { name } = passwordFolderSchema.parse(input);
    await scope.db
      .update(schema.passwordFolders)
      .set({ name })
      .where(eq(schema.passwordFolders.id, row.id))
      .catch((e) => this.duplicate(e));
    return (await this.folders(scope, row.clientId)).find((f) => f.id === row.id)!;
  }

  /** Deleting a folder unfiles its passwords; nothing else is removed. */
  async deleteFolder(scope: Scope, folderId: string) {
    const row = await this.folderRow(scope, folderId);
    await scope.db.delete(schema.passwordFolders).where(eq(schema.passwordFolders.id, row.id));
    return { ok: true };
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
    if (this.isPortal(scope)) return this.portalList(scope, filter.clientId);
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
    const links = await this.linkedAssets(
      scope,
      visible.map((r) => r.p.id),
    );
    const folders = await this.folderNames(
      scope,
      visible.map((r) => r.p),
    );
    const mine = await this.personal(
      scope,
      visible.map((r) => r.p.id),
    );
    return visible.map((r) => this.view(r, reuse, links, folders, mine));
  }

  /** Portal: passwords shared with the client accounts of clients the actor can read. */
  private async portalList(scope: Scope, clientId?: string): Promise<PasswordView[]> {
    const ids = clientId ? [clientId] : await scope.readableClientIds();
    if (clientId) await scope.require(clientId, 'read', 'Client');
    if (!ids.length) return [];
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
      .where(
        and(
          eq(schema.passwords.orgId, scope.actor.orgId),
          inArray(schema.passwords.clientId, ids),
          eq(schema.passwords.archived, false),
          eq(schema.passwords.clientVisible, true),
          eq(schema.passwords.restricted, false),
        ),
      )
      .orderBy(asc(sql`lower(${schema.passwords.name})`));
    const folders = await this.folderNames(
      scope,
      rows.map((r) => r.p),
    );
    return rows.map((r) => this.view(r, new Map(), new Map(), folders));
  }

  async get(scope: Scope, id: string): Promise<PasswordView> {
    const row = await this.load(scope, id, true);
    const folders = await this.folderNames(scope, [row.p]);
    if (this.isPortal(scope)) return this.view(row, new Map(), new Map(), folders);
    return this.view(
      row,
      await this.reuseCounts(scope, [row.p]),
      await this.linkedAssets(scope, [row.p.id]),
      folders,
      await this.personal(scope, [row.p.id]),
    );
  }

  // ---------- write ----------
  async create(scope: Scope, clientId: string, input: unknown, ip: string): Promise<PasswordView> {
    const level = await scope.require(clientId, 'read', 'Client');
    if (level !== 'edit_passwords') throw new HttpError(403, 'You don’t have password access for this client.');
    const body = createPasswordSchema.parse(input);
    if (body.restricted && !this.isAdmin(scope))
      throw new HttpError(403, 'Only administrators can restrict a password to specific people.');
    await this.checkFolder(scope, clientId, body.folderId);
    const id = randomUUID();
    const org = scope.actor.orgId;
    const secret = body.kind === 'bitlocker' ? body.secret.trim() : body.secret;
    const values = {
      id,
      orgId: org,
      clientId,
      kind: body.kind,
      category: body.kind === 'login' ? body.category : null,
      folderId: body.folderId,
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
      clientVisible: body.clientVisible,
      customFields: await this.customFields(org, id, body.customFields, []),
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
    await this.checkFolder(scope, p.clientId, body.folderId);
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
      clientVisible: body.clientVisible,
      category: p.kind === 'login' ? body.category : undefined,
      folderId: body.folderId,
      version: p.version + 1,
      updatedBy: scope.actor.id,
      updatedAt: new Date(),
    };
    if (body.notes !== undefined)
      set.notes = body.notes ? await this.keys.seal(org, body.notes, aad(id, 'notes')) : null;
    if (body.customFields !== undefined)
      set.customFields = await this.customFields(org, id, body.customFields, p.customFields);
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

  /** Applies one change to many passwords. Each goes through the normal single-item path, so
   *  permissions, audit and activity are identical; failures are reported, not fatal. */
  async bulk(scope: Scope, input: unknown, ip: string): Promise<BulkPasswordResult> {
    const body = bulkPasswordSchema.parse(input);
    const result: BulkPasswordResult = { updated: 0, failed: [] };
    for (const id of new Set(body.ids)) {
      let name: string | null = null;
      try {
        const { p } = await this.load(scope, id);
        name = p.name;
        if (body.action === 'archive' || body.action === 'restore') {
          const archived = body.action === 'archive';
          if (p.archived !== archived) await this.setArchived(scope, id, archived, ip);
        } else if (body.action === 'rotation') {
          if (p.rotationDays !== body.rotationDays)
            await this.update(scope, id, { rotationDays: body.rotationDays, version: p.version }, ip);
        } else if (body.action === 'clientVisible') {
          if (p.clientVisible !== body.clientVisible)
            await this.update(scope, id, { clientVisible: body.clientVisible, version: p.version }, ip);
        } else if (body.action === 'category') {
          if (p.kind !== 'login') throw new HttpError(400, 'Only logins have a category.');
          if (p.category !== body.category)
            await this.update(scope, id, { category: body.category, version: p.version }, ip);
        }
        result.updated++;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        result.failed.push({ id, name: e.status === 404 ? null : name, error: e.message });
      }
    }
    return result;
  }

  // ---------- reveal ----------
  /** Builds the stored list: secret values are sealed to the password and field; a secret sent
   *  without a value keeps the one already stored under that id. */
  private async customFields(
    org: string,
    passwordId: string,
    input: { id?: string; label: string; secret: boolean; value?: string }[],
    existing: StoredField[],
  ): Promise<StoredField[]> {
    const out: StoredField[] = [];
    for (const f of input) {
      const before = f.id ? existing.find((e) => e.id === f.id) : undefined;
      const id = before?.id ?? randomUUID();
      if (f.value === undefined) {
        if (!before || before.secret !== f.secret)
          throw new HttpError(400, `Enter a value for “${f.label}”.`, undefined, { customFields: 'Enter a value.' });
        out.push({ ...before, label: f.label });
      } else if (f.secret) {
        out.push({
          id,
          label: f.label,
          secret: true,
          value: await this.keys.seal(org, f.value, aad(passwordId, `custom:${id}`)),
        });
      } else out.push({ id, label: f.label, secret: false, value: f.value });
    }
    return out;
  }

  async reveal(scope: Scope, id: string, input: unknown, ip: string): Promise<RevealResult> {
    const { p, requireReason } = await this.load(scope, id, true);
    const body = revealSchema.parse(input ?? {});
    if (requireReason && !body.reason)
      throw new HttpError(400, 'This client requires a reason before revealing passwords.', 'reason_required');
    const custom = body.field === 'custom' ? p.customFields.find((f) => f.id === body.fieldId) : undefined;
    if (body.field === 'custom' && !custom) throw new HttpError(404, 'That field was not found.');
    const stored = custom
      ? custom.value
      : body.field === 'secret'
        ? p.secret
        : body.field === 'notes'
          ? p.notes
          : p.totp;
    if (!stored) throw new HttpError(404, 'Nothing is stored in that field.');
    const value =
      custom && !custom.secret
        ? custom.value
        : await this.keys.open(
            scope.actor.orgId,
            stored,
            aad(id, custom ? `custom:${custom.id}` : (body.field as 'secret' | 'notes' | 'totp')),
          );
    const action = custom
      ? `${body.copy ? 'Copied' : 'Viewed'} custom field “${custom.label}”`
      : body.copy && body.field === 'secret'
        ? 'Copied password'
        : REVEAL_ACTIONS[body.field];
    await this.audit(scope, p, action, body.reason, ip);
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
  async access(scope: Scope, id: string): Promise<{ userIds: string[]; groupIds: string[] }> {
    await this.load(scope, id);
    const [users, groups] = await Promise.all([
      scope.db
        .select({ userId: schema.passwordAccess.userId })
        .from(schema.passwordAccess)
        .where(eq(schema.passwordAccess.passwordId, id)),
      scope.db
        .select({ groupId: schema.passwordGroupAccess.groupId })
        .from(schema.passwordGroupAccess)
        .where(eq(schema.passwordGroupAccess.passwordId, id)),
    ]);
    return { userIds: users.map((r) => r.userId), groupIds: groups.map((r) => r.groupId) };
  }

  async setAccess(
    scope: Scope,
    id: string,
    input: unknown,
    ip: string,
  ): Promise<{ userIds: string[]; groupIds: string[] }> {
    if (!this.isAdmin(scope)) throw new HttpError(403, 'Only administrators can change who may use a password.');
    const { p } = await this.load(scope, id);
    const body = passwordAccessSchema.parse(input);
    const userIds = [...new Set(body.userIds)];
    const groupIds = [...new Set(body.groupIds)];
    if (userIds.length) {
      const found = await scope.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.orgId, scope.actor.orgId), inArray(schema.users.id, userIds)));
      if (found.length !== userIds.length) throw new HttpError(400, 'Choose people from this workspace.');
    }
    if (groupIds.length) {
      const found = await scope.db
        .select({ id: schema.groups.id })
        .from(schema.groups)
        .where(and(eq(schema.groups.orgId, scope.actor.orgId), inArray(schema.groups.id, groupIds)));
      if (found.length !== groupIds.length) throw new HttpError(400, 'Choose groups from this workspace.');
    }
    await scope.db.transaction(async (tx) => {
      await tx.delete(schema.passwordAccess).where(eq(schema.passwordAccess.passwordId, id));
      await tx.delete(schema.passwordGroupAccess).where(eq(schema.passwordGroupAccess.passwordId, id));
      if (userIds.length)
        await tx.insert(schema.passwordAccess).values(userIds.map((userId) => ({ passwordId: id, userId })));
      if (groupIds.length)
        await tx.insert(schema.passwordGroupAccess).values(groupIds.map((groupId) => ({ passwordId: id, groupId })));
    });
    await this.audit(scope, p, 'Changed who may use it', `${userIds.length} people, ${groupIds.length} groups`, ip);
    return { userIds, groupIds };
  }

  // ---------- export ----------
  /** Decrypted secrets for a client's passwords, for an administrator's export. Each entry is audited. */
  async exportSecrets(scope: Scope, clientId: string, ip: string) {
    if (!this.isAdmin(scope)) throw new HttpError(403, 'Only administrators can export decrypted passwords.');
    const org = scope.actor.orgId;
    const rows = await scope.db
      .select()
      .from(schema.passwords)
      .where(and(eq(schema.passwords.orgId, org), eq(schema.passwords.clientId, clientId)));
    const out: {
      id: string;
      secret: string;
      notes: string;
      totp: string;
      customFields: { label: string; secret: boolean; value: string }[];
    }[] = [];
    for (const p of rows) {
      out.push({
        id: p.id,
        secret: await this.keys.open(org, p.secret, aad(p.id, 'secret')),
        notes: p.notes ? await this.keys.open(org, p.notes, aad(p.id, 'notes')) : '',
        totp: p.totp ? await this.keys.open(org, p.totp, aad(p.id, 'totp')) : '',
        customFields: await Promise.all(
          p.customFields.map(async (f) => ({
            label: f.label,
            secret: f.secret,
            value: f.secret ? await this.keys.open(org, f.value, aad(p.id, `custom:${f.id}`)) : f.value,
          })),
        ),
      });
      await this.audit(scope, p, 'Exported (decrypted)', '', ip);
    }
    return out;
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
