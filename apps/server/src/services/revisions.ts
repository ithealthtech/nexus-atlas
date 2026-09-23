import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor, RevisionView } from '@atlas/shared';
import { HttpError } from '../errors.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Versioned = 'asset' | 'document';

export async function snapshot(
  tx: Tx,
  actor: Actor,
  entityType: Versioned,
  entityId: string,
  version: number,
  data: object,
) {
  await tx.insert(schema.revisions).values({
    orgId: actor.orgId,
    entityType,
    entityId,
    version,
    snapshot: data,
    authorId: actor.id,
    authorName: actor.name,
  });
}

export async function listRevisions(db: Database, entityType: Versioned, entityId: string): Promise<RevisionView[]> {
  const rows = await db
    .select({
      version: schema.revisions.version,
      authorName: schema.revisions.authorName,
      createdAt: schema.revisions.createdAt,
    })
    .from(schema.revisions)
    .where(and(eq(schema.revisions.entityType, entityType), eq(schema.revisions.entityId, entityId)))
    .orderBy(desc(schema.revisions.version));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function getRevision<T>(
  db: Database,
  entityType: Versioned,
  entityId: string,
  version: number,
): Promise<T> {
  const [row] = await db
    .select({ snapshot: schema.revisions.snapshot })
    .from(schema.revisions)
    .where(
      and(
        eq(schema.revisions.entityType, entityType),
        eq(schema.revisions.entityId, entityId),
        eq(schema.revisions.version, version),
      ),
    );
  if (!row) throw new HttpError(404, 'That version was not found.');
  return row.snapshot as T;
}
