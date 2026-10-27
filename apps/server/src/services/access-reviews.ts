import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  LEVEL_INFO,
  ROLE_INFO,
  accessDecisionSchema,
  levelRank,
  signOffSchema,
  type AccessLevel,
  type AccessReviewItem,
  type AccessReviewView,
  type ReportSnapshot,
  type Role,
} from '@atlas/shared';
import { baselineLevel, clientLevels, requireAdmin, requireClient } from '../authz.js';
import { HttpError } from '../errors.js';
import { actorFor, hasMfa } from '../identity/service.js';
import { reportPdf, type ReportBrand } from './report-export.js';
import type { Scope } from './scope.js';
import { securityEvent } from './security-log.js';

type Row = typeof schema.accessReviews.$inferSelect;

/**
 * Access reviews for a client: an administrator goes through everyone who can open it, keeps or removes each
 * person, and signs it off. The signed review is the evidence, as a PDF. Administrators only, since it lists the
 * team and changes access.
 */
export class AccessReviewService {
  constructor(private readonly db: Database) {}

  /** Everyone who can open the client now, highest access first, with where that access comes from. */
  private async people(orgId: string, clientId: string): Promise<AccessReviewItem[]> {
    const users = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.disabled, false)));
    const grants = await this.db
      .select({ userId: schema.clientAccess.userId, groupId: schema.clientAccess.groupId })
      .from(schema.clientAccess)
      .where(eq(schema.clientAccess.clientId, clientId));
    const groupIds = grants.flatMap((g) => (g.groupId ? [g.groupId] : []));
    const members = groupIds.length
      ? await this.db
          .select({ userId: schema.groupMembers.userId, name: schema.groups.name })
          .from(schema.groupMembers)
          .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
          .where(inArray(schema.groupMembers.groupId, groupIds))
      : [];
    const items: AccessReviewItem[] = [];
    for (const u of users) {
      const level = (await clientLevels(this.db, actorFor(u))).get(clientId) ?? 'none';
      if (level === 'none') continue;
      const via = [
        ...(grants.some((g) => g.userId === u.id) ? ['Direct'] : []),
        ...members.filter((m) => m.userId === u.id).map((m) => `Group: ${m.name}`),
        ...(baselineLevel(u.role as Role, u.allClients as AccessLevel) !== 'none' ? ['All clients'] : []),
      ];
      items.push({
        userId: u.id,
        name: u.name,
        email: u.email,
        role: u.role as Role,
        level,
        via,
        mfa: hasMfa(u),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        decision: null,
        decidedByName: null,
        decidedAt: null,
      });
    }
    return items.sort((a, b) => levelRank(b.level) - levelRank(a.level) || a.name.localeCompare(b.name));
  }

  private view(row: Row, clientName: string): AccessReviewView {
    return {
      id: row.id,
      clientId: row.clientId,
      clientName,
      items: row.items as AccessReviewItem[],
      startedByName: row.startedByName,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      signedName: row.signedName,
    };
  }

  private async load(scope: Scope, id: string) {
    requireAdmin(scope.actor);
    const [found] = await this.db
      .select({ row: schema.accessReviews, clientName: schema.clients.name })
      .from(schema.accessReviews)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.accessReviews.clientId))
      .where(and(eq(schema.accessReviews.id, id), eq(schema.accessReviews.orgId, scope.actor.orgId)));
    if (!found) throw new HttpError(404, 'Access review not found.');
    await requireClient(this.db, scope.actor, found.row.clientId, 'read');
    return found;
  }

  async list(scope: Scope, clientId: string): Promise<AccessReviewView[]> {
    requireAdmin(scope.actor);
    const { client } = await requireClient(this.db, scope.actor, clientId, 'read');
    const rows = await this.db
      .select()
      .from(schema.accessReviews)
      .where(and(eq(schema.accessReviews.orgId, scope.actor.orgId), eq(schema.accessReviews.clientId, clientId)))
      .orderBy(desc(schema.accessReviews.createdAt))
      .limit(20);
    return rows.map((r) => this.view(r, client.name));
  }

  async get(scope: Scope, id: string): Promise<AccessReviewView> {
    const { row, clientName } = await this.load(scope, id);
    return this.view(row, clientName);
  }

  /** Starts a review of who can open the client now. One open review per client at a time. */
  async start(scope: Scope, clientId: string, ip: string): Promise<AccessReviewView> {
    requireAdmin(scope.actor);
    const { client } = await requireClient(this.db, scope.actor, clientId, 'read');
    const open = (await this.list(scope, clientId)).find((r) => !r.completedAt);
    if (open) return open;
    const [row] = await this.db
      .insert(schema.accessReviews)
      .values({
        orgId: scope.actor.orgId,
        clientId,
        items: await this.people(scope.actor.orgId, clientId),
        startedBy: scope.actor.id,
        startedByName: scope.actor.name,
      })
      .returning();
    await this.event(scope, 'Access review started', client.name, ip);
    return this.view(row!, client.name);
  }

  /**
   * Keeps or removes one person. Removing takes away their direct access to the client at once; access through a
   * group or the all-clients level stays, and the review says so, since changing that affects other clients too.
   */
  async decide(scope: Scope, id: string, input: unknown, ip: string): Promise<AccessReviewView> {
    const body = accessDecisionSchema.parse(input);
    const { row, clientName } = await this.load(scope, id);
    if (row.completedAt) throw new HttpError(409, 'This review is signed off.');
    const items = row.items as AccessReviewItem[];
    const item = items.find((i) => i.userId === body.userId);
    if (!item) throw new HttpError(404, 'That person isn’t in this review.');
    item.decision = body.decision;
    item.decidedByName = scope.actor.name;
    item.decidedAt = new Date().toISOString();
    delete item.stillHasAccess;
    if (body.decision === 'remove') {
      await this.db
        .delete(schema.clientAccess)
        .where(and(eq(schema.clientAccess.clientId, row.clientId), eq(schema.clientAccess.userId, item.userId)));
      const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, item.userId));
      item.stillHasAccess = !!user && (await clientLevels(this.db, actorFor(user))).get(row.clientId) !== 'none';
      await this.event(scope, 'Access review: removed access', `${item.name} from ${clientName}`, ip);
    }
    await this.db
      .update(schema.accessReviews)
      .set({ items, updatedAt: new Date() })
      .where(eq(schema.accessReviews.id, id));
    return this.get(scope, id);
  }

  /** Signs the review off once every person has a decision. After this it no longer changes. */
  async signOff(scope: Scope, id: string, input: unknown, ip: string): Promise<AccessReviewView> {
    const { signedName } = signOffSchema.parse(input);
    const { row, clientName } = await this.load(scope, id);
    if (row.completedAt) throw new HttpError(409, 'This review is already signed off.');
    const undecided = (row.items as AccessReviewItem[]).filter((i) => !i.decision).length;
    if (undecided) throw new HttpError(400, `Keep or remove everyone first (${undecided} left).`, 'undecided');
    await this.db
      .update(schema.accessReviews)
      .set({ completedAt: new Date(), signedBy: scope.actor.id, signedName, updatedAt: new Date() })
      .where(eq(schema.accessReviews.id, id));
    await this.event(scope, 'Access review signed off', `${clientName}, signed by ${signedName}`, ip);
    return this.get(scope, id);
  }

  /** The signed-off review as a PDF, laid out like a report. */
  async pdf(scope: Scope, id: string, organization: string, brand?: ReportBrand) {
    const review = await this.get(scope, id);
    if (!review.completedAt) throw new HttpError(409, 'Sign the review off first.');
    const kept = review.items.filter((i) => i.decision === 'keep');
    const removed = review.items.filter((i) => i.decision === 'remove');
    const snapshot: ReportSnapshot = {
      schemaVersion: 1,
      organization,
      definition: {
        kind: 'security',
        title: `${review.clientName} access review`,
        clientIds: [review.clientId],
        withinDays: 90,
        includeMicrosoft: false,
      },
      generatedAt: review.completedAt,
      generatedBy: review.signedName ?? '',
      clients: [{ id: review.clientId, name: review.clientName }],
      sources: [
        {
          name: 'Atlas access',
          updatedAt: review.createdAt,
          detail: `Everyone who could open ${review.clientName} when ${review.startedByName} started the review.`,
        },
      ],
      warnings: removed
        .filter((i) => i.stillHasAccess)
        .map((i) => `${i.name} still has access through a group or the all-clients level.`),
      sections: [
        {
          title: 'Sign-off',
          columns: ['Client', 'Started', 'Started by', 'Signed off', 'Signed by', 'People', 'Kept', 'Removed'],
          rows: [
            [
              review.clientName,
              review.createdAt,
              review.startedByName,
              review.completedAt,
              review.signedName ?? '',
              String(review.items.length),
              String(kept.length),
              String(removed.length),
            ],
          ],
        },
        {
          title: 'Decisions',
          columns: ['Person', 'Role', 'Access', 'Through', 'Two-factor', 'Last sign-in', 'Decision', 'Decided by'],
          rows: review.items.map((i) => [
            `${i.name} <${i.email}>`,
            ROLE_INFO[i.role].label,
            LEVEL_INFO[i.level].label,
            i.via.join(', '),
            i.mfa ? 'Yes' : 'No',
            i.lastLoginAt ?? 'Never',
            i.decision === 'remove' ? 'Removed' : 'Kept',
            `${i.decidedByName ?? ''}${i.decidedAt ? `, ${i.decidedAt.slice(0, 10)}` : ''}`,
          ]),
        },
      ],
    };
    return {
      filename: `${review.clientName} access review ${review.completedAt.slice(0, 10)}.pdf`,
      data: await reportPdf(snapshot, 'all', brand),
    };
  }

  private event(scope: Scope, action: string, detail: string, ip: string) {
    return securityEvent(this.db, {
      orgId: scope.actor.orgId,
      userId: scope.actor.id,
      actor: scope.actor.name,
      action,
      detail,
      ip,
    });
  }
}
