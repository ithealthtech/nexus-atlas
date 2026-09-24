import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor, ImportCounts, ImportJobView, ImportSource } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { isUuid } from '../scope.js';

type Kind = string;

/** Tracks one import run: counts per kind, messages, and the external-ID map that makes re-runs idempotent. */
export class ImportRun {
  readonly counts: Record<Kind, ImportCounts> = {};
  readonly messages: string[] = [];
  private lastFlush = 0;

  constructor(
    private readonly db: Database,
    readonly jobId: string,
    readonly orgId: string,
    readonly source: ImportSource,
  ) {}

  static async start(db: Database, actor: Actor, source: ImportSource) {
    const [running] = await db
      .select({ id: schema.importJobs.id })
      .from(schema.importJobs)
      .where(and(eq(schema.importJobs.orgId, actor.orgId), eq(schema.importJobs.status, 'running')));
    if (running) throw new HttpError(409, 'Another import is still running. Wait for it to finish.');
    const [job] = await db
      .insert(schema.importJobs)
      .values({ orgId: actor.orgId, source, startedBy: actor.id, startedByName: actor.name })
      .returning();
    return new ImportRun(db, job!.id, actor.orgId, source);
  }

  count(kind: Kind, what: keyof ImportCounts) {
    (this.counts[kind] ??= { created: 0, updated: 0, skipped: 0, failed: 0 })[what]++;
  }

  note(message: string) {
    if (this.messages.length < 500) this.messages.push(message.slice(0, 300));
  }

  async ref(kind: Kind, externalId: string | number): Promise<string | null> {
    const [row] = await this.db
      .select({ id: schema.externalRefs.entityId })
      .from(schema.externalRefs)
      .where(
        and(
          eq(schema.externalRefs.orgId, this.orgId),
          eq(schema.externalRefs.source, this.source),
          eq(schema.externalRefs.kind, kind),
          eq(schema.externalRefs.externalId, String(externalId)),
        ),
      );
    return row?.id ?? null;
  }

  async remember(kind: Kind, externalId: string | number, entityId: string) {
    await this.db
      .insert(schema.externalRefs)
      .values({ orgId: this.orgId, source: this.source, kind, externalId: String(externalId), entityId })
      .onConflictDoUpdate({
        target: [
          schema.externalRefs.orgId,
          schema.externalRefs.source,
          schema.externalRefs.kind,
          schema.externalRefs.externalId,
        ],
        set: { entityId },
      });
  }

  /**
   * Imports one item: updates the Atlas record it was imported into before (when it still exists), or creates one.
   * Failures are counted and noted, never thrown, so one bad record doesn't stop the run.
   */
  async upsert(
    kind: Kind,
    externalId: string | number,
    label: string,
    create: () => Promise<string>,
    update?: (id: string) => Promise<void>,
  ) {
    try {
      const existing = await this.ref(kind, externalId);
      if (existing && update) {
        try {
          await update(existing);
          this.count(kind, 'updated');
          return existing;
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
          // Deleted in Atlas since the last import: create it again.
        }
      } else if (existing) {
        this.count(kind, 'skipped');
        return existing;
      }
      const id = await create();
      await this.remember(kind, externalId, id);
      this.count(kind, 'created');
      return id;
    } catch (error) {
      this.count(kind, 'failed');
      const reason =
        error instanceof HttpError
          ? error.message
          : error && typeof error === 'object' && 'issues' in error
            ? String((error as { issues: { message: string }[] }).issues[0]?.message ?? 'Invalid data')
            : 'Unexpected error';
      this.note(`${kind} "${label}": ${reason}`);
      return null;
    } finally {
      if (Date.now() - this.lastFlush > 1000) await this.flush('running');
    }
  }

  async flush(status: 'running' | 'done' | 'failed') {
    this.lastFlush = Date.now();
    await this.db
      .update(schema.importJobs)
      .set({
        status,
        counts: this.counts,
        messages: this.messages,
        ...(status !== 'running' ? { finishedAt: new Date() } : {}),
      })
      .where(eq(schema.importJobs.id, this.jobId));
  }
}

const jobView = (j: typeof schema.importJobs.$inferSelect): ImportJobView => ({
  id: j.id,
  source: j.source as ImportSource,
  status: j.status as ImportJobView['status'],
  counts: j.counts as Record<string, ImportCounts>,
  messages: j.messages,
  startedByName: j.startedByName,
  createdAt: j.createdAt.toISOString(),
  finishedAt: j.finishedAt?.toISOString() ?? null,
});

export async function listJobs(db: Database, orgId: string) {
  const rows = await db
    .select()
    .from(schema.importJobs)
    .where(eq(schema.importJobs.orgId, orgId))
    .orderBy(desc(schema.importJobs.createdAt))
    .limit(20);
  return rows.map(jobView);
}

export async function getJob(db: Database, orgId: string, id: string) {
  const [row] = isUuid(id)
    ? await db
        .select()
        .from(schema.importJobs)
        .where(and(eq(schema.importJobs.id, id), eq(schema.importJobs.orgId, orgId)))
    : [];
  if (!row) throw new HttpError(404, 'Import not found.');
  return jobView(row);
}
