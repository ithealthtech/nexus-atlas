import { and, asc, count, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import {
  createDocumentSchema,
  folderSchema,
  updateDocumentSchema,
  atLeast,
  type DocumentSummary,
  type DocumentView,
  type FolderView,
  type RevisionView,
  type RichText,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { getRevision, listRevisions, snapshot } from './revisions.js';
import { cleanRichText } from './richtext.js';
import { isUuid, type Scope } from './scope.js';

type Snapshot = {
  title: string;
  content: RichText;
  text: string;
  status: DocumentSummary['status'];
  reviewDate: string | null;
  folderId: string | null;
};
const editor = alias(schema.users, 'doc_editor');
const conflict = () =>
  new HttpError(409, 'Someone else changed this document. Reload to see their changes before saving.', 'conflict');

export class DocumentService {
  private select(scope: Scope) {
    return scope.db
      .select({ d: schema.documents, clientName: schema.clients.name, editor: editor.name })
      .from(schema.documents)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.documents.clientId))
      .leftJoin(editor, eq(editor.id, schema.documents.updatedBy));
  }
  private summary(r: {
    d: typeof schema.documents.$inferSelect;
    clientName: string | null;
    editor: string | null;
  }): DocumentSummary {
    return {
      id: r.d.id,
      clientId: r.d.clientId,
      clientName: r.clientName,
      folderId: r.d.folderId,
      title: r.d.title,
      status: r.d.status as DocumentSummary['status'],
      reviewDate: r.d.reviewDate,
      version: r.d.version,
      archived: r.d.archived,
      updatedAt: r.d.updatedAt.toISOString(),
      updatedByName: r.editor,
    };
  }

  /** Lists documents: one client's, the MSP knowledge base (scope "global"), or everything visible (no scope). */
  async list(
    scope: Scope,
    filter: { clientId?: string | 'global'; folderId?: string; archived?: boolean; status?: string },
  ): Promise<DocumentSummary[]> {
    const conditions: SQL[] = [
      eq(schema.documents.orgId, scope.actor.orgId),
      eq(schema.documents.archived, !!filter.archived),
    ];
    if (filter.clientId === 'global') {
      if (!scope.canReadGlobal) return [];
      conditions.push(isNull(schema.documents.clientId));
    } else if (filter.clientId) {
      await scope.require(filter.clientId, 'read', 'Client');
      conditions.push(eq(schema.documents.clientId, filter.clientId));
    } else {
      const ids = await scope.readableClientIds();
      const visible = [
        ids.length ? inArray(schema.documents.clientId, ids) : undefined,
        scope.canReadGlobal ? isNull(schema.documents.clientId) : undefined,
      ].filter(Boolean) as SQL[];
      if (!visible.length) return [];
      conditions.push(or(...visible)!);
    }
    if (filter.folderId)
      conditions.push(isUuid(filter.folderId) ? eq(schema.documents.folderId, filter.folderId) : sql`false`);
    if (filter.status) conditions.push(eq(schema.documents.status, filter.status));
    const rows = await this.select(scope)
      .where(and(...conditions))
      .orderBy(asc(sql`lower(${schema.documents.title})`))
      .limit(2000);
    return rows.map((r) => this.summary(r));
  }

  private async load(scope: Scope, id: string) {
    const [row] = isUuid(id)
      ? await this.select(scope).where(and(eq(schema.documents.id, id), eq(schema.documents.orgId, scope.actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'Document not found.');
    const level = await scope.require(row.d.clientId, 'read', 'Document');
    return { row, level };
  }

  async get(scope: Scope, id: string): Promise<DocumentView> {
    const { row, level } = await this.load(scope, id);
    return { ...this.summary(row), content: row.d.content as RichText, canEdit: atLeast(level, 'edit') };
  }

  private async checkFolder(scope: Scope, folderId: string | null, clientId: string | null) {
    if (!folderId) return;
    const [folder] = await scope.db
      .select()
      .from(schema.folders)
      .where(and(eq(schema.folders.id, folderId), eq(schema.folders.orgId, scope.actor.orgId)));
    if (!folder || folder.clientId !== clientId)
      throw new HttpError(400, 'Choose a folder from the same knowledge base.');
  }

  async create(scope: Scope, input: unknown): Promise<DocumentView> {
    const body = createDocumentSchema.parse(input);
    await scope.require(body.clientId, 'edit', 'Client');
    await this.checkFolder(scope, body.folderId, body.clientId);
    const { content, text } = cleanRichText(body.content);
    const id = await scope.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.documents)
        .values({
          orgId: scope.actor.orgId,
          clientId: body.clientId,
          folderId: body.folderId,
          title: body.title,
          content,
          contentText: text,
          status: body.status,
          reviewDate: body.reviewDate,
          createdBy: scope.actor.id,
          updatedBy: scope.actor.id,
        })
        .returning({ id: schema.documents.id });
      await snapshot(tx, scope.actor, 'document', row!.id, 1, {
        title: body.title,
        content,
        text,
        status: body.status,
        reviewDate: body.reviewDate,
        folderId: body.folderId,
      } satisfies Snapshot);
      await recordActivity(tx, scope.actor, {
        clientId: body.clientId,
        action: 'Created',
        entityType: 'document',
        entityId: row!.id,
        title: body.title,
      });
      return row!.id;
    });
    return this.get(scope, id);
  }

  async update(scope: Scope, id: string, input: unknown, action = 'Updated'): Promise<DocumentView> {
    const { row } = await this.load(scope, id);
    const current = row.d;
    await scope.require(current.clientId, 'edit', 'Document');
    const body = updateDocumentSchema.parse(input);
    if (body.version !== current.version) throw conflict();
    const cleaned = body.content
      ? cleanRichText(body.content)
      : { content: current.content as RichText, text: current.contentText };
    const next: Snapshot = {
      title: body.title ?? current.title,
      content: cleaned.content,
      text: cleaned.text,
      status: body.status ?? (current.status as Snapshot['status']),
      reviewDate: body.reviewDate !== undefined ? body.reviewDate : current.reviewDate,
      folderId: body.folderId !== undefined ? body.folderId : current.folderId,
    };
    await this.checkFolder(scope, next.folderId, current.clientId);
    await scope.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.documents)
        .set({
          title: next.title,
          content: next.content,
          contentText: next.text,
          status: next.status,
          reviewDate: next.reviewDate,
          folderId: next.folderId,
          version: current.version + 1,
          updatedBy: scope.actor.id,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.documents.id, id), eq(schema.documents.version, current.version)))
        .returning({ id: schema.documents.id });
      if (!updated.length) throw conflict();
      await snapshot(tx, scope.actor, 'document', id, current.version + 1, next);
      await recordActivity(tx, scope.actor, {
        clientId: current.clientId,
        action,
        entityType: 'document',
        entityId: id,
        title: next.title,
      });
    });
    return this.get(scope, id);
  }

  async setArchived(scope: Scope, id: string, archived: boolean): Promise<DocumentView> {
    const { row } = await this.load(scope, id);
    await scope.require(row.d.clientId, 'edit', 'Document');
    await scope.db.transaction(async (tx) => {
      await tx
        .update(schema.documents)
        .set({ archived, updatedBy: scope.actor.id, updatedAt: new Date() })
        .where(eq(schema.documents.id, id));
      await recordActivity(tx, scope.actor, {
        clientId: row.d.clientId,
        action: archived ? 'Archived' : 'Restored',
        entityType: 'document',
        entityId: id,
        title: row.d.title,
      });
    });
    return this.get(scope, id);
  }

  async revisions(scope: Scope, id: string): Promise<RevisionView[]> {
    await this.load(scope, id);
    return listRevisions(scope.db, 'document', id);
  }

  async revision(scope: Scope, id: string, version: number): Promise<Snapshot> {
    await this.load(scope, id);
    return getRevision<Snapshot>(scope.db, 'document', id, version);
  }

  async restore(scope: Scope, id: string, version: number, expectedVersion: number): Promise<DocumentView> {
    const old = await this.revision(scope, id, version);
    // A folder deleted since then is dropped rather than failing the restore.
    const folderId =
      old.folderId &&
      (await scope.db.select({ id: schema.folders.id }).from(schema.folders).where(eq(schema.folders.id, old.folderId)))
        .length
        ? old.folderId
        : null;
    return this.update(
      scope,
      id,
      {
        title: old.title,
        content: old.content,
        status: old.status,
        reviewDate: old.reviewDate,
        folderId,
        version: expectedVersion,
      },
      `Restored version ${version} of`,
    );
  }

  // ---------- folders ----------
  async folders(scope: Scope, clientId: string | null): Promise<FolderView[]> {
    await scope.require(clientId, 'read', 'Client');
    const rows = await scope.db
      .select({ f: schema.folders, documents: count(schema.documents.id) })
      .from(schema.folders)
      .leftJoin(
        schema.documents,
        and(eq(schema.documents.folderId, schema.folders.id), eq(schema.documents.archived, false)),
      )
      .where(
        and(
          eq(schema.folders.orgId, scope.actor.orgId),
          clientId ? eq(schema.folders.clientId, clientId) : isNull(schema.folders.clientId),
        ),
      )
      .groupBy(schema.folders.id)
      .orderBy(asc(sql`lower(${schema.folders.name})`));
    return rows.map((r) => ({
      id: r.f.id,
      clientId: r.f.clientId,
      name: r.f.name,
      documentCount: Number(r.documents),
    }));
  }

  async createFolder(scope: Scope, input: unknown): Promise<FolderView> {
    const body = folderSchema.parse(input);
    await scope.require(body.clientId, 'edit', 'Client');
    const [row] = await scope.db
      .insert(schema.folders)
      .values({ orgId: scope.actor.orgId, clientId: body.clientId, name: body.name })
      .returning();
    return { id: row!.id, clientId: row!.clientId, name: row!.name, documentCount: 0 };
  }

  async deleteFolder(scope: Scope, id: string) {
    const [folder] = isUuid(id)
      ? await scope.db
          .select()
          .from(schema.folders)
          .where(and(eq(schema.folders.id, id), eq(schema.folders.orgId, scope.actor.orgId)))
      : [];
    if (!folder) throw new HttpError(404, 'Folder not found.');
    await scope.require(folder.clientId, 'edit', 'Folder');
    // Documents in the folder move to the top level (folder_id is set null by the foreign key).
    await scope.db.delete(schema.folders).where(eq(schema.folders.id, id));
  }
}
