import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { HttpError } from '../errors.js';
import type { PersonalVaultService } from '../services/personal-vault.js';
import { Scope } from '../services/scope.js';

type Params = { id: string };

/**
 * Personal vaults: the signed-in person's own logins and notes. These routes answer only to a person signed in to
 * Atlas itself, never to an API key or a desktop app, and every one acts on the caller's own entries only.
 */
export function registerPersonalVaultRoutes(
  app: FastifyInstance,
  deps: { db: Database; authed: { onRequest: onRequestHookHandler }; personal: PersonalVaultService },
) {
  const { db, authed, personal } = deps;
  const scopeOf = (req: FastifyRequest) => {
    if ((req.raw as { atlasApi?: boolean }).atlasApi) throw new HttpError(404, 'Not found.');
    return new Scope(db, req.session!.actor);
  };

  app.get('/api/personal-vault/status', authed, async (req) => personal.status(scopeOf(req)));
  app.get('/api/personal-vault', authed, async (req) => personal.list(scopeOf(req)));
  app.post('/api/personal-vault', authed, async (req, reply) =>
    reply.status(201).send(await personal.create(scopeOf(req), req.body)),
  );
  app.get<{ Params: Params }>('/api/personal-vault/:id', authed, async (req) =>
    personal.get(scopeOf(req), req.params.id),
  );
  app.patch<{ Params: Params }>('/api/personal-vault/:id', authed, async (req) =>
    personal.update(scopeOf(req), req.params.id, req.body),
  );
  app.delete<{ Params: Params }>('/api/personal-vault/:id', authed, async (req) => {
    await personal.remove(scopeOf(req), req.params.id);
    return { ok: true };
  });
  app.post<{ Params: Params }>('/api/personal-vault/:id/reveal', authed, async (req) =>
    personal.reveal(scopeOf(req), req.params.id, req.body),
  );
}
