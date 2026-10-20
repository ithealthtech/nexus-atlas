import { randomBytes } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { createReportShareSchema, type ReportShareView, type ReportSnapshot, type SharedReport } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { isUuid, type Scope } from './scope.js';

/**
 * Sharing a report snapshot by link: anyone who has the link can see that one snapshot, without signing in, until
 * the link expires or is revoked. Meant for sending a client their own report. Only a snapshot of a single client
 * can be shared, only by the person who ran it, and only with edit access to that client; making and revoking
 * links are written to the security log.
 */
export class ReportShareService {
  constructor(
    private readonly db: Database,
    private readonly publicOrigin: string,
  ) {}

  private async run(scope: Scope, id: string) {
    const [run] = isUuid(id)
      ? await scope.db
          .select()
          .from(schema.reportRuns)
          .where(
            and(
              eq(schema.reportRuns.id, id.toLowerCase()),
              eq(schema.reportRuns.orgId, scope.actor.orgId),
              eq(schema.reportRuns.ownerId, scope.actor.id),
            ),
          )
      : [];
    if (!run) throw new HttpError(404, 'Report not found.');
    // Shared outside Atlas, a report must be about one client only, someone this person may change.
    if (run.clientIds.length !== 1)
      throw new HttpError(400, 'Only a report for a single client can be shared. Run it for one client.');
    await scope.require(run.clientIds[0]!, 'edit', 'Report');
    return run;
  }

  private view(row: typeof schema.reportShares.$inferSelect, createdByName: string | null): ReportShareView {
    return {
      id: row.id,
      url: `${this.publicOrigin}/report/${row.token}`,
      createdByName,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      views: row.views,
      lastViewedAt: row.lastViewedAt?.toISOString() ?? null,
      status: row.revokedAt ? 'revoked' : row.expiresAt.getTime() < Date.now() ? 'expired' : 'active',
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

  async list(scope: Scope, runId: string): Promise<ReportShareView[]> {
    const run = await this.run(scope, runId);
    const rows = await scope.db
      .select({ share: schema.reportShares, name: schema.users.name })
      .from(schema.reportShares)
      .leftJoin(schema.users, eq(schema.users.id, schema.reportShares.createdBy))
      .where(eq(schema.reportShares.runId, run.id))
      .orderBy(desc(schema.reportShares.createdAt));
    return rows.map((r) => this.view(r.share, r.name));
  }

  async create(scope: Scope, runId: string, input: unknown, ip: string): Promise<ReportShareView> {
    const run = await this.run(scope, runId);
    const body = createReportShareSchema.parse(input ?? {});
    const [row] = await scope.db
      .insert(schema.reportShares)
      .values({
        orgId: scope.actor.orgId,
        runId: run.id,
        token: randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + body.expiresDays * 86_400_000),
        createdBy: scope.actor.id,
      })
      .returning();
    await this.event(
      scope,
      'Report shared by link',
      `${run.title} for ${run.clients[0]?.name ?? 'a client'} (expires in ${body.expiresDays} days)`,
      ip,
    );
    return this.view(row!, scope.actor.name);
  }

  async revoke(scope: Scope, shareId: string, ip: string) {
    const [share] = isUuid(shareId)
      ? await scope.db
          .select()
          .from(schema.reportShares)
          .where(and(eq(schema.reportShares.id, shareId), eq(schema.reportShares.orgId, scope.actor.orgId)))
      : [];
    if (!share) throw new HttpError(404, 'Link not found.');
    const run = await this.run(scope, share.runId);
    if (!share.revokedAt) {
      await scope.db
        .update(schema.reportShares)
        .set({ revokedAt: new Date() })
        .where(eq(schema.reportShares.id, shareId));
      await this.event(scope, 'Report link revoked', `${run.title} for ${run.clients[0]?.name ?? 'a client'}`, ip);
    }
    return this.list(scope, share.runId);
  }

  /** The snapshot behind a link. A revoked or expired link, or one whose report is gone, looks like no link at all. */
  async open(
    token: string,
  ): Promise<{ orgId: string; organization: string; expiresAt: Date; snapshot: ReportSnapshot }> {
    const missing = new HttpError(404, 'This link doesn’t work any more, or was copied incompletely.');
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw missing;
    const [row] = await this.db
      .select({ share: schema.reportShares, snapshot: schema.reportRuns.snapshot, org: schema.orgs.name })
      .from(schema.reportShares)
      .innerJoin(schema.reportRuns, eq(schema.reportRuns.id, schema.reportShares.runId))
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.reportShares.orgId))
      .where(eq(schema.reportShares.token, token));
    if (!row || row.share.revokedAt || row.share.expiresAt.getTime() < Date.now()) throw missing;
    await this.db
      .update(schema.reportShares)
      .set({ views: sql`${schema.reportShares.views} + 1`, lastViewedAt: new Date() })
      .where(eq(schema.reportShares.id, row.share.id));
    return {
      orgId: row.share.orgId,
      organization: row.org,
      expiresAt: row.share.expiresAt,
      snapshot: row.snapshot as ReportSnapshot,
    };
  }

  /** What the public page gets: no one's name, no IDs, no report settings. */
  shared(shared: Awaited<ReturnType<ReportShareService['open']>>): SharedReport {
    const { snapshot } = shared;
    return {
      title: snapshot.definition.title,
      organization: snapshot.organization || shared.organization,
      client: snapshot.clients[0]?.name ?? '',
      generatedAt: snapshot.generatedAt,
      expiresAt: shared.expiresAt.toISOString(),
      sections: snapshot.sections,
      warnings: snapshot.warnings,
      sources: snapshot.sources,
    };
  }
}
