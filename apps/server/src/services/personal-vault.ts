import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  MAX_PERSONAL_ENTRIES,
  MAX_SECRET_LENGTH,
  ROLE_INFO,
  createPersonalPasswordSchema,
  deviceFillSchema,
  passwordStrength,
  personalRevealSchema,
  updatePersonalPasswordSchema,
  type DeviceLoginView,
  type PersonalPasswordView,
  type PersonalVaultStatus,
  type RevealResult,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { VaultKeys } from '../crypto/vault-keys.js';
import { totp } from '../identity/totp.js';
import { matchLogin, siteOf } from './login-match.js';
import { isUuid, type Scope } from './scope.js';

type Row = typeof schema.personalPasswords.$inferSelect;
type Field = 'secret' | 'notes' | 'totp';
// Ciphertext names its owner as well as the entry, so a row copied to another person can't be opened as theirs.
const aad = (userId: string, id: string, field: Field) => `ppw|${userId}|${id}|${field}`;
const notFound = () => new HttpError(404, 'That entry was not found in your vault.');
const conflict = () =>
  new HttpError(409, 'This entry was changed in another window. Reload before saving.', 'conflict');
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
/** What the browser extension shows where a shared login shows its client. */
export const PERSONAL_VAULT_NAME = 'My vault';

/**
 * Personal vaults: each staff member's own logins and notes. Every query here is limited to the signed-in person's
 * rows; no role sees anyone else's, and nothing is written to the vault audit log or the activity feed, because
 * both are read by other people. Entries live in their own table, out of reach of everything that reads the shared
 * vault.
 */
export class PersonalVaultService {
  constructor(private readonly keys: VaultKeys) {}

  /** Staff have a personal vault unless the organization turned them off. Client accounts never do. */
  async enabled(scope: Scope) {
    return ROLE_INFO[scope.actor.role].staff && (await scope.policy()).personalVaults;
  }

  private async require(scope: Scope) {
    if (!ROLE_INFO[scope.actor.role].staff) throw new HttpError(404, 'Not found.');
    if (!(await scope.policy()).personalVaults)
      throw new HttpError(403, 'Your organization has turned personal vaults off.', 'personal_vaults_off');
  }

  private mine(scope: Scope, extra?: SQL) {
    const p = schema.personalPasswords;
    return and(eq(p.userId, scope.actor.id), eq(p.orgId, scope.actor.orgId), extra);
  }

  private async load(scope: Scope, id: string): Promise<Row> {
    await this.require(scope);
    const [row] = isUuid(id)
      ? await scope.db
          .select()
          .from(schema.personalPasswords)
          .where(this.mine(scope, eq(schema.personalPasswords.id, id)))
      : [];
    if (!row) throw notFound();
    return row;
  }

