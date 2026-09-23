import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { createClientSchema, updateClientSchema, type Actor, type ClientSummary } from '@atlas/shared';
import { clientLevels, requireAllClientsEdit, requireClient } from '../authz.js';

type ClientRow = typeof schema.clients.$inferSelect;
const view = (c: ClientRow, access: ClientSummary['access']): ClientSummary => ({
  id: c.id,
  name: c.name,
  type: c.type,
  status: c.status as ClientSummary['status'],
  notes: c.notes,
  access,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export class ClientService {
  constructor(private readonly db: Database) {}

  async list(actor: Actor): Promise<ClientSummary[]> {
    const levels = await clientLevels(this.db, actor);
    const rows = await this.db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.orgId, actor.orgId))
      .orderBy(sql`lower(${schema.clients.name})`);
    return rows.filter((c) => (levels.get(c.id) ?? 'none') !== 'none').map((c) => view(c, levels.get(c.id)!));
  }

  async get(actor: Actor, id: string): Promise<ClientSummary> {
    const { client, level } = await requireClient(this.db, actor, id, 'read');
    return view(client, level);
  }

  async create(actor: Actor, input: unknown): Promise<ClientSummary> {
    requireAllClientsEdit(actor);
    const body = createClientSchema.parse(input);
    const [client] = await this.db
      .insert(schema.clients)
      .values({ ...body, orgId: actor.orgId })
      .returning();
    return this.get(actor, client!.id);
  }

  async update(actor: Actor, id: string, input: unknown): Promise<ClientSummary> {
    await requireClient(this.db, actor, id, 'edit');
    const body = updateClientSchema.parse(input);
    await this.db
      .update(schema.clients)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(schema.clients.id, id), eq(schema.clients.orgId, actor.orgId)));
    return this.get(actor, id);
  }
}
