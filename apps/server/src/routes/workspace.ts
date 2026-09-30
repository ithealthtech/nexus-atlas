import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, resolveWorkspace, workspacePrefsSchema, type ClientCounts } from '@atlas/shared';
import { z } from 'zod';
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
    await db
      .update(schema.users)
      .set({ workspace: body })
      .where(eq(schema.users.id, actorOf(req).id));
    return prefs(actorOf(req).id);
  });
  app.delete('/api/account/workspace', authed, async (req) => {
    await db
      .update(schema.users)
      .set({ workspace: {} })
      .where(eq(schema.users.id, actorOf(req).id));
    return prefs(actorOf(req).id);
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
