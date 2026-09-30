import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { HttpError } from '../errors.js';
import type { RotationService } from '../services/rotation.js';

interface Limiter {
  check(key: string): void;
  fail(key: string): void;
}

/** Automated password rotation: administration, and the two calls the rotation script makes from a device. */
export function registerRotationRoutes(
  app: FastifyInstance,
  deps: {
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    rotation: RotationService;
    /** Failed device-token attempts per address, so tokens can't be guessed. */
    agentLimiter: Limiter;
  },
) {
  const { authed, recent, rotation, agentLimiter } = deps;
  const actor = (req: FastifyRequest) => req.session!.actor;

  app.get('/api/rotation/settings', authed, async (req) => rotation.settingsView(actor(req)));
  app.put('/api/rotation/settings', authed, async (req) => {
    recent(req);
    return rotation.saveSettings(actor(req), req.body, req.ip);
  });
  app.get('/api/rotation/policies', authed, async (req) => rotation.policies(actor(req)));
  app.put('/api/rotation/policies', authed, async (req) => rotation.savePolicy(actor(req), req.body, req.ip));
  app.delete<{ Params: { id: string } }>('/api/rotation/policies/:id', authed, async (req) => {
    await rotation.deletePolicy(actor(req), req.params.id, req.ip);
    return { ok: true };
  });
  app.get('/api/rotation/targets', authed, async (req) => rotation.targets(actor(req)));
  app.get<{ Params: { id: string } }>('/api/rotation/clients/:id/devices', authed, async (req) =>
    rotation.devices(actor(req), req.params.id),
  );
  app.post('/api/rotation/targets', authed, async (req, reply) => {
    recent(req);
    return reply.status(201).send(await rotation.addTarget(actor(req), req.body, req.ip));
  });
  app.patch<{ Params: { id: string } }>('/api/rotation/targets/:id', authed, async (req) =>
    rotation.updateTarget(actor(req), req.params.id, req.body, req.ip),
  );
  app.delete<{ Params: { id: string } }>('/api/rotation/targets/:id', authed, async (req) => {
    await rotation.removeTarget(actor(req), req.params.id, req.ip);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/rotation/targets/:id/rotate', authed, async (req, reply) =>
    reply.status(202).send(await rotation.rotateNow(actor(req), req.params.id, req.ip)),
  );
  app.get('/api/rotation/runs', authed, async (req) => rotation.runs(actor(req)));
  app.post<{ Params: { id: string } }>('/api/rotation/runs/:id/cancel', authed, async (req) => {
    await rotation.cancelRun(actor(req), req.params.id, req.ip);
    return { ok: true };
  });
  app.post('/api/rotation/revoke-tokens', authed, async (req) => {
    recent(req);
    return rotation.revokeAll(actor(req), req.ip);
  });

  // The rotation script, on the device. No session: the attempt's own token is the only credential, and it can
  // do nothing but report on that one attempt.
  const agent = async (req: FastifyRequest, work: () => Promise<unknown>) => {
    agentLimiter.check(req.ip);
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) agentLimiter.fail(req.ip);
      throw error;
    }
  };
  app.post('/api/rotation/agent/candidate', { bodyLimit: 4096 }, async (req) =>
    agent(req, () => rotation.candidate(req.headers.authorization, req.body)),
  );
  app.post('/api/rotation/agent/result', { bodyLimit: 4096 }, async (req) =>
    agent(req, () => rotation.result(req.headers.authorization, req.body, req.ip)),
  );
}

/** Starts due rotations, and fails attempts whose device never reported back, every few minutes. */
export class RotationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly rotation: RotationService,
    private readonly log: (error: unknown) => void,
  ) {}

  start(intervalMs = 5 * 60_000) {
    this.timer = setInterval(() => void this.tick().catch(this.log), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      // Organizations with any rotation state: settings saved, or attempts that may need expiring.
      const orgs = await this.db
        .select({ id: schema.orgs.id })
        .from(schema.orgs)
        .where(sql`${schema.orgs.settings} ? 'rotation'`);
      for (const { id } of orgs) await this.rotation.tick(id, now).catch(this.log);
    } finally {
      this.running = false;
    }
  }
}
