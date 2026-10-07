import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Database } from '@atlas/db';
import { z } from 'zod';
import { HttpError } from '../errors.js';
import type { BitlockerCollectorService } from '../services/bitlocker-collector.js';
import { Scope } from '../services/scope.js';

interface Limiter {
  check(key: string): void;
  fail(key: string): void;
}

/** The BitLocker collector: enrollments and devices for administrators, and the one call the script makes. */
export function registerBitlockerRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    collector: BitlockerCollectorService;
    /** Failed token attempts per address, so tokens can't be guessed. */
    agentLimiter: Limiter;
  },
) {
  const { db, authed, recent, collector, agentLimiter } = deps;
  const actor = (req: FastifyRequest) => req.session!.actor;

  app.get('/api/bitlocker/collector', authed, async (req) => collector.overview(actor(req)));
  // The response carries the script with its upload token, once. The request log keeps no bodies for this path.
  app.post('/api/bitlocker/enrollments', authed, async (req, reply) => {
    recent(req);
    return reply
      .status(201)
      .header('Cache-Control', 'no-store')
      .send(await collector.enroll(actor(req), req.body, req.ip));
  });
  app.delete<{ Params: { id: string } }>('/api/bitlocker/enrollments/:id', authed, async (req) => {
    recent(req);
    await collector.revoke(actor(req), req.params.id, req.ip);
    return collector.overview(actor(req));
  });
  app.post<{ Params: { id: string } }>('/api/bitlocker/devices/:id/block', authed, async (req) => {
    const { blocked } = z.object({ blocked: z.boolean() }).parse(req.body);
    await collector.setBlocked(actor(req), req.params.id, blocked, req.ip);
    return collector.overview(actor(req));
  });
  app.get<{ Params: { id: string } }>('/api/assets/:id/bitlocker', authed, async (req) =>
    collector.forAsset(new Scope(db, actor(req)), req.params.id),
  );

  // The script, on a machine. No session and no cookies: the enrollment's token is the only credential, and all it
  // can do is hand in a report for its own client. A browser never has a reason to call this.
  app.post('/api/bitlocker/ingest', { bodyLimit: 100_000 }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (req.headers.origin || req.headers.cookie) throw new HttpError(403, 'This address is for the collector script.');
    agentLimiter.check(req.ip);
    const match = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization ?? ''));
    const enrollment = match ? await collector.enrollmentForToken(match[1]!) : null;
    if (!enrollment) {
      agentLimiter.fail(req.ip);
      throw new HttpError(401, 'Collector credential rejected.');
    }
    if (enrollment.revokedAt) throw new HttpError(403, 'Enrollment revoked.', 'revoked');
    return collector.ingest(enrollment, req.body, req.ip);
  });
}
