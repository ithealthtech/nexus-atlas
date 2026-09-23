import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { contactSchema, locationSchema, type ContactView, type LocationView } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { isUuid, type Scope } from './scope.js';

/** Contacts and locations share the same shape of rules: scoped to one client, one "primary" per client. */
function makeService<TView extends { id: string; clientId: string }>(opts: {
  table: typeof schema.contacts | typeof schema.locations;
  parse: (input: unknown) => Record<string, unknown> & { name: string; primary: boolean };
  parsePartial: (input: unknown) => Record<string, unknown> & { name?: string; primary?: boolean };
  entityType: 'contact' | 'location';
  label: string;
  view: (row: Record<string, unknown>) => TView;
}) {
  const t = opts.table;
  return {
    async list(scope: Scope, clientId: string): Promise<TView[]> {
      await scope.require(clientId, 'read', 'Client');
      const rows = await scope.db
        .select()
        .from(t)
        .where(eq(t.clientId, clientId))
        .orderBy(desc(t.primary), asc(sql`lower(${t.name})`));
      return rows.map((r) => opts.view(r as Record<string, unknown>));
    },
    async load(scope: Scope, id: string) {
      const [row] = isUuid(id)
        ? await scope.db
            .select()
            .from(t)
            .where(and(eq(t.id, id), eq(t.orgId, scope.actor.orgId)))
        : [];
      if (!row) throw new HttpError(404, `${opts.label} not found.`);
      return row;
    },
    async create(scope: Scope, clientId: string, input: unknown): Promise<TView> {
      await scope.require(clientId, 'edit', 'Client');
      const body = opts.parse(input);
      const row = await scope.db.transaction(async (tx) => {
        if (body.primary) await tx.update(t).set({ primary: false }).where(eq(t.clientId, clientId));
        const [created] = await tx
          .insert(t)
          .values({ ...body, orgId: scope.actor.orgId, clientId } as never)
          .returning();
        await recordActivity(tx, scope.actor, {
          clientId,
          action: 'Added',
          entityType: opts.entityType,
          entityId: created!.id,
          title: body.name,
        });
        return created!;
      });
      return opts.view(row as Record<string, unknown>);
    },
    async update(scope: Scope, id: string, input: unknown): Promise<TView> {
      const current = await this.load(scope, id);
      await scope.require(current.clientId, 'edit', opts.label);
      const body = opts.parsePartial(input);
      const row = await scope.db.transaction(async (tx) => {
        if (body.primary) await tx.update(t).set({ primary: false }).where(eq(t.clientId, current.clientId));
        const [updated] = await tx
          .update(t)
          .set({ ...body, updatedAt: new Date() } as never)
          .where(eq(t.id, id))
          .returning();
        await recordActivity(tx, scope.actor, {
          clientId: current.clientId,
          action: 'Updated',
          entityType: opts.entityType,
          entityId: id,
          title: (body.name as string) ?? current.name,
        });
        return updated!;
      });
      return opts.view(row as Record<string, unknown>);
    },
    async remove(scope: Scope, id: string) {
      const current = await this.load(scope, id);
      await scope.require(current.clientId, 'edit', opts.label);
      await scope.db.transaction(async (tx) => {
        await tx.delete(t).where(eq(t.id, id));
        await tx
          .delete(schema.relations)
          .where(sql`${schema.relations.aId} = ${id} or ${schema.relations.bId} = ${id}`);
        await recordActivity(tx, scope.actor, {
          clientId: current.clientId,
          action: 'Deleted',
          entityType: opts.entityType,
          entityId: null,
          title: current.name,
        });
      });
    },
  };
}

export const contacts = makeService<ContactView>({
  table: schema.contacts,
  parse: (i) => contactSchema.parse(i),
  parsePartial: (i) => contactSchema.partial().parse(i),
  entityType: 'contact',
  label: 'Contact',
  view: (r) => ({
    id: r.id as string,
    clientId: r.clientId as string,
    name: r.name as string,
    title: r.title as string,
    email: r.email as string,
    phone: r.phone as string,
    mobile: r.mobile as string,
    notes: r.notes as string,
    primary: r.primary as boolean,
    updatedAt: (r.updatedAt as Date).toISOString(),
  }),
});

export const locations = makeService<LocationView>({
  table: schema.locations,
  parse: (i) => locationSchema.parse(i),
  parsePartial: (i) => locationSchema.partial().parse(i),
  entityType: 'location',
  label: 'Location',
  view: (r) => ({
    id: r.id as string,
    clientId: r.clientId as string,
    name: r.name as string,
    address: r.address as string,
    city: r.city as string,
    region: r.region as string,
    postalCode: r.postalCode as string,
    country: r.country as string,
    phone: r.phone as string,
    notes: r.notes as string,
    primary: r.primary as boolean,
    updatedAt: (r.updatedAt as Date).toISOString(),
  }),
});
