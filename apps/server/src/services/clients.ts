import { and, count, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema, type Database } from '@atlas/db';
import {
  createClientSchema,
  updateClientSchema,
  type Actor,
  type ClientSummary,
  type RevisionView,
} from '@atlas/shared';
import { clientLevels, requireAdmin, requireAllClientsEdit, requireClient } from '../authz.js';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { getRevision, listRevisions, snapshot } from './revisions.js';
import type { FileStorage } from './storage.js';

type ClientRow = typeof schema.clients.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const view = (c: ClientRow, access: ClientSummary['access']): ClientSummary => ({
  id: c.id,
  name: c.name,
  type: c.type,
  status: c.status as ClientSummary['status'],
  notes: c.notes,
  notesVersion: c.notesVersion,
  notesUpdatedAt: c.notesUpdatedAt?.toISOString() ?? null,
  notesUpdatedByName: c.notesUpdatedByName,
  hours: c.hours,
  maintenanceWindow: c.maintenanceWindow,
  requireRevealReason: c.requireRevealReason,
  access,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});
// Sent by the quick notes editor so two people editing at once don't overwrite each other.
const notesVersionSchema = z.object({ notesVersion: z.number().int().min(0).optional() });
const deleteClientSchema = z.object({ confirmName: z.string().max(500) });
const conflict = () =>
  new HttpError(409, 'Someone else changed these notes. Reload to see their changes before saving.', 'conflict');

/** The columns that record a quick notes change, and its revision. */
export async function saveNotesRevision(tx: Tx, actor: Actor, clientId: string, version: number, notes: string) {
  await snapshot(tx, actor, 'client_notes', clientId, version, { notes });
  return {
    notes,
    notesVersion: version,
    notesUpdatedBy: actor.id,
    notesUpdatedByName: actor.name,
    notesUpdatedAt: new Date(),
  };
}

export class ClientService {
  constructor(private readonly db: Database) {}

