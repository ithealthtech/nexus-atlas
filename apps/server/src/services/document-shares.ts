import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { createDocumentShareSchema, type DocumentShareView, type RichText, type SharedArticle } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { isUuid, type Scope } from './scope.js';

/**
 * Sharing a document by link: anyone who has the link can read that one document, as it is now, without signing
 * in. Meant for how-to articles sent to a client's staff. Making or revoking a link needs edit access to the
 * document, and both are written to the security log.
 */
export class DocumentShareService {
  constructor(
    private readonly db: Database,
    private readonly publicOrigin: string,
  ) {}

  private async document(scope: Scope, id: string) {
    const [doc] = isUuid(id)
      ? await scope.db
          .select()
          .from(schema.documents)
          .where(and(eq(schema.documents.id, id), eq(schema.documents.orgId, scope.actor.orgId)))
      : [];
    if (!doc) throw new HttpError(404, 'Document not found.');
    await scope.require(doc.clientId, 'edit', 'Document');
    return doc;
  }

  private view(row: typeof schema.documentShares.$inferSelect, createdByName: string | null): DocumentShareView {
    const expired = !!row.expiresAt && row.expiresAt.getTime() < Date.now();
    return {
      id: row.id,
      url: `${this.publicOrigin}/kb/${row.token}`,
      createdByName,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      views: row.views,
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      status: row.revokedAt ? 'revoked' : expired ? 'expired' : 'active',
    };
  }

  private event(scope: Scope, action: string, detail: string, ip: string) {
    return scope.db.insert(schema.securityEvents).values({
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action,
      detail: detail.slice(0, 300),
      ip,
    });
  }

  async list(scope: Scope, documentId: string): Promise<DocumentShareView[]> {
    await this.document(scope, documentId);
    const rows = await scope.db
      .select({ share: schema.documentShares, name: schema.users.name })
      .from(schema.documentShares)
      .leftJoin(schema.users, eq(schema.users.id, schema.documentShares.createdBy))
      .where(eq(schema.documentShares.documentId, documentId))
      .orderBy(desc(schema.documentShares.createdAt));
    return rows.map((r) => this.view(r.share, r.name));
  }

  async create(scope: Scope, documentId: string, input: unknown, ip: string): Promise<DocumentShareView> {
    const doc = await this.document(scope, documentId);
    if (doc.archived) throw new HttpError(400, 'Restore the document before sharing it.');
    const body = createDocumentShareSchema.parse(input ?? {});
    const [row] = await scope.db
      .insert(schema.documentShares)
      .values({
        orgId: scope.actor.orgId,
        documentId,
        token: randomBytes(24).toString('base64url'),
        expiresAt: body.expiresDays ? new Date(Date.now() + body.expiresDays * 86_400_000) : null,
        createdBy: scope.actor.id,
      })
      .returning();
    await this.event(
      scope,
      'Document shared by link',
      `${doc.title}${body.expiresDays ? ` (expires in ${body.expiresDays} days)` : ' (no expiry)'}`,
      ip,
    );
    return this.view(row!, scope.actor.name);
  }

  async revoke(scope: Scope, shareId: string, ip: string) {
    const [share] = isUuid(shareId)
      ? await scope.db
          .select()
          .from(schema.documentShares)
          .where(and(eq(schema.documentShares.id, shareId), eq(schema.documentShares.orgId, scope.actor.orgId)))
      : [];
    if (!share) throw new HttpError(404, 'Link not found.');
    const doc = await this.document(scope, share.documentId);
    if (!share.revokedAt) {
      await scope.db
        .update(schema.documentShares)
        .set({ revokedAt: new Date() })
        .where(eq(schema.documentShares.id, shareId));
      await this.event(scope, 'Document link revoked', doc.title, ip);
    }
    return this.list(scope, share.documentId);
  }

  /** What a link shows. A revoked or expired link, and one whose document was archived, look like no link at all. */
  async open(token: string): Promise<SharedArticle> {
    const missing = new HttpError(404, 'This link doesn’t work any more, or was copied incompletely.');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw missing;
    const [row] = await this.db
      .select({ share: schema.documentShares, doc: schema.documents, org: schema.orgs.name })
      .from(schema.documentShares)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.documentShares.documentId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.documentShares.orgId))
      .where(eq(schema.documentShares.token, token));
    if (
      !row ||
      row.share.revokedAt ||
      (row.share.expiresAt && row.share.expiresAt.getTime() < Date.now()) ||
      row.doc.archived
    )
      throw missing;
    await this.db
      .update(schema.documentShares)
      .set({ views: sql`${schema.documentShares.views} + 1`, lastViewedAt: new Date() })
      .where(eq(schema.documentShares.id, row.share.id));
    return {
      title: row.doc.title,
      content: row.doc.content as RichText,
      updatedAt: row.doc.updatedAt.toISOString(),
      organization: row.org,
    };
  }
}
