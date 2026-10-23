import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, alertWorkspaceSchema, defaultAlertWorkspace, type AlertWorkspace, type Role } from '@atlas/shared';
import { requireAdmin } from '../../authz.js';
import { HttpError } from '../../errors.js';
import type { Scope } from '../scope.js';
import { securityEvent } from '../security-log.js';

export function requireAlertAdmin(scope: Scope) {
  requireAdmin(scope.actor);
  return scope.actor.orgId;
}

/** Draft configuration only. Delivery workers deliberately don't read this key yet. */
export class AlertWorkspaceService {
  constructor(private readonly db: Database) {}

  async read(scope: Scope): Promise<AlertWorkspace> {
    const orgId = requireAlertAdmin(scope);
    const [row] = await this.db
      .select({ value: sql<unknown>`${schema.orgs.settings}->'alerting'` })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId));
    if (!row) throw new HttpError(404, 'Organization not found.');
    return row.value == null ? defaultAlertWorkspace() : alertWorkspaceSchema.parse(row.value);
  }

  async validateReferences(scope: Scope, rules: AlertWorkspace['rules']) {
    requireAlertAdmin(scope);
    const clientIds = new Set(rules.flatMap((r) => r.clientIds));
    await Promise.all([...clientIds].map((id) => scope.require(id, 'read', 'Client')));
    const userIds = [...new Set(rules.flatMap((r) => r.emailUserIds))];
    if (!userIds.length) return;
    const users = await this.db
      .select({ id: schema.users.id, role: schema.users.role, disabled: schema.users.disabled })
      .from(schema.users)
      .where(and(eq(schema.users.orgId, scope.actor.orgId), inArray(schema.users.id, userIds)));
    if (users.length !== userIds.length || users.some((u) => u.disabled || !ROLE_INFO[u.role as Role].staff))
      throw new HttpError(400, 'Choose active staff members from this organization as email recipients.');
  }

  async save(scope: Scope, input: unknown, ip: string): Promise<AlertWorkspace> {
    const orgId = requireAlertAdmin(scope);
    const body = alertWorkspaceSchema.parse(input);
    await this.validateReferences(scope, body.rules);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ value: sql<unknown>`${schema.orgs.settings}->'alerting'` })
        .from(schema.orgs)
        .where(eq(schema.orgs.id, orgId))
        .for('update');
      if (!row) throw new HttpError(404, 'Organization not found.');
      const current = row.value == null ? defaultAlertWorkspace() : alertWorkspaceSchema.parse(row.value);
      if (current.revision !== body.revision)
        throw new HttpError(
          409,
          'Another administrator saved these drafts. Reload to see their changes before saving.',
        );
      const saved = { ...body, revision: body.revision + 1 };
      await tx
        .update(schema.orgs)
        .set({
          settings: sql`${schema.orgs.settings} || jsonb_build_object('alerting', ${JSON.stringify(saved)}::jsonb)`,
        })
        .where(eq(schema.orgs.id, orgId));
      await securityEvent(tx, {
        orgId,
        userId: scope.actor.id,
        actor: scope.actor.name,
        action: 'Alert drafts saved',
        detail: `${saved.templates.length} templates, ${saved.rules.length} rules; revision ${saved.revision}`,
        ip,
      });
      return saved;
    });
  }
}
