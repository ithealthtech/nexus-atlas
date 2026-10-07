import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { WebhookService } from '../services/webhooks.js';

type Params = { id: string };

/** Webhooks: administrators choose where Atlas posts when things change, and see how deliveries went. */
export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: {
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    webhooks: WebhookService;
  },
) {
  const { authed, recent, webhooks } = deps;
  const actor = (req: FastifyRequest) => req.session!.actor;

  app.get('/api/webhooks', authed, async (req) => webhooks.list(actor(req)));
  // The response carries the new signing secret, once.
  app.post('/api/webhooks', authed, async (req, reply) => {
    recent(req);
    return reply
      .status(201)
      .header('Cache-Control', 'no-store')
      .send(await webhooks.create(actor(req), req.body, req.ip));
  });
  app.patch<{ Params: Params }>('/api/webhooks/:id', authed, async (req) => {
    recent(req);
    return webhooks.update(actor(req), req.params.id, req.body, req.ip);
  });
  app.delete<{ Params: Params }>('/api/webhooks/:id', authed, async (req) => {
    recent(req);
    await webhooks.remove(actor(req), req.params.id, req.ip);
    return { ok: true };
  });
  app.post<{ Params: Params }>('/api/webhooks/:id/secret', authed, async (req, reply) => {
    recent(req);
    return reply
      .header('Cache-Control', 'no-store')
      .send(await webhooks.rotateSecret(actor(req), req.params.id, req.ip));
  });
  app.post<{ Params: Params }>('/api/webhooks/:id/resume', authed, async (req) =>
    webhooks.resume(actor(req), req.params.id),
  );
  app.post<{ Params: Params }>('/api/webhooks/:id/test', authed, async (req) =>
    webhooks.test(actor(req), req.params.id),
  );
  app.get<{ Params: Params }>('/api/webhooks/:id/deliveries', authed, async (req) =>
    webhooks.deliveries(actor(req), req.params.id),
  );
}
