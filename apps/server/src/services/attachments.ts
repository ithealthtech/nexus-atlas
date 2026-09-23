import { and, desc, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { MultipartFile } from '@fastify/multipart';
import { schema } from '@atlas/db';
import type { AttachmentView, ItemType } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { requireItem } from './items.js';
import { isUuid, type Scope } from './scope.js';
import { TooLargeError, sniffImage, type FileStorage } from './storage.js';

const uploader = alias(schema.users, 'uploader');
const cleanName = (name: string) =>
  name
    .normalize('NFKC')
    // Control characters and path separators never belong in a stored filename.
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200) || 'file';

export class AttachmentService {
  constructor(
    private readonly storage: FileStorage,
    private readonly maxBytes: number,
  ) {}

  async list(scope: Scope, type: ItemType, id: string): Promise<AttachmentView[]> {
    await requireItem(scope, type, id, 'read');
    const rows = await scope.db
      .select({ f: schema.attachments, by: uploader.name })
      .from(schema.attachments)
      .leftJoin(uploader, eq(uploader.id, schema.attachments.uploadedBy))
      .where(
        and(
          eq(schema.attachments.orgId, scope.actor.orgId),
          eq(schema.attachments.entityType, type),
          eq(schema.attachments.entityId, id),
        ),
      )
      .orderBy(desc(schema.attachments.createdAt));
    return rows.map(({ f, by }) => ({
      id: f.id,
      filename: f.filename,
      contentType: f.contentType,
      size: f.size,
      uploadedByName: by,
      createdAt: f.createdAt.toISOString(),
      previewable: f.contentType.startsWith('image/'),
    }));
  }

  async upload(scope: Scope, type: ItemType, id: string, file: MultipartFile | undefined): Promise<AttachmentView[]> {
    if (!file) throw new HttpError(400, 'Choose a file to upload.');
    const item = await requireItem(scope, type, id, 'edit');
    let stored;
    try {
      stored = await this.storage.put(scope.actor.orgId, file.file, this.maxBytes);
    } catch (error) {
      if (error instanceof TooLargeError || file.file.truncated)
        throw new HttpError(413, `Files can be up to ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
      throw error;
    }
    // The multipart parser stops reading at its size limit without an error; never keep a cut-off file.
    if (file.file.truncated) {
      await this.storage.remove(stored.key);
      throw new HttpError(413, `Files can be up to ${Math.round(this.maxBytes / 1024 / 1024)} MB.`);
    }
    if (stored.size === 0) {
      await this.storage.remove(stored.key);
      throw new HttpError(400, 'That file is empty.');
    }
    const filename = cleanName(file.filename);
    // Only images verified by their contents are ever served inline; everything else downloads.
    const contentType = sniffImage(stored.head) ?? 'application/octet-stream';
    await scope.db.transaction(async (tx) => {
      await tx.insert(schema.attachments).values({
        orgId: scope.actor.orgId,
        clientId: item.clientId,
        entityType: type,
        entityId: id,
        filename,
        contentType,
        size: stored.size,
        sha256: stored.sha256,
        storageKey: stored.key,
        uploadedBy: scope.actor.id,
      });
      await recordActivity(tx, scope.actor, {
        clientId: item.clientId,
        action: 'Attached a file to',
        entityType: type,
        entityId: id,
        title: `${item.title} · ${filename}`,
      });
    });
    return this.list(scope, type, id);
  }

  private async load(scope: Scope, attachmentId: string, level: 'read' | 'edit') {
    const [row] = isUuid(attachmentId)
      ? await scope.db
          .select()
          .from(schema.attachments)
          .where(and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.orgId, scope.actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'File not found.');
    // Access follows the item the file belongs to.
    const item = await requireItem(scope, row.entityType as ItemType, row.entityId, level);
    return { row, item };
  }

  async open(scope: Scope, attachmentId: string) {
    const { row } = await this.load(scope, attachmentId, 'read');
    return { row, stream: await this.storage.get(row.storageKey) };
  }

  async remove(scope: Scope, attachmentId: string) {
    const { row, item } = await this.load(scope, attachmentId, 'edit');
    await scope.db.transaction(async (tx) => {
      await tx.delete(schema.attachments).where(eq(schema.attachments.id, row.id));
      await recordActivity(tx, scope.actor, {
        clientId: row.clientId,
        action: 'Removed a file from',
        entityType: row.entityType,
        entityId: row.entityId,
        title: `${item.title} · ${row.filename}`,
      });
    });
    await this.storage.remove(row.storageKey);
  }
}
