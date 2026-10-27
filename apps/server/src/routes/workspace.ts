import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  ROLE_INFO,
  STALE_DOCUMENT_DAYS,
  resolveWorkspace,
  workspacePrefsSchema,
  type ClientCounts,
  type Role,
  type TeamPulse,
} from '@atlas/shared';
import { z } from 'zod';
import { requireAdmin } from '../authz.js';
import { ClientService } from '../services/clients.js';
import { FavoriteService, favoriteType } from '../services/favorites.js';
import { Scope } from '../services/scope.js';
import type { VaultService } from '../services/vault.js';

type Params = { id: string };
const restoreSchema = z.object({ version: z.number().int().positive(), expectedVersion: z.number().int().min(0) });

/**
 * The personal side of the workspace: favorites, dashboard cards, hidden client sections, section counts, and the
 * history of each client's quick notes. Favorites, preferences, and counts sit outside the API key routes: they are
 * about one person's screen, and counts include how many passwords a client has.
 */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: { db: Database; authed: { onRequest: onRequestHookHandler }; vault: VaultService },
) {
  const { db, authed, vault } = deps;
  const clients = new ClientService(db);
  const favorites = new FavoriteService(vault);
  const actorOf = (req: FastifyRequest) => req.session!.actor;
  const scopeOf = (req: FastifyRequest) => new Scope(db, actorOf(req));

  // ---- favorites (personal: no activity or audit entry) ----
  app.get('/api/favorites', authed, async (req) => favorites.list(scopeOf(req)));
  app.put<{ Params: { type: string; id: string } }>('/api/favorites/:type/:id', authed, async (req) =>
    favorites.set(scopeOf(req), favoriteType(req.params.type), req.params.id, true),
  );
  app.delete<{ Params: { type: string; id: string } }>('/api/favorites/:type/:id', authed, async (req) =>
    favorites.set(scopeOf(req), favoriteType(req.params.type), req.params.id, false),
  );

  // ---- dashboard cards and client sections ----
  const prefs = async (userId: string) => {
    const [row] = await db
      .select({ workspace: schema.users.workspace })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return resolveWorkspace(row?.workspace);
  };
  app.get('/api/account/workspace', authed, async (req) => prefs(actorOf(req).id));
  app.put('/api/account/workspace', authed, async (req) => {
    const body = workspacePrefsSchema.parse(req.body);
    // The dashboard and section editors don't send the menu style; keep the one already chosen, and what's been seen.
    const saved = await prefs(actorOf(req).id);
    const menu = body.menu ?? saved.menu;
    await db
      .update(schema.users)
      .set({ workspace: { ...body, menu, seenWhatsNew: saved.seenWhatsNew } })
      .where(eq(schema.users.id, actorOf(req).id));
    return prefs(actorOf(req).id);
  });
  // Resets the dashboard and sections. The menu style is a separate choice and stays, as does what's been seen.
  app.delete('/api/account/workspace', authed, async (req) => {
    const { menu, seenWhatsNew } = await prefs(actorOf(req).id);
    await db
      .update(schema.users)
      .set({ workspace: { menu, seenWhatsNew } })
      .where(eq(schema.users.id, actorOf(req).id));
    return prefs(actorOf(req).id);
  });

  // "What's new" seen or put away: its card leaves the dashboard. Personal, like the rest of the workspace.
  app.post('/api/account/whats-new', authed, async (req) => {
    const { seen } = z.object({ seen: z.string().trim().min(1).max(20) }).parse(req.body);
    const saved = await prefs(actorOf(req).id);
    await db
      .update(schema.users)
      .set({ workspace: { ...saved, seenWhatsNew: seen } })
      .where(eq(schema.users.id, actorOf(req).id));
    return prefs(actorOf(req).id);
  });

  // ---- team pulse: who has been documenting, this week against last ----
  app.get('/api/workspace/team-pulse', authed, async (req): Promise<TeamPulse> => {
    const actor = actorOf(req);
    requireAdmin(actor);
    const days = 30;
    const now = Date.now();
    const split = new Date(now - days * 86_400_000);
    const a = schema.activity;
    const counts = await db
      .select({
        actorId: a.actorId,
        changes: sql<number>`count(*) filter (where ${a.createdAt} >= ${split})::int`,
        previous: sql<number>`count(*) filter (where ${a.createdAt} < ${split})::int`,
        clients: sql<number>`count(distinct ${a.clientId}) filter (where ${a.createdAt} >= ${split})::int`,
      })
      .from(a)
      .where(and(eq(a.orgId, actor.orgId), gte(a.createdAt, new Date(now - 2 * days * 86_400_000))))
      .groupBy(a.actorId);
    const byId = new Map(counts.map((c) => [c.actorId, c]));
    // Who owns stale documents: whoever edited a current document last, when that was long ago.
    const d = schema.documents;
    const staleRows = await db
      .select({ userId: d.updatedBy, n: sql<number>`count(*)::int` })
      .from(d)
      .where(
        and(
          eq(d.orgId, actor.orgId),
          eq(d.archived, false),
          lt(d.updatedAt, new Date(now - STALE_DOCUMENT_DAYS * 86_400_000)),
        ),
      )
      .groupBy(d.updatedBy);
    const stale = new Map(staleRows.map((r) => [r.userId, r.n]));
    const users = await db
      .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, last: schema.users.lastLoginAt })
      .from(schema.users)
      .where(and(eq(schema.users.orgId, actor.orgId), eq(schema.users.disabled, false)));
    const people = users
      .filter((u) => ROLE_INFO[u.role as Role].staff)
      .map((u) => {
        const c = byId.get(u.id);
        return {
          id: u.id,
          name: u.name,
          changes: c?.changes ?? 0,
          previous: c?.previous ?? 0,
          clients: c?.clients ?? 0,
          stale: stale.get(u.id) ?? 0,
          lastSignInAt: u.last?.toISOString() ?? null,
        };
      })
      .sort((x, y) => y.changes - x.changes || x.name.localeCompare(y.name));
    return { days, people };
  });

  // ---- client sections ----
  app.get<{ Params: Params }>('/api/workspace/clients/:id/counts', authed, async (req): Promise<ClientCounts> => {
    const scope = scopeOf(req);
    const counts = await clients.counts(scope.actor, req.params.id);
    const level = await scope.level(req.params.id);
    // Staff see a client's vault only with password access; client accounts see what was shared with them.
    const vaultOpen = !ROLE_INFO[scope.actor.role].staff || level === 'edit_passwords';
    const passwords = vaultOpen ? (await vault.list(scope, { clientId: req.params.id })).length : null;
    return { ...counts, passwords };
  });

  // ---- quick notes history ----
  app.get<{ Params: Params }>('/api/clients/:id/notes/revisions', authed, async (req) =>
    clients.notesRevisions(actorOf(req), req.params.id),
  );
  app.get<{ Params: Params & { version: string } }>('/api/clients/:id/notes/revisions/:version', authed, async (req) =>
    clients.notesRevision(actorOf(req), req.params.id, Number(req.params.version)),
  );
  app.post<{ Params: Params }>('/api/clients/:id/notes/restore', authed, async (req) => {
    const body = restoreSchema.parse(req.body);
    return clients.restoreNotes(actorOf(req), req.params.id, body.version, body.expectedVersion);
  });
}
