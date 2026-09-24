import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, groupSchema, levelRank, type AccessLevel, type Actor, type GroupView } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { isUuid } from './scope.js';

/**
 * Groups give their members per-client access in one place. A member's effective level is still capped by
 * their role, so adding a read-only technician to an "edit + passwords" group gives them read access.
 */
export class GroupService {
  constructor(private readonly db: Database) {}

  async list(actor: Actor): Promise<GroupView[]> {
    requireAdmin(actor);
    const groups = await this.db
      .select()
      .from(schema.groups)
      .where(eq(schema.groups.orgId, actor.orgId))
      .orderBy(sql`lower(${schema.groups.name})`);
    if (!groups.length) return [];
    const ids = groups.map((g) => g.id);
    const [members, grants] = await Promise.all([
      this.db.select().from(schema.groupMembers).where(inArray(schema.groupMembers.groupId, ids)),
      this.db
        .select()
        .from(schema.clientAccess)
        .where(and(isNotNull(schema.clientAccess.groupId), inArray(schema.clientAccess.groupId, ids))),
    ]);
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      memberIds: members.filter((m) => m.groupId === g.id).map((m) => m.userId),
      grants: grants
        .filter((a) => a.groupId === g.id)
        .map((a) => ({ clientId: a.clientId, level: a.level as AccessLevel })),
      updatedAt: g.updatedAt.toISOString(),
    }));
  }

  private async validate(actor: Actor, input: unknown) {
    const body = groupSchema.parse(input);
    const memberIds = [...new Set(body.memberIds)];
    const grants = [...new Map(body.grants.filter((g) => g.level !== 'none').map((g) => [g.clientId, g.level]))].map(
      ([clientId, level]) => ({ clientId, level }),
    );
    if (memberIds.length) {
      const users = await this.db
        .select({ id: schema.users.id, role: schema.users.role })
        .from(schema.users)
        .where(and(eq(schema.users.orgId, actor.orgId), inArray(schema.users.id, memberIds)));
      if (users.length !== memberIds.length) throw new HttpError(400, 'Choose people from this workspace.');
      // Client accounts belong to one client; group access would be too easy to over-grant.
      if (users.some((u) => !ROLE_INFO[u.role as Actor['role']].staff))
        throw new HttpError(400, 'Groups are for staff. Give client accounts access on the Users page.');
    }
    if (grants.length) {
      const found = await this.db
        .select({ id: schema.clients.id })
        .from(schema.clients)
        .where(
          and(
            eq(schema.clients.orgId, actor.orgId),
            inArray(
              schema.clients.id,
              grants.map((g) => g.clientId),
            ),
          ),
        );
      if (found.length !== grants.length) throw new HttpError(400, 'Choose clients from this workspace.');
    }
    return { ...body, memberIds, grants: grants.filter((g) => levelRank(g.level) > 0) };
  }

  private async write(tx: Database, groupId: string, body: Awaited<ReturnType<GroupService['validate']>>) {
    await tx.delete(schema.groupMembers).where(eq(schema.groupMembers.groupId, groupId));
    if (body.memberIds.length)
      await tx.insert(schema.groupMembers).values(body.memberIds.map((userId) => ({ groupId, userId })));
    await tx.delete(schema.clientAccess).where(eq(schema.clientAccess.groupId, groupId));
    if (body.grants.length) await tx.insert(schema.clientAccess).values(body.grants.map((g) => ({ ...g, groupId })));
  }

  private event(tx: Database, actor: Actor, action: string, detail: string, ip: string) {
    return tx.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action,
      detail: detail.slice(0, 300),
      ip,
    });
  }

  private unique(error: unknown): never {
    const e = error as { code?: string; cause?: { code?: string } };
    if (e?.code === '23505' || e?.cause?.code === '23505')
      throw new HttpError(409, 'A group with this name already exists.');
    throw error;
  }

  async create(actor: Actor, input: unknown, ip: string): Promise<GroupView> {
    requireAdmin(actor);
    const body = await this.validate(actor, input);
    const id = await this.db
      .transaction(async (tx) => {
        const [group] = await tx
          .insert(schema.groups)
          .values({ orgId: actor.orgId, name: body.name, description: body.description })
          .returning();
        await this.write(tx, group!.id, body);
        await this.event(
          tx,
          actor,
          'Group created',
          `${body.name} · ${body.memberIds.length} members · ${body.grants.length} clients`,
          ip,
        );
        return group!.id;
      })
      .catch((e) => this.unique(e));
    return (await this.list(actor)).find((g) => g.id === id)!;
  }

  async update(actor: Actor, id: string, input: unknown, ip: string): Promise<GroupView> {
    requireAdmin(actor);
    await this.find(actor, id);
    const body = await this.validate(actor, input);
    await this.db
      .transaction(async (tx) => {
        await tx
          .update(schema.groups)
          .set({ name: body.name, description: body.description, updatedAt: new Date() })
          .where(eq(schema.groups.id, id));
        await this.write(tx, id, body);
        await this.event(
          tx,
          actor,
          'Group updated',
          `${body.name} · ${body.memberIds.length} members · ${body.grants.length} clients`,
          ip,
        );
      })
      .catch((e) => this.unique(e));
    return (await this.list(actor)).find((g) => g.id === id)!;
  }

  async remove(actor: Actor, id: string, ip: string) {
    requireAdmin(actor);
    const group = await this.find(actor, id);
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.groups).where(eq(schema.groups.id, id));
      await this.event(tx, actor, 'Group deleted', group.name, ip);
    });
  }

  private async find(actor: Actor, id: string) {
    const [group] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.groups)
          .where(and(eq(schema.groups.id, id), eq(schema.groups.orgId, actor.orgId)))
      : [];
    if (!group) throw new HttpError(404, 'Group not found.');
    return group;
  }
}
