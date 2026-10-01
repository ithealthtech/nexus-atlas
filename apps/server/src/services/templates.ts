import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  CHECKLIST_TEMPLATES,
  RUNBOOK_TEMPLATES,
  addTemplatesSchema,
  runbookContent,
  type TemplateView,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { ChecklistService } from './checklists.js';
import type { DocumentService } from './documents.js';
import type { Scope } from './scope.js';

const RUNBOOK_FOLDER = 'Runbooks';

/**
 * The built-in library of checklists and runbooks. Adding a template copies it into the MSP's own checklists or
 * knowledge base (runbooks go in a Runbooks folder), where it's edited like anything else. Which templates were
 * added is kept in the organization's settings, so adding again skips them while their copy still exists, even
 * if it was renamed or archived; one whose copy was deleted can be added again.
 */
export class TemplateService {
  constructor(
    private readonly checklists: ChecklistService,
    private readonly documents: DocumentService,
  ) {}

  /** Each template's copy, for those whose copy still exists. */
  private async added(scope: Scope): Promise<Map<string, string>> {
    const [org] = await scope.db
      .select({ added: sql<Record<string, string> | null>`${schema.orgs.settings} -> 'templates'` })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, scope.actor.orgId));
    const map = org?.added ?? {};
    const ids = Object.values(map).filter((v) => typeof v === 'string');
    if (!ids.length) return new Map();
    const where = (table: typeof schema.checklists | typeof schema.documents) =>
      and(eq(table.orgId, scope.actor.orgId), inArray(table.id, ids));
    const existing = new Set(
      [
        ...(await scope.db
          .select({ id: schema.checklists.id })
          .from(schema.checklists)
          .where(where(schema.checklists))),
        ...(await scope.db.select({ id: schema.documents.id }).from(schema.documents).where(where(schema.documents))),
      ].map((r) => r.id),
    );
    return new Map(Object.entries(map).filter(([, id]) => existing.has(id)));
  }

  async list(scope: Scope): Promise<TemplateView[]> {
    if (!scope.canReadGlobal) throw new HttpError(403, 'Only staff use the template library.');
    const added = await this.added(scope);
    return [
      ...CHECKLIST_TEMPLATES.map((t) => ({
        key: t.key,
        kind: 'checklist' as const,
        title: t.title,
        description: t.description,
        size: t.steps.length,
        addedId: added.get(t.key) ?? null,
      })),
      ...RUNBOOK_TEMPLATES.map((t) => ({
        key: t.key,
        kind: 'runbook' as const,
        title: t.title,
        description: t.description,
        size: t.body.filter((b) => 'h' in b).length,
        addedId: added.get(t.key) ?? null,
      })),
    ];
  }

  /** Adds the chosen templates (all when none are named) that aren't already added. */
  async add(scope: Scope, input: unknown): Promise<TemplateView[]> {
    const { keys } = addTemplatesSchema.parse(input ?? {});
    await scope.require(null, 'edit', 'Knowledge base');
    const wanted = (key: string) => !keys || keys.includes(key);
    const added = await this.added(scope);
    const made: Record<string, string> = {};
    for (const t of CHECKLIST_TEMPLATES)
      if (wanted(t.key) && !added.has(t.key))
        made[t.key] = (
          await this.checklists.create(scope, {
            title: t.title,
            description: t.description,
            steps: t.steps.map((text) => ({ text })),
          })
        ).id;
    let folderId: string | null = null;
    for (const t of RUNBOOK_TEMPLATES)
      if (wanted(t.key) && !added.has(t.key)) {
        folderId ??= await this.runbookFolder(scope);
        made[t.key] = (
          await this.documents.create(scope, { title: t.title, folderId, content: runbookContent(t.body) })
        ).id;
      }
    if (Object.keys(made).length)
      await scope.db
        .update(schema.orgs)
        .set({
          settings: sql`jsonb_set(${schema.orgs.settings}, '{templates}', coalesce(${schema.orgs.settings} -> 'templates', '{}'::jsonb) || ${JSON.stringify(made)}::jsonb)`,
        })
        .where(eq(schema.orgs.id, scope.actor.orgId));
    return this.list(scope);
  }

  /** The MSP knowledge base's Runbooks folder, made if it isn't there. */
  private async runbookFolder(scope: Scope): Promise<string> {
    const [folder] = await scope.db
      .select({ id: schema.folders.id })
      .from(schema.folders)
      .where(
        and(
          eq(schema.folders.orgId, scope.actor.orgId),
          isNull(schema.folders.clientId),
          eq(schema.folders.name, RUNBOOK_FOLDER),
        ),
      );
    return folder?.id ?? (await this.documents.createFolder(scope, { name: RUNBOOK_FOLDER })).id;
  }
}
