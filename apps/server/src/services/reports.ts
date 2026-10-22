import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  reportDefinitionSchema,
  reportTemplateSchema,
  type ReportDefinition,
  type ReportSnapshot,
  type ReportRunDetail,
  type ReportRunView,
  type ReportTemplateView,
} from '@atlas/shared';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import { requireClient } from '../authz.js';
import { type Scope, isUuid } from './scope.js';
import { collectReport, type SecuritySources } from './report-data.js';
import type { SettingsService } from './settings.js';

const runs = schema.reportRuns;
const templates = schema.reportTemplates;
const owned = (scope: Scope, table: typeof runs | typeof templates) =>
  and(eq(table.orgId, scope.actor.orgId), eq(table.ownerId, scope.actor.id));
const runColumns = {
  id: runs.id,
  title: runs.title,
  kind: runs.kind,
  createdAt: runs.createdAt,
  clients: runs.clients,
  clientIds: runs.clientIds,
  rowCount: runs.rowCount,
  warningCount: runs.warningCount,
};
const runView = (row: {
  id: string;
  title: string;
  kind: string;
  createdAt: Date;
  clients: { id: string; name: string }[];
  warningCount: number;
  rowCount: number;
}): ReportRunView => ({
  id: row.id,
  title: row.title,
  kind: row.kind as ReportRunView['kind'],
  createdAt: row.createdAt.toISOString(),
  clients: row.clients,
  warningCount: row.warningCount,
  rowCount: row.rowCount,
});
const templateView = (row: typeof templates.$inferSelect): ReportTemplateView => ({
  id: row.id,
  name: row.name,
  definition: reportDefinitionSchema.parse(row.definition),
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});
const active = new Set<string>();

export class ReportService {
  constructor(
    private settings: SettingsService,
    private fetcher?: typeof fetch,
    private security?: SecuritySources,
  ) {}
  async authorize(scope: Scope, ids: string[]) {
    for (const id of ids) await requireClient(scope.db, scope.actor, id, 'read');
  }
  async generate(scope: Scope, input: unknown): Promise<ReportRunDetail> {
    const { definition, snapshot } = await this.collect(scope, input);
    return this.store(scope, definition, snapshot);
  }
  /** Captures a snapshot without keeping it (a scheduled report that may have nothing to send). */
  async collect(scope: Scope, input: unknown) {
    const definition = reportDefinitionSchema.parse(input);
    const key = `${scope.actor.orgId}:${scope.actor.id}`;
    if (active.has(key)) throw new HttpError(409, 'A report is already running. Wait for it to finish.');
    active.add(key);
    try {
      return {
        definition,
        snapshot: await collectReport(scope, definition, this.settings, this.fetcher, this.security),
      };
    } finally {
      active.delete(key);
    }
  }
  /** Keeps a snapshot in its owner's history. */
  async store(scope: Scope, definition: ReportDefinition, snapshot: ReportSnapshot): Promise<ReportRunDetail> {
    // Client deletion takes an exclusive lock. Never insert a snapshot after its client was deleted.
    return await scope.db.transaction(async (tx) => {
      const current = await tx
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(and(eq(schema.clients.orgId, scope.actor.orgId), inArray(schema.clients.id, definition.clientIds)))
        .for('share');
      if (current.length !== definition.clientIds.length) throw new HttpError(404, 'Client not found.');
      await this.authorize(scope, definition.clientIds);
      const [row] = await tx
        .insert(runs)
        .values({
          orgId: scope.actor.orgId,
          ownerId: scope.actor.id,
          kind: definition.kind,
          title: definition.title,
          clientIds: definition.clientIds,
          clients: snapshot.clients,
          warningCount: snapshot.warnings.length,
          rowCount: snapshot.sections.reduce((n, s) => n + s.rows.length, 0),
          snapshot,
        })
        .returning();
      return { ...runView(row!), snapshot };
    });
  }
  async history(scope: Scope) {
    const allowed = await scope.readableClientIds();
    const rows = await scope.db
      .select(runColumns)
      .from(runs)
      .where(and(owned(scope, runs), sql`${runs.clientIds} <@ ${JSON.stringify(allowed)}::jsonb`))
      .orderBy(desc(runs.createdAt))
      .limit(100);
    return rows.map(runView);
  }
  async load(scope: Scope, id: string): Promise<ReportRunDetail> {
    const [row] = isUuid(id)
      ? await scope.db
          .select()
          .from(runs)
          .where(and(owned(scope, runs), eq(runs.id, id)))
      : [];
    if (!row) throw new HttpError(404, 'Report not found.');
    await this.authorize(scope, row.clientIds);
    return { ...runView(row), snapshot: row.snapshot as ReportSnapshot };
  }
  async remove(scope: Scope, id: string) {
    if (!isUuid(id)) throw new HttpError(404, 'Report not found.');
    const deleted = await scope.db
      .delete(runs)
      .where(and(owned(scope, runs), eq(runs.id, id)))
      .returning({ id: runs.id });
    if (!deleted.length) throw new HttpError(404, 'Report not found.');
  }
  async listTemplates(scope: Scope) {
    const allowed = await scope.readableClientIds();
    const rows = await scope.db
      .select()
      .from(templates)
      .where(
        and(owned(scope, templates), sql`(${templates.definition}->'clientIds') <@ ${JSON.stringify(allowed)}::jsonb`),
      )
      .orderBy(desc(templates.updatedAt))
      .limit(100);
    return rows.map(templateView);
  }
  async saveTemplate(scope: Scope, input: unknown, id?: string) {
    const body = reportTemplateSchema.parse(input);
    const version = id ? z.object({ version: z.number().int().positive() }).parse(input).version : undefined;
    if (id && !isUuid(id)) throw new HttpError(404, 'Template not found.');
    await this.authorize(scope, body.definition.clientIds);
    return scope.db.transaction(async (tx) => {
      const current = await tx
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(and(eq(schema.clients.orgId, scope.actor.orgId), inArray(schema.clients.id, body.definition.clientIds)))
        .for('share');
      if (current.length !== body.definition.clientIds.length) throw new HttpError(404, 'Client not found.');
      const rows = id
        ? await tx
            .update(templates)
            .set({ ...body, version: sql`${templates.version}+1`, updatedAt: new Date() })
            .where(and(owned(scope, templates), eq(templates.id, id), eq(templates.version, version!)))
            .returning()
        : await tx
            .insert(templates)
            .values({ ...body, orgId: scope.actor.orgId, ownerId: scope.actor.id })
            .returning();
      if (!rows.length) throw new HttpError(409, 'This template changed or was removed. Refresh and try again.');
      return templateView(rows[0]!);
    });
  }
  async removeTemplate(scope: Scope, id: string, version: number) {
    if (!isUuid(id)) throw new HttpError(404, 'Template not found.');
    const rows = await scope.db
      .delete(templates)
      .where(and(owned(scope, templates), eq(templates.id, id), eq(templates.version, version)))
      .returning({ id: templates.id });
    if (!rows.length) throw new HttpError(409, 'This template changed or was removed. Refresh and try again.');
  }
}
