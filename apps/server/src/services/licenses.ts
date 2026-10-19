import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { licenseSchema, licenseUpdateSchema, type LicenseView } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { type Scope, isUuid } from './scope.js';

const t = schema.licenses;
const view = (row: typeof t.$inferSelect): LicenseView => ({
  ...licenseSchema.parse(row),
  id: row.id,
  clientId: row.clientId,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});
export class LicenseService {
  async list(scope: Scope, clientId: string) {
    await scope.require(clientId, 'read', 'Client');
    return (
      await scope.db
        .select()
        .from(t)
        .where(and(eq(t.orgId, scope.actor.orgId), eq(t.clientId, clientId)))
        .orderBy(asc(t.name))
    ).map(view);
  }
  async create(scope: Scope, clientId: string, input: unknown) {
    await scope.require(clientId, 'edit', 'Client');
    const body = licenseSchema.parse(input);
    return scope.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(t)
        .values({ ...body, orgId: scope.actor.orgId, clientId })
        .returning();
      await recordActivity(tx, scope.actor, {
        clientId,
        action: 'Added',
        entityType: 'license',
        entityId: row!.id,
        title: body.name,
      });
      return view(row!);
    });
  }
  async load(scope: Scope, clientId: string, id: string) {
    await scope.require(clientId, 'edit', 'Client');
    const [row] = isUuid(id)
      ? await scope.db
          .select()
          .from(t)
          .where(and(eq(t.id, id), eq(t.clientId, clientId), eq(t.orgId, scope.actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'License not found.');
    return row;
  }
  async update(scope: Scope, clientId: string, id: string, input: unknown) {
    await this.load(scope, clientId, id);
    const { license, version } = licenseUpdateSchema.parse(input);
    return scope.db.transaction(async (tx) => {
      const [row] = await tx
        .update(t)
        .set({ ...license, version: sql`${t.version} + 1`, updatedAt: new Date() })
        .where(and(eq(t.id, id), eq(t.clientId, clientId), eq(t.orgId, scope.actor.orgId), eq(t.version, version)))
        .returning();
      if (!row) throw new HttpError(409, 'This subscription changed. Refresh and try again.');
      await recordActivity(tx, scope.actor, {
        clientId,
        action: 'Updated',
        entityType: 'license',
        entityId: id,
        title: row.name,
      });
      return view(row);
    });
  }
  async remove(scope: Scope, clientId: string, id: string, version: number) {
    const current = await this.load(scope, clientId, id);
    await scope.db.transaction(async (tx) => {
      const rows = await tx
        .delete(t)
        .where(and(eq(t.id, id), eq(t.clientId, clientId), eq(t.orgId, scope.actor.orgId), eq(t.version, version)))
        .returning();
      if (!rows.length) throw new HttpError(409, 'This subscription changed. Refresh and try again.');
      await recordActivity(tx, scope.actor, {
        clientId,
        action: 'Deleted',
        entityType: 'license',
        entityId: null,
        title: current.name,
      });
    });
  }
}
