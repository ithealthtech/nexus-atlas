import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { AccessReviewService } from '../services/access-reviews.js';
import { Scope } from '../services/scope.js';
import type { SettingsService } from '../services/settings.js';

type Params = { id: string };

/** Access reviews of a client, for administrators: start one, keep or remove each person, sign it off, download it. */
export function registerAccessReviewRoutes(
  app: FastifyInstance,
  deps: { db: Database; authed: { onRequest: onRequestHookHandler }; settings: SettingsService },
) {
  const { db, authed, settings } = deps;
  const reviews = new AccessReviewService(db);
  const scopeOf = (req: FastifyRequest) => new Scope(db, req.session!.actor);
  app.get<{ Params: Params }>('/api/clients/:id/access-reviews', authed, async (req) =>
    reviews.list(scopeOf(req), req.params.id),
  );
  app.post<{ Params: Params }>('/api/clients/:id/access-reviews', authed, async (req, reply) =>
    reply.status(201).send(await reviews.start(scopeOf(req), req.params.id, req.ip)),
  );
  app.get<{ Params: Params }>('/api/access-reviews/:id', authed, async (req) =>
    reviews.get(scopeOf(req), req.params.id),
  );
  app.post<{ Params: Params }>('/api/access-reviews/:id/decisions', authed, async (req) =>
    reviews.decide(scopeOf(req), req.params.id, req.body, req.ip),
  );
  app.post<{ Params: Params }>('/api/access-reviews/:id/sign-off', authed, async (req) =>
    reviews.signOff(scopeOf(req), req.params.id, req.body, req.ip),
  );
  app.get<{ Params: Params }>('/api/access-reviews/:id/pdf', authed, async (req, reply) => {
    const actor = req.session!.actor;
    const brand = await settings.branding(actor.orgId);
    const { filename, data } = await reviews.pdf(scopeOf(req), req.params.id, req.session!.organization.name, {
      name: brand.brandName,
      logo: brand.logo,
      accent: brand.accent,
    });
    return reply
      .header('cache-control', 'no-store')
      .header(
        'content-disposition',
        `attachment; filename="atlas-access-review.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .type('application/pdf')
      .send(data);
  });
}
