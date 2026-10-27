import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  alertWorkspaceSchema,
  defaultAlertWorkspace,
  publishAlertsSchema,
  restoreAlertsSchema,
  type AlertVersion,
  type AlertVersionHistory,
  type AlertVersionSummary,
} from '@atlas/shared';
import { HttpError } from '../../errors.js';
import type { Scope } from '../scope.js';
import { securityEvent } from '../security-log.js';
import { AlertWorkspaceService, requireAlertAdmin } from './workspace.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const table = schema.alertVersions;
const summaryColumns = {
  version: table.version,
  draftRevision: table.draftRevision,
  note: table.note,
  publishedBy: table.publishedBy,
  publishedAt: table.publishedAt,
  templateCount: sql<number>`jsonb_array_length(${table.workspace}->'templates')`,
  ruleCount: sql<number>`jsonb_array_length(${table.workspace}->'rules')`,
};
const summary = (row: Omit<AlertVersionSummary, 'publishedAt'> & { publishedAt: Date }): AlertVersionSummary => ({
  ...row,
  publishedAt: row.publishedAt.toISOString(),
});

async function lockDraft(tx: Tx, orgId: string, revision: number) {
  const [row] = await tx
    .select({ value: sql<unknown>`${schema.orgs.settings}->'alerting'` })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId))
    .for('update');
  if (!row) throw new HttpError(404, 'Organization not found.');
  const workspace = row.value == null ? defaultAlertWorkspace() : alertWorkspaceSchema.parse(row.value);
  if (workspace.revision !== revision)
    throw new HttpError(409, 'Another administrator saved these drafts. Reload before publishing or restoring.');
  return workspace;
}
async function latestVersion(db: Database | Tx, orgId: string) {
  const [row] = await db
    .select({ version: table.version })
    .from(table)
    .where(eq(table.orgId, orgId))
    .orderBy(desc(table.version))
    .limit(1);
  return row?.version ?? 0;
}

export class AlertVersionService {
  constructor(private readonly db: Database) {}

  async history(scope: Scope, beforeVersion?: number): Promise<AlertVersionHistory> {
    const orgId = requireAlertAdmin(scope);
    const rows = await this.db
      .select(summaryColumns)
      .from(table)
      .where(and(eq(table.orgId, orgId), beforeVersion ? lt(table.version, beforeVersion) : undefined))
      .orderBy(desc(table.version))
      .limit(51);
    const page = rows.slice(0, 50);
    return {
      latestVersion: await latestVersion(this.db, orgId),
      versions: page.map(summary),
      nextBeforeVersion: rows.length > 50 ? page.at(-1)!.version : null,
    };
  }

  async read(scope: Scope, version: number): Promise<AlertVersion> {
    const [row] = await this.db
      .select({ ...summaryColumns, workspace: table.workspace })
      .from(table)
      .where(and(eq(table.orgId, requireAlertAdmin(scope)), eq(table.version, version)));
    if (!row) throw new HttpError(404, 'Published version not found.');
    return { ...summary(row), workspace: alertWorkspaceSchema.parse(row.workspace) };
  }

  async publish(scope: Scope, input: unknown, ip: string): Promise<AlertVersionSummary> {
    const orgId = requireAlertAdmin(scope);
    const body = publishAlertsSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const workspace = await lockDraft(tx, orgId, body.revision);
      const latest = await latestVersion(tx, orgId);
      if (latest !== body.lastVersion)
        throw new HttpError(
          409,
          'Another administrator published a version. Refresh version history before publishing.',
        );
      const [existing] = await tx
        .select({ version: table.version })
        .from(table)
        .where(and(eq(table.orgId, orgId), eq(table.draftRevision, body.revision)));
      if (existing)
        throw new HttpError(409, `These saved drafts are already published as version ${existing.version}.`);
      await new AlertWorkspaceService(this.db).validateReferences(scope, workspace.rules);
      await tx.insert(table).values({
        orgId,
        version: latest + 1,
        draftRevision: body.revision,
        workspace,
        note: body.note,
        publishedBy: scope.actor.name,
        publisherId: scope.actor.id,
      });
      await securityEvent(tx, {
        orgId,
        userId: scope.actor.id,
        actor: scope.actor.name,
        action: 'Alert version published',
        detail: `Version ${latest + 1}; draft revision ${body.revision}; ${workspace.rules.length} rules; delivery inactive`,
        ip,
      });
      const [row] = await tx
        .select(summaryColumns)
        .from(table)
        .where(and(eq(table.orgId, orgId), eq(table.version, latest + 1)));
      return summary(row!);
    });
  }

  async restore(scope: Scope, version: number, input: unknown, ip: string) {
    const orgId = requireAlertAdmin(scope);
    const body = restoreAlertsSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const current = await lockDraft(tx, orgId, body.revision);
      const [row] = await tx
        .select({ workspace: table.workspace })
        .from(table)
        .where(and(eq(table.orgId, orgId), eq(table.version, version)));
      if (!row) throw new HttpError(404, 'Published version not found.');
      // Old selections remain editable even if a client was deleted or a recipient lost access.
      const restored = alertWorkspaceSchema.parse({
        ...alertWorkspaceSchema.parse(row.workspace),
        revision: current.revision + 1,
      });
      await tx
        .update(schema.orgs)
        .set({
          settings: sql`${schema.orgs.settings} || jsonb_build_object('alerting', ${JSON.stringify(restored)}::jsonb)`,
        })
        .where(eq(schema.orgs.id, orgId));
      await securityEvent(tx, {
        orgId,
        userId: scope.actor.id,
        actor: scope.actor.name,
        action: 'Alert version restored to drafts',
        detail: `Version ${version}; new draft revision ${restored.revision}; delivery unchanged`,
        ip,
      });
      return restored;
    });
  }
}