  async list(actor: Actor): Promise<ClientSummary[]> {
    const levels = await clientLevels(this.db, actor);
    const rows = await this.db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.orgId, actor.orgId))
      .orderBy(sql`lower(${schema.clients.name})`);
    return rows.filter((c) => (levels.get(c.id) ?? 'none') !== 'none').map((c) => view(c, levels.get(c.id)!));
  }

  async get(actor: Actor, id: string): Promise<ClientSummary> {
    const { client, level } = await requireClient(this.db, actor, id, 'read');
    return view(client, level);
  }

  async create(actor: Actor, input: unknown): Promise<ClientSummary> {
    requireAllClientsEdit(actor);
    const body = createClientSchema.parse(input);
    const client = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.clients)
        .values({ ...body, orgId: actor.orgId })
        .returning();
      if (body.notes)
        await tx
          .update(schema.clients)
          .set(await saveNotesRevision(tx, actor, row!.id, 1, body.notes))
          .where(eq(schema.clients.id, row!.id));
      return row!;
    });
    return this.get(actor, client.id);
  }

  async update(actor: Actor, id: string, input: unknown): Promise<ClientSummary> {
    const { client } = await requireClient(this.db, actor, id, 'edit');
    const body = updateClientSchema.parse(input);
    const { notesVersion: expected } = notesVersionSchema.parse(input ?? {});
    const notesChanged = body.notes !== undefined && body.notes !== client.notes;
    if (notesChanged && expected !== undefined && expected !== client.notesVersion) throw conflict();
    await this.db.transaction(async (tx) => {
      const { notes: _notes, ...rest } = body;
      // Notes that arrived without a version (an import, say) become version 1, so the history starts with them.
      let from = client.notesVersion;
      if (notesChanged && from === 0 && client.notes) {
        await tx.insert(schema.revisions).values({
          orgId: actor.orgId,
          entityType: 'client_notes',
          entityId: id,
          version: 1,
          snapshot: { notes: client.notes },
          authorName: 'Before version history',
          createdAt: client.updatedAt,
        });
        from = 1;
      }
      const notes = notesChanged ? await saveNotesRevision(tx, actor, id, from + 1, body.notes!) : {};
      const updated = await tx
        .update(schema.clients)
        .set({ ...rest, ...notes, updatedAt: new Date() })
        .where(
          and(
            eq(schema.clients.id, id),
            eq(schema.clients.orgId, actor.orgId),
            // Saving notes only lands on the version they were edited from.
            ...(notesChanged ? [eq(schema.clients.notesVersion, client.notesVersion)] : []),
          ),
        )
        .returning({ id: schema.clients.id });
      if (!updated.length) throw conflict();
      if (notesChanged)
        await recordActivity(tx, actor, {
          clientId: id,
          action: 'Updated quick notes of',
          entityType: 'client',
          entityId: id,
          title: client.name,
        });
    });
    return this.get(actor, id);
  }

  /**
   * Deletes a client and everything under it (contacts, locations, assets, documents, passwords, files, checklists,
   * access, history). Administrators only, with the client's name typed exactly; recorded in the security log.
   */
  async remove(actor: Actor, id: string, input: unknown, storage: FileStorage, ip: string) {
    requireAdmin(actor);
    const { client } = await requireClient(this.db, actor, id, 'read');
    const { confirmName } = deleteClientSchema.parse(input ?? {});
    if (confirmName.trim() !== client.name.trim())
      throw new HttpError(400, 'Type the client’s name exactly as shown.', undefined, {
        confirmName: 'Type the client’s name exactly as shown.',
      });
    const files = await this.db
      .select({ key: schema.attachments.storageKey })
      .from(schema.attachments)
      .where(eq(schema.attachments.clientId, id));
    await this.db.transaction(async (tx) => {
      // Rows under the client go with it (foreign keys cascade); links, favorites, history and import IDs only
      // name their item by ID, so they're cleared here.
      const ids = [id];
      for (const t of [
        schema.contacts,
        schema.locations,
        schema.assets,
        schema.documents,
        schema.passwords,
        schema.checklists,
        schema.passwordFolders,
      ])
        ids.push(...(await tx.select({ id: t.id }).from(t).where(eq(t.clientId, id))).map((r) => r.id));
      const r = schema.relations;
      await tx.delete(r).where(and(eq(r.orgId, actor.orgId), or(inArray(r.aId, ids), inArray(r.bId, ids))));
      await tx.delete(schema.favorites).where(inArray(schema.favorites.entityId, ids));
      await tx
        .delete(schema.revisions)
        .where(and(eq(schema.revisions.orgId, actor.orgId), inArray(schema.revisions.entityId, ids)));
      await tx
        .delete(schema.externalRefs)
        .where(and(eq(schema.externalRefs.orgId, actor.orgId), inArray(schema.externalRefs.entityId, ids)));
      await tx.delete(schema.clients).where(and(eq(schema.clients.id, id), eq(schema.clients.orgId, actor.orgId)));
      // ConnectWise RMM companies linked to it go back to unlinked.
      const [org] = await tx
        .select({ settings: schema.orgs.settings })
        .from(schema.orgs)
        .where(eq(schema.orgs.id, actor.orgId));
      const map = (org?.settings as { cwRmm?: { map?: Record<string, { clientId?: string }> } } | null)?.cwRmm?.map;
      const linked = Object.entries(map ?? {}).filter(([, m]) => m.clientId === id);
      if (map && linked.length) {
        for (const [company] of linked) delete map[company];
        await tx
          .update(schema.orgs)
          .set({ settings: sql`jsonb_set(${schema.orgs.settings}, '{cwRmm,map}', ${JSON.stringify(map)}::jsonb)` })
          .where(eq(schema.orgs.id, actor.orgId));
      }
      await tx.insert(schema.securityEvents).values({
        orgId: actor.orgId,
        userId: actor.id,
        actor: actor.name,
        action: 'Deleted a client',
        detail: client.name.slice(0, 300),
        ip,
      });
    });
    // Files last: if the database part failed, nothing is gone.
    for (const f of files) await storage.remove(f.key).catch(() => undefined);
  }

  // ---------- quick notes history ----------
  async notesRevisions(actor: Actor, id: string): Promise<RevisionView[]> {
    await requireClient(this.db, actor, id, 'read');
    return listRevisions(this.db, 'client_notes', id);
  }

  async notesRevision(actor: Actor, id: string, version: number): Promise<{ notes: string }> {
    await requireClient(this.db, actor, id, 'read');
    if (!Number.isInteger(version) || version < 1) throw new HttpError(404, 'That version was not found.');
    return getRevision<{ notes: string }>(this.db, 'client_notes', id, version);
  }

  async restoreNotes(actor: Actor, id: string, version: number, expectedVersion: number): Promise<ClientSummary> {
    await requireClient(this.db, actor, id, 'edit');
    const old = await this.notesRevision(actor, id, version);
    return this.update(actor, id, { notes: old.notes, notesVersion: expectedVersion });
  }

  // ---------- section counts ----------
  /** Counts beside each section of the client workspace. Passwords are counted by the caller (it needs the vault). */
  async counts(actor: Actor, id: string) {
    await requireClient(this.db, actor, id, 'read');
    const tally = async (table: typeof schema.contacts | typeof schema.locations) =>
      (await this.db.select({ n: count() }).from(table).where(eq(table.clientId, id)))[0]!.n;
    const live = async (table: typeof schema.assets | typeof schema.documents | typeof schema.checklists) =>
      (
        await this.db
          .select({ n: count() })
          .from(table)
          .where(and(eq(table.clientId, id), eq(table.archived, false)))
      )[0]!.n;
    const [assets, documents, checklists, contacts, locations] = await Promise.all([
      live(schema.assets),
      live(schema.documents),
      live(schema.checklists),
      tally(schema.contacts),
      tally(schema.locations),
    ]);
    return { assets, documents, checklists, contacts, locations };
  }
}
