import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { FAVORITE_TYPES, type FavoriteItem, type FavoriteType } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { isUuid, type Scope } from './scope.js';
import type { VaultService } from './vault.js';

const byName = (a: FavoriteItem, b: FavoriteItem) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export const favoriteType = (value: string): FavoriteType => {
  if (!(FAVORITE_TYPES as readonly string[]).includes(value)) throw new HttpError(404, 'Not found.');
  return value as FavoriteType;
};

/**
 * A person's starred clients, documents, and assets, plus their password favorites from the vault. Personal:
 * nobody else sees them. Access is checked when listing too, so a star on something the person has since lost
 * access to (or that was deleted or archived) just stops showing.
 */
export class FavoriteService {
  constructor(private readonly vault: VaultService) {}

  async list(scope: Scope): Promise<FavoriteItem[]> {
    const rows = await scope.db
      .select({ type: schema.favorites.entityType, id: schema.favorites.entityId })
      .from(schema.favorites)
      .where(eq(schema.favorites.userId, scope.actor.id));
    const ids = (type: FavoriteType) => rows.filter((r) => r.type === type).map((r) => r.id);
    const readable = new Set(await scope.readableClientIds());
    const orgId = scope.actor.orgId;

    const clientIds = ids('client').filter((id) => readable.has(id));
    const clients = clientIds.length
      ? await scope.db
          .select({ id: schema.clients.id, name: schema.clients.name })
          .from(schema.clients)
          .where(and(eq(schema.clients.orgId, orgId), inArray(schema.clients.id, clientIds)))
      : [];

    const documentIds = ids('document');
    const documents = documentIds.length
      ? await scope.db
          .select({
            id: schema.documents.id,
            name: schema.documents.title,
            clientId: schema.documents.clientId,
            clientName: schema.clients.name,
          })
          .from(schema.documents)
          .leftJoin(schema.clients, eq(schema.clients.id, schema.documents.clientId))
          .where(
            and(
              eq(schema.documents.orgId, orgId),
              eq(schema.documents.archived, false),
              inArray(schema.documents.id, documentIds),
            ),
          )
      : [];

    const assetIds = ids('asset');
    const assets = assetIds.length
      ? await scope.db
          .select({
            id: schema.assets.id,
            name: schema.assets.name,
            clientId: schema.assets.clientId,
            clientName: schema.clients.name,
          })
          .from(schema.assets)
          .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
          .where(
            and(eq(schema.assets.orgId, orgId), eq(schema.assets.archived, false), inArray(schema.assets.id, assetIds)),
          )
      : [];

    const passwords = await this.vault.list(scope, { favorites: true });
    return [
      ...clients.map((c) => ({ type: 'client' as const, id: c.id, name: c.name, clientId: null, clientName: null })),
      ...documents
        .filter((d) => (d.clientId === null ? scope.canReadGlobal : readable.has(d.clientId)))
        .map((d) => ({ type: 'document' as const, ...d })),
      ...assets.filter((a) => readable.has(a.clientId)).map((a) => ({ type: 'asset' as const, ...a })),
      ...passwords.map((p) => ({
        type: 'password' as const,
        id: p.id,
        name: p.name,
        clientId: p.clientId,
        clientName: p.clientName,
      })),
    ].sort((a, b) => FAVORITE_ORDER.indexOf(a.type) - FAVORITE_ORDER.indexOf(b.type) || byName(a, b));
  }

  async set(scope: Scope, type: FavoriteType, id: string, favorite: boolean): Promise<{ favorite: boolean }> {
    await this.requireVisible(scope, type, id);
    if (favorite)
      await scope.db
        .insert(schema.favorites)
        .values({ userId: scope.actor.id, entityType: type, entityId: id })
        .onConflictDoNothing();
    else
      await scope.db
        .delete(schema.favorites)
        .where(
          and(
            eq(schema.favorites.userId, scope.actor.id),
            eq(schema.favorites.entityType, type),
            eq(schema.favorites.entityId, id),
          ),
        );
    return { favorite };
  }

  /** 404 unless the item exists in the actor's organization and they can read it. */
  private async requireVisible(scope: Scope, type: FavoriteType, id: string) {
    const what = type === 'client' ? 'Client' : type === 'document' ? 'Document' : 'Asset';
    if (!isUuid(id)) throw new HttpError(404, `${what} not found.`);
    const orgId = scope.actor.orgId;
    const [row] =
      type === 'client'
        ? await scope.db
            .select({ clientId: schema.clients.id })
            .from(schema.clients)
            .where(and(eq(schema.clients.id, id), eq(schema.clients.orgId, orgId)))
        : type === 'document'
          ? await scope.db
              .select({ clientId: schema.documents.clientId })
              .from(schema.documents)
              .where(and(eq(schema.documents.id, id), eq(schema.documents.orgId, orgId)))
          : await scope.db
              .select({ clientId: schema.assets.clientId })
              .from(schema.assets)
              .where(and(eq(schema.assets.id, id), eq(schema.assets.orgId, orgId)));
    if (!row) throw new HttpError(404, `${what} not found.`);
    // Starring only needs read access; it changes nothing for anyone else.
    await scope.require(row.clientId, 'read', what);
  }
}

const FAVORITE_ORDER: FavoriteItem['type'][] = ['client', 'document', 'asset', 'password'];
