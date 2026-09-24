import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { open, seal, staticKeyProvider, type KeyProvider } from './keys.js';

const wrapAad = (orgId: string, keyId: string) => `org|${orgId}|vault-key|${keyId}`;

/**
 * Envelope encryption for the vault: each organization has data keys, stored only wrapped by the master key.
 * Field values are sealed with the organization's active data key; older keys stay available for reading.
 */
export class VaultKeys {
  private cache = new Map<string, { provider: KeyProvider; fingerprintKey: Buffer }>();
  constructor(
    private readonly db: Database,
    private readonly master: KeyProvider,
  ) {}

  /** The organization's data keys (creating the first one on demand). */
  async forOrg(orgId: string) {
    const cached = this.cache.get(orgId);
    if (cached) return cached;
    let rows = await this.db
      .select()
      .from(schema.vaultKeys)
      .where(eq(schema.vaultKeys.orgId, orgId))
      .orderBy(desc(schema.vaultKeys.active), desc(schema.vaultKeys.createdAt));
    if (!rows.length) {
      await this.create(orgId);
      rows = await this.db
        .select()
        .from(schema.vaultKeys)
        .where(eq(schema.vaultKeys.orgId, orgId))
        .orderBy(desc(schema.vaultKeys.active), desc(schema.vaultKeys.createdAt));
    }
    const keys = rows.map((r) => Buffer.from(open(this.master, r.wrappedKey, wrapAad(orgId, r.id)), 'base64url'));
    // The oldest key derives the reuse fingerprint key, so fingerprints stay comparable after rotation.
    const oldest = rows.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
    const oldestKey = Buffer.from(open(this.master, oldest.wrappedKey, wrapAad(orgId, oldest.id)), 'base64url');
    const entry = {
      provider: staticKeyProvider(keys),
      fingerprintKey: createHmac('sha256', oldestKey).update('atlas-password-fingerprint').digest(),
    };
    this.cache.set(orgId, entry);
    return entry;
  }

  private async create(orgId: string) {
    await this.db.transaction(async (tx) => {
      // Two requests creating the first key at once must not produce two keys.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}))`);
      const [existing] = await tx
        .select({ id: schema.vaultKeys.id })
        .from(schema.vaultKeys)
        .where(eq(schema.vaultKeys.orgId, orgId));
      if (existing) return;
      const id = randomUUID();
      await tx.insert(schema.vaultKeys).values({
        id,
        orgId,
        wrappedKey: seal(this.master, randomBytes(32).toString('base64url'), wrapAad(orgId, id)),
      });
    });
  }

  async seal(orgId: string, value: string, aad: string) {
    return seal((await this.forOrg(orgId)).provider, value, aad);
  }
  async open(orgId: string, value: string, aad: string) {
    return open((await this.forOrg(orgId)).provider, value, aad);
  }
  async fingerprint(orgId: string, value: string) {
    return createHmac('sha256', (await this.forOrg(orgId)).fingerprintKey)
      .update(value)
      .digest('base64url');
  }

  /** Re-wraps every data key under the current master key (after adding a new master key). Returns how many were re-wrapped. */
  static async rewrapAll(db: Database, master: KeyProvider): Promise<number> {
    const rows = await db.select().from(schema.vaultKeys).orderBy(asc(schema.vaultKeys.createdAt));
    let count = 0;
    for (const row of rows) {
      const plain = open(master, row.wrappedKey, wrapAad(row.orgId, row.id));
      const rewrapped = seal(master, plain, wrapAad(row.orgId, row.id));
      await db
        .update(schema.vaultKeys)
        .set({ wrappedKey: rewrapped })
        .where(and(eq(schema.vaultKeys.id, row.id), eq(schema.vaultKeys.wrappedKey, row.wrappedKey)));
      count++;
    }
    return count;
  }
}
