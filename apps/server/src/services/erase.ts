import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { EraseStatus } from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { SettingsService } from './settings.js';
import type { FileStorage } from './storage.js';

/** How long after the request the owner can confirm, and how long the confirmation stays open after that. */
export const ERASE_WAIT_MS = 10 * 60_000;
export const ERASE_WINDOW_MS = 60 * 60_000;

export function eraseStatus(
  request: Awaited<ReturnType<SettingsService['eraseRequest']>>,
  now = Date.now(),
): EraseStatus {
  if (!request || Date.parse(request.expiresAt) <= now) return { pending: null };
  return {
    pending: {
      requestedAt: request.requestedAt,
      requestedByName: request.requestedByName,
      confirmableAt: request.confirmableAt,
      expiresAt: request.expiresAt,
      confirmable: Date.parse(request.confirmableAt) <= now,
    },
  };
}

/**
 * Deletes an organization's documentation: clients and everything under them (contacts, locations, assets,
 * passwords and their history, client documents), the knowledge base, folders, links, custom asset layouts,
 * attachments (and their files), Sends (and their files), activity, and import records. People, groups, settings, integrations'
 * connections, backups, and the security log are kept, so the owner can sign in and import again.
 */
export async function eraseDocumentation(db: Database, orgId: string, storage: FileStorage) {
  const files = await db
    .select({ key: schema.attachments.storageKey })
    .from(schema.attachments)
    .where(eq(schema.attachments.orgId, orgId));
  const sent = await db
    .select({ key: schema.sends.storageKey })
    .from(schema.sends)
    .where(eq(schema.sends.orgId, orgId));
  const counts = await db.transaction(async (tx) => {
    const n = async (rows: Promise<unknown[]>) => (await rows).length;
    const clients = await n(
      tx.delete(schema.clients).where(eq(schema.clients.orgId, orgId)).returning({ id: schema.clients.id }),
    );
    // What isn't under a client: the knowledge base and other organization-wide items.
    const documents = await n(
      tx.delete(schema.documents).where(eq(schema.documents.orgId, orgId)).returning({ id: schema.documents.id }),
    );
    await tx.delete(schema.folders).where(eq(schema.folders.orgId, orgId));
    await tx.delete(schema.relations).where(eq(schema.relations.orgId, orgId));
    await tx.delete(schema.attachments).where(eq(schema.attachments.orgId, orgId));
    await tx.delete(schema.sends).where(eq(schema.sends.orgId, orgId));
    await tx.delete(schema.activity).where(eq(schema.activity.orgId, orgId));
    await tx.delete(schema.revisions).where(eq(schema.revisions.orgId, orgId));
    await tx.delete(schema.externalRefs).where(eq(schema.externalRefs.orgId, orgId));
    await tx.delete(schema.importJobs).where(eq(schema.importJobs.orgId, orgId));
    // Built-in layouts stay (as templates); ones made by imports or by hand go.
    const layouts = await n(
      tx
        .delete(schema.assetLayouts)
        .where(and(eq(schema.assetLayouts.orgId, orgId), eq(schema.assetLayouts.builtIn, false)))
        .returning({ id: schema.assetLayouts.id }),
    );
    return { clients, documents, layouts, files: files.length };
  });
  // Files last: if the database part failed, nothing is gone.
  for (const f of files) await storage.remove(f.key).catch(() => undefined);
  for (const s of sent) if (s.key) await storage.remove(s.key).catch(() => undefined);
  return counts;
}

export function requireOwner(role: string) {
  if (role !== 'owner') throw new HttpError(403, 'Only the owner can erase all data.');
}
