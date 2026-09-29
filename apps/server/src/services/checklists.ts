import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  ROLE_INFO,
  atLeast,
  checklistSchema,
  startRunSchema,
  tickStepSchema,
  updateChecklistSchema,
  updateRunSchema,
  type ChecklistView,
  type Role,
  type RunView,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { recordActivity } from './activity.js';
import { isUuid, type Scope } from './scope.js';

type ChecklistRow = typeof schema.checklists.$inferSelect;
type RunRow = typeof schema.checklistRuns.$inferSelect;

/**
 * Checklists are reusable lists of steps: the MSP's own (no client) or one client's. Running one for a client
 * copies its steps, so later edits to the template don't change work already done, and each tick records who
 * and when.
 */
export class ChecklistService {
  // ---- templates ----
  async list(scope: Scope, filter: { clientId?: string | 'global'; archived?: boolean }): Promise<ChecklistView[]> {
    const conditions: SQL[] = [
      eq(schema.checklists.orgId, scope.actor.orgId),
      eq(schema.checklists.archived, !!filter.archived),
    ];
    if (filter.clientId === 'global') {
      if (!scope.canReadGlobal) return [];
      conditions.push(isNull(schema.checklists.clientId));
    } else if (filter.clientId) {
      await scope.require(filter.clientId, 'read', 'Client');
      // A client's list also offers the MSP's checklists, which can be run for any client.
      conditions.push(
        scope.canReadGlobal
          ? or(eq(schema.checklists.clientId, filter.clientId), isNull(schema.checklists.clientId))!
          : eq(schema.checklists.clientId, filter.clientId),
      );
    } else {
      const ids = await scope.readableClientIds();
      const visible = [
        ids.length ? inArray(schema.checklists.clientId, ids) : undefined,
        scope.canReadGlobal ? isNull(schema.checklists.clientId) : undefined,
      ].filter(Boolean) as SQL[];
      if (!visible.length) return [];
      conditions.push(or(...visible)!);
    }
    const rows = await scope.db
      .select({ c: schema.checklists, clientName: schema.clients.name })
      .from(schema.checklists)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.checklists.clientId))
      .where(and(...conditions))
      .orderBy(asc(sql`lower(${schema.checklists.title})`));
    const out: ChecklistView[] = [];
    for (const r of rows) out.push(await this.view(scope, r.c, r.clientName));
    return out;
  }

  private async view(scope: Scope, c: ChecklistRow, clientName: string | null): Promise<ChecklistView> {
    return {
      id: c.id,
      clientId: c.clientId,
      clientName,
      title: c.title,
      description: c.description,
      steps: c.steps,
      archived: c.archived,
      updatedAt: c.updatedAt.toISOString(),
      canEdit: atLeast(await scope.level(c.clientId), 'edit'),
    };
  }

  private async load(scope: Scope, id: string, level: 'read' | 'edit') {
    const [row] = isUuid(id)
      ? await scope.db
          .select({ c: schema.checklists, clientName: schema.clients.name })
          .from(schema.checklists)
          .leftJoin(schema.clients, eq(schema.clients.id, schema.checklists.clientId))
          .where(and(eq(schema.checklists.id, id), eq(schema.checklists.orgId, scope.actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'Checklist not found.');
    await scope.require(row.c.clientId, level, 'Checklist');
    return row;
  }

  async get(scope: Scope, id: string) {
    const row = await this.load(scope, id, 'read');
    return this.view(scope, row.c, row.clientName);
  }

  async create(scope: Scope, input: unknown): Promise<ChecklistView> {
    const body = checklistSchema.parse(input);
    await scope.require(body.clientId, 'edit', 'Client');
    const [c] = await scope.db
      .insert(schema.checklists)
      .values({
        orgId: scope.actor.orgId,
        clientId: body.clientId,
        title: body.title,
        description: body.description,
        steps: body.steps.map((s) => ({ id: s.id || randomUUID(), text: s.text })),
        createdBy: scope.actor.id,
        updatedBy: scope.actor.id,
      })
      .returning();
    await recordActivity(scope.db, scope.actor, {
      clientId: body.clientId,
      action: 'Created',
      entityType: 'checklist',
      entityId: c!.id,
      title: c!.title,
    });
    return this.get(scope, c!.id);
  }

  async update(scope: Scope, id: string, input: unknown): Promise<ChecklistView> {
    const { c } = await this.load(scope, id, 'edit');
    const body = updateChecklistSchema.parse(input);
    await scope.db
      .update(schema.checklists)
      .set({
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.steps && { steps: body.steps.map((s) => ({ id: s.id || randomUUID(), text: s.text })) }),
        updatedBy: scope.actor.id,
        updatedAt: new Date(),
      })
      .where(eq(schema.checklists.id, id));
    await recordActivity(scope.db, scope.actor, {
      clientId: c.clientId,
      action: 'Updated',
      entityType: 'checklist',
      entityId: id,
      title: body.title ?? c.title,
    });
    return this.get(scope, id);
  }

  async archive(scope: Scope, id: string, archived: boolean): Promise<ChecklistView> {
    const { c } = await this.load(scope, id, 'edit');
    await scope.db
      .update(schema.checklists)
      .set({ archived, updatedBy: scope.actor.id, updatedAt: new Date() })
      .where(eq(schema.checklists.id, id));
    await recordActivity(scope.db, scope.actor, {
      clientId: c.clientId,
      action: archived ? 'Archived' : 'Restored',
      entityType: 'checklist',
      entityId: id,
      title: c.title,
    });
    return this.get(scope, id);
  }

  /** People a run can be assigned to: active staff. Offered to staff only. */
  async team(scope: Scope): Promise<{ id: string; name: string }[]> {
    if (!scope.canReadGlobal) throw new HttpError(403, 'Only staff assign checklists.');
    const rows = await scope.db
      .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role })
      .from(schema.users)
      .where(and(eq(schema.users.orgId, scope.actor.orgId), eq(schema.users.disabled, false)))
      .orderBy(asc(sql`lower(${schema.users.name})`));
    return rows.filter((u) => ROLE_INFO[u.role as Role].staff).map(({ id, name }) => ({ id, name }));
  }

  // ---- runs ----
  private runSelect(scope: Scope) {
    return scope.db
      .select({ r: schema.checklistRuns, clientName: schema.clients.name })
      .from(schema.checklistRuns)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.checklistRuns.clientId));
  }

  private async runViews(scope: Scope, rows: { r: RunRow; clientName: string }[]): Promise<RunView[]> {
    const ids = new Set<string>();
    for (const { r } of rows) {
      if (r.assigneeId) ids.add(r.assigneeId);
      if (r.createdBy) ids.add(r.createdBy);
      for (const s of r.steps) if (s.doneBy) ids.add(s.doneBy);
    }
    const names = new Map(
      ids.size
        ? (
            await scope.db
              .select({ id: schema.users.id, name: schema.users.name })
              .from(schema.users)
              .where(inArray(schema.users.id, [...ids]))
          ).map((u) => [u.id, u.name])
        : [],
    );
    const out: RunView[] = [];
    for (const { r, clientName } of rows) {
      const done = r.steps.filter((s) => s.doneAt).length;
      out.push({
        id: r.id,
        clientId: r.clientId,
        clientName,
        checklistId: r.checklistId,
        title: r.title,
        steps: r.steps.map((s) => ({ ...s, doneByName: s.doneBy ? (names.get(s.doneBy) ?? null) : null })),
        done,
        total: r.steps.length,
        assigneeId: r.assigneeId,
        assigneeName: r.assigneeId ? (names.get(r.assigneeId) ?? null) : null,
        dueDate: r.dueDate,
        completedAt: r.completedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        createdByName: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
        canEdit: atLeast(await scope.level(r.clientId), 'edit'),
      });
    }
    return out;
  }

  /** Runs for one client, or across every client the actor can see; open ones first. */
  async runs(
    scope: Scope,
    filter: { clientId?: string; assignee?: 'me'; state?: 'open' | 'done' },
  ): Promise<RunView[]> {
    const conditions: SQL[] = [eq(schema.checklistRuns.orgId, scope.actor.orgId)];
    if (filter.clientId) {
      await scope.require(filter.clientId, 'read', 'Client');
      conditions.push(eq(schema.checklistRuns.clientId, filter.clientId));
    } else {
      const ids = await scope.readableClientIds();
      if (!ids.length) return [];
      conditions.push(inArray(schema.checklistRuns.clientId, ids));
    }
    if (filter.assignee === 'me') conditions.push(eq(schema.checklistRuns.assigneeId, scope.actor.id));
    if (filter.state === 'open') conditions.push(isNull(schema.checklistRuns.completedAt));
    if (filter.state === 'done') conditions.push(isNotNull(schema.checklistRuns.completedAt));
    const rows = await this.runSelect(scope)
      .where(and(...conditions))
      .orderBy(
        sql`${schema.checklistRuns.completedAt} is not null`,
        sql`${schema.checklistRuns.dueDate} asc nulls last`,
        desc(schema.checklistRuns.createdAt),
      )
      .limit(500);
    return this.runViews(scope, rows);
  }

  private async loadRun(scope: Scope, id: string, level: 'read' | 'edit') {
    const [row] = isUuid(id)
      ? await this.runSelect(scope).where(
          and(eq(schema.checklistRuns.id, id), eq(schema.checklistRuns.orgId, scope.actor.orgId)),
        )
      : [];
    if (!row) throw new HttpError(404, 'Checklist run not found.');
    await scope.require(row.r.clientId, level, 'Checklist run');
    return row;
  }

  async run(scope: Scope, id: string): Promise<RunView> {
    return (await this.runViews(scope, [await this.loadRun(scope, id, 'read')]))[0]!;
  }

  private async checkAssignee(scope: Scope, assigneeId: string | null | undefined) {
    if (!assigneeId) return;
    const [user] = await scope.db
      .select({ role: schema.users.role, disabled: schema.users.disabled })
      .from(schema.users)
      .where(and(eq(schema.users.id, assigneeId), eq(schema.users.orgId, scope.actor.orgId)));
    if (!user || user.disabled || !ROLE_INFO[user.role as Role].staff)
      throw new HttpError(400, 'Assign the checklist to someone on your team.', undefined, {
        assigneeId: 'Choose someone on your team.',
      });
  }

  async start(scope: Scope, clientId: string, input: unknown): Promise<RunView> {
    const body = startRunSchema.parse(input);
    await scope.require(clientId, 'edit', 'Client');
    await this.checkAssignee(scope, body.assigneeId);
    let title = body.title ?? '';
    let steps: { id: string; text: string }[] = (body.steps ?? []).map((text) => ({ id: randomUUID(), text }));
    if (body.checklistId) {
      const { c } = await this.load(scope, body.checklistId, 'read');
      if (c.archived) throw new HttpError(400, 'That checklist is archived.');
      if (c.clientId && c.clientId !== clientId) throw new HttpError(400, 'That checklist belongs to another client.');
      title = body.title ?? c.title;
      steps = c.steps.map((s) => ({ id: s.id, text: s.text }));
    }
    const [run] = await scope.db
      .insert(schema.checklistRuns)
      .values({
        orgId: scope.actor.orgId,
        clientId,
        checklistId: body.checklistId ?? null,
        title,
        steps: steps.map((s) => ({ ...s, doneAt: null, doneBy: null, note: '' })),
        assigneeId: body.assigneeId,
        dueDate: body.dueDate,
        createdBy: scope.actor.id,
      })
      .returning();
    await recordActivity(scope.db, scope.actor, {
      clientId,
      action: 'Started',
      entityType: 'checklist_run',
      entityId: run!.id,
      title,
    });
    return this.run(scope, run!.id);
  }

  async updateRun(scope: Scope, id: string, input: unknown): Promise<RunView> {
    await this.loadRun(scope, id, 'edit');
    const body = updateRunSchema.parse(input);
    await this.checkAssignee(scope, body.assigneeId);
    await scope.db
      .update(schema.checklistRuns)
      .set({
        ...(body.title !== undefined && { title: body.title }),
        ...(body.assigneeId !== undefined && { assigneeId: body.assigneeId }),
        ...(body.dueDate !== undefined && { dueDate: body.dueDate }),
        updatedAt: new Date(),
      })
      .where(eq(schema.checklistRuns.id, id));
    return this.run(scope, id);
  }

  /** Ticks or unticks one step. The run is complete when every step is done, and reopens if one is unticked. */
  async tick(scope: Scope, id: string, stepId: string, input: unknown): Promise<RunView> {
    const body = tickStepSchema.parse(input);
    return scope.db.transaction(async (tx) => {
      // Lock the row so two people ticking at once don't overwrite each other's steps.
      const [locked] = await tx
        .select()
        .from(schema.checklistRuns)
        .where(and(eq(schema.checklistRuns.id, id), eq(schema.checklistRuns.orgId, scope.actor.orgId)))
        .for('update');
      if (!locked) throw new HttpError(404, 'Checklist run not found.');
      await scope.require(locked.clientId, 'edit', 'Checklist run');
      const step = locked.steps.find((s) => s.id === stepId);
      if (!step) throw new HttpError(404, 'Step not found.');
      const now = new Date().toISOString();
      const steps = locked.steps.map((s) =>
        s.id !== stepId
          ? s
          : {
              ...s,
              doneAt: body.done ? (s.doneAt ?? now) : null,
              doneBy: body.done ? (s.doneBy ?? scope.actor.id) : null,
              note: body.note ?? s.note,
            },
      );
      const complete = steps.every((s) => s.doneAt);
      await tx
        .update(schema.checklistRuns)
        .set({
          steps,
          completedAt: complete ? (locked.completedAt ?? new Date()) : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.checklistRuns.id, id));
      if (complete && !locked.completedAt)
        await recordActivity(tx, scope.actor, {
          clientId: locked.clientId,
          action: 'Completed',
          entityType: 'checklist_run',
          entityId: id,
          title: locked.title,
        });
      const [row] = await tx
        .select({ r: schema.checklistRuns, clientName: schema.clients.name })
        .from(schema.checklistRuns)
        .innerJoin(schema.clients, eq(schema.clients.id, schema.checklistRuns.clientId))
        .where(eq(schema.checklistRuns.id, id));
      return (await this.runViews(scope, [row!]))[0]!;
    });
  }

  async removeRun(scope: Scope, id: string) {
    const { r } = await this.loadRun(scope, id, 'edit');
    await scope.db.delete(schema.checklistRuns).where(eq(schema.checklistRuns.id, id));
    await recordActivity(scope.db, scope.actor, {
      clientId: r.clientId,
      action: 'Deleted',
      entityType: 'checklist_run',
      entityId: null,
      title: r.title,
    });
  }

  /** The run as Markdown: a record of what was done, by whom and when. */
  async markdown(scope: Scope, id: string): Promise<{ filename: string; body: string }> {
    const run = await this.run(scope, id);
    const lines = [
      `# ${run.title}`,
      '',
      `- Client: ${run.clientName}`,
      `- Started: ${run.createdAt.slice(0, 10)}${run.createdByName ? ` by ${run.createdByName}` : ''}`,
      ...(run.assigneeName ? [`- Assigned to: ${run.assigneeName}`] : []),
      ...(run.dueDate ? [`- Due: ${run.dueDate}`] : []),
      `- Progress: ${run.done} of ${run.total} steps${run.completedAt ? `, completed ${run.completedAt.slice(0, 10)}` : ''}`,
      '',
      ...run.steps.flatMap((s) => [
        `- [${s.doneAt ? 'x' : ' '}] ${s.text.replace(/\n/g, ' ')}${
          s.doneAt ? ` — ${s.doneByName ?? 'someone'}, ${s.doneAt.slice(0, 16).replace('T', ' ')} UTC` : ''
        }`,
        ...(s.note ? [`  - Note: ${s.note.replace(/\n/g, ' ')}`] : []),
      ]),
      '',
    ];
    const slug =
      run.title
        .replace(/[^\w-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'checklist';
    return { filename: `${slug}.md`, body: lines.join('\n') };
  }
}