  private view(row: Row): PersonalPasswordView {
    return {
      id: row.id,
      kind: row.kind as PersonalPasswordView['kind'],
      name: row.name,
      username: row.username,
      url: row.url,
      hasNotes: row.notes !== null,
      hasTotp: row.totp !== null,
      strength: row.strength,
      favorite: row.favorite,
      changedAt: row.changedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }

  async status(scope: Scope): Promise<PersonalVaultStatus> {
    if (!(await this.enabled(scope))) return { enabled: false, count: 0 };
    const [row] = await scope.db.select({ n: count() }).from(schema.personalPasswords).where(this.mine(scope));
    return { enabled: true, count: row?.n ?? 0 };
  }

  async list(scope: Scope): Promise<PersonalPasswordView[]> {
    await this.require(scope);
    const p = schema.personalPasswords;
    const rows = await scope.db
      .select()
      .from(p)
      .where(this.mine(scope))
      .orderBy(desc(p.favorite), asc(sql`lower(${p.name})`));
    return rows.map((r) => this.view(r));
  }

  async get(scope: Scope, id: string): Promise<PersonalPasswordView> {
    return this.view(await this.load(scope, id));
  }

  async create(scope: Scope, input: unknown): Promise<PersonalPasswordView> {
    await this.require(scope);
    const body = createPersonalPasswordSchema.parse(input);
    const { id: userId, orgId } = scope.actor;
    const [held] = await scope.db.select({ n: count() }).from(schema.personalPasswords).where(this.mine(scope));
    if ((held?.n ?? 0) >= MAX_PERSONAL_ENTRIES)
      throw new HttpError(400, `A personal vault holds up to ${MAX_PERSONAL_ENTRIES} entries.`);
    const id = randomUUID();
    // A note is only its text: no username, address, extra notes, or code.
    const note = body.kind === 'note';
    const [row] = await scope.db
      .insert(schema.personalPasswords)
      .values({
        id,
        orgId,
        userId,
        kind: body.kind,
        name: body.name,
        username: note ? '' : body.username,
        url: note ? '' : body.url,
        secret: await this.keys.seal(orgId, body.secret, aad(userId, id, 'secret')),
        notes: body.notes && !note ? await this.keys.seal(orgId, body.notes, aad(userId, id, 'notes')) : null,
        totp: body.totp && !note ? await this.keys.seal(orgId, body.totp, aad(userId, id, 'totp')) : null,
        strength: note ? null : passwordStrength(body.secret),
        favorite: body.favorite,
      })
      .returning();
    return this.view(row!);
  }

  async update(scope: Scope, id: string, input: unknown): Promise<PersonalPasswordView> {
    const before = await this.load(scope, id);
    const body = updatePersonalPasswordSchema.parse(input);
    if (body.version !== before.version) throw conflict();
    const { id: userId, orgId } = scope.actor;
    const note = before.kind === 'note';
    const set: Partial<typeof schema.personalPasswords.$inferInsert> = {
      version: before.version + 1,
      updatedAt: new Date(),
    };
    if (body.name !== undefined) set.name = body.name;
    if (body.favorite !== undefined) set.favorite = body.favorite;
    if (body.secret !== undefined) {
      if (!note && body.secret.length > MAX_SECRET_LENGTH) {
        const message = `A password can be up to ${MAX_SECRET_LENGTH} characters.`;
        throw new HttpError(400, message, undefined, { secret: message });
      }
      set.secret = await this.keys.seal(orgId, body.secret, aad(userId, id, 'secret'));
      set.strength = note ? null : passwordStrength(body.secret);
      set.changedAt = new Date();
    }
    if (!note) {
      if (body.username !== undefined) set.username = body.username;
      if (body.url !== undefined) set.url = body.url;
      if (body.notes !== undefined)
        set.notes = body.notes ? await this.keys.seal(orgId, body.notes, aad(userId, id, 'notes')) : null;
      if (body.totp !== undefined)
        set.totp = body.totp ? await this.keys.seal(orgId, body.totp, aad(userId, id, 'totp')) : null;
    }
    const p = schema.personalPasswords;
    const [row] = await scope.db
      .update(p)
      .set(set)
      .where(this.mine(scope, and(eq(p.id, id), eq(p.version, before.version))))
      .returning();
    if (!row) throw conflict();
    return this.view(row);
  }

  /** Gone for good: a personal entry has no archive and no history. */
  async remove(scope: Scope, id: string) {
    const row = await this.load(scope, id);
    await scope.db.delete(schema.personalPasswords).where(this.mine(scope, eq(schema.personalPasswords.id, row.id)));
  }

  private async open(scope: Scope, row: Row, field: Field) {
    const stored = row[field];
    if (!stored) throw new HttpError(404, 'Nothing is stored in that field.');
    return this.keys.open(scope.actor.orgId, stored, aad(row.userId, row.id, field));
  }

  async reveal(scope: Scope, id: string, input: unknown): Promise<RevealResult> {
    const row = await this.load(scope, id);
    const { field } = personalRevealSchema.parse(input ?? {});
    const value = await this.open(scope, row, field);
    if (field === 'totp') return { value: totp(value), expiresIn: 30 - (Math.floor(Date.now() / 1000) % 30) };
    return { value };
  }

  // ---------- browser extension ----------
  private async deviceRows(scope: Scope, where: SQL, limit: number) {
    if (!(await this.enabled(scope))) return [];
    const p = schema.personalPasswords;
    return scope.db
      .select()
      .from(p)
      .where(this.mine(scope, and(eq(p.kind, 'login'), where)))
      .orderBy(asc(sql`lower(${p.name})`))
      .limit(limit);
  }

  private deviceView(row: Row, match: DeviceLoginView['match']): DeviceLoginView {
    return {
      id: row.id,
      name: row.name,
      username: row.username,
      url: row.url,
      clientId: '',
      clientName: PERSONAL_VAULT_NAME,
      hasTotp: row.totp !== null,
      requireReason: false,
      match,
    };
  }

  /** The person's own logins saved for this page: same host first, then the rest of its domain. */
  async matchingLogins(scope: Scope, pageUrl: string): Promise<DeviceLoginView[]> {
    const page = siteOf(pageUrl);
    if (!page) return [];
    const rows = await this.deviceRows(
      scope,
      sql`${schema.personalPasswords.url} ilike ${likePattern(page.domain ?? page.host)}`,
      500,
    );
    const rank = { exact: 0, domain: 1 } as const;
    return rows
      .map((r) => ({ r, match: matchLogin(r.url, page) }))
      .filter((m) => m.match)
      .sort((a, b) => rank[a.match!] - rank[b.match!])
      .slice(0, 50)
      .map((m) => this.deviceView(m.r, m.match));
  }

  async searchLogins(scope: Scope, query: string): Promise<DeviceLoginView[]> {
    const q = query.trim().slice(0, 100);
    if (q.length < 2) return [];
    const pattern = likePattern(q);
    const p = schema.personalPasswords;
    const rows = await this.deviceRows(
      scope,
      or(sql`${p.name} ilike ${pattern}`, sql`${p.username} ilike ${pattern}`, sql`${p.url} ilike ${pattern}`)!,
      25,
    );
    return rows.map((r) => this.deviceView(r, null));
  }

  /** Whether this id is one of the person's own entries, so the extension's calls can be sent to the right vault. */
  async owns(scope: Scope, id: string) {
    if (!isUuid(id) || !(await this.enabled(scope))) return false;
    const [row] = await scope.db
      .select({ id: schema.personalPasswords.id })
      .from(schema.personalPasswords)
      .where(this.mine(scope, eq(schema.personalPasswords.id, id)));
    return !!row;
  }

  /** The username and password to fill into a page. The login's address must match the page. */
  async fill(scope: Scope, id: string, input: unknown): Promise<{ username: string; password: string }> {
    const row = await this.load(scope, id);
    const page = siteOf(deviceFillSchema.parse(input ?? {}).url);
    if (row.kind !== 'login' || !page || !matchLogin(row.url, page))
      throw new HttpError(400, 'This login is not saved for this site.', 'site_mismatch');
    return { username: row.username, password: await this.open(scope, row, 'secret') };
  }
}
