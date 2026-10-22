import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Database } from '@atlas/db';
import { ACCESS_MODE_LABELS, SERVICE_ACTION_LABELS, type AccessMode, type ServiceAction } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { PortalCertificate } from '../services/portal-certificate.js';
import type { SystemServices } from '../services/system-services.js';
import type { RemoteAccess } from '../services/remote-access.js';
import { securityEvent } from '../services/security-log.js';

/**
 * The Services page: the state of the services Atlas runs on, and asking the server's helper to restart one or
 * repair the installation. And the Certificate page: what the portal is served with, and the certificate to
 * install on computers so they trust it. Administrators only.
 */
export function registerSystemRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    services: SystemServices;
    access: RemoteAccess;
    certificate: PortalCertificate;
  },
) {
  const { db, authed, recent, services, access, certificate } = deps;
  const admin = (req: FastifyRequest) => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    return actor;
  };
  const databaseReachable = async () => {
    try {
      await db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  };

  app.get('/api/system/services', authed, async (req) => {
    admin(req);
    return services.overview(await databaseReachable());
  });

  app.get('/api/system/access', authed, async (req) => {
    admin(req);
    return access.view();
  });

  // Changing how Atlas is reached moves everyone to a new address and can open it to the internet, so only the
  // owner may, with a fresh password confirmation. The tunnel token and auth key are never logged.
  app.post('/api/system/access', authed, async (req, reply) => {
    const actor = admin(req);
    if (actor.role !== 'owner') throw new HttpError(403, 'Only the owner can change how Atlas is reached.');
    recent(req);
    const run = await access.request(req.body, actor.name);
    const body = req.body as { mode?: unknown; publicUrl?: unknown };
    await securityEvent(db, {
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'Remote access change requested',
      detail: [ACCESS_MODE_LABELS[body.mode as AccessMode], typeof body.publicUrl === 'string' ? body.publicUrl : null]
        .filter(Boolean)
        .join(': '),
      ip: req.ip,
    });
    return reply.status(202).send(run);
  });

  app.get('/api/system/certificate', authed, async (req) => {
    admin(req);
    return certificate.view();
  });

  // A public certificate, never a key. It is still administrators only: it should reach computers from someone
  // who checked what it is.
  app.get('/api/system/certificate/authority', authed, async (req, reply) => {
    admin(req);
    const file = await certificate.authorityFile();
    if (!file) throw new HttpError(404, 'There is no certificate to install for this address.');
    return reply
      .header('Content-Type', 'application/x-x509-ca-cert')
      .header('Content-Disposition', `attachment; filename="${file.filename}"`)
      .send(file.pem);
  });

  // Every action interrupts people using Atlas, so each needs a fresh password confirmation and is logged.
  app.post<{ Body: { action?: unknown } }>('/api/system/services/run', authed, async (req, reply) => {
    const actor = admin(req);
    recent(req);
    const run = await services.request(req.body?.action, actor.name);
    await securityEvent(db, {
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'Service action requested',
      detail: SERVICE_ACTION_LABELS[run.action as ServiceAction],
      ip: req.ip,
    });
    return reply.status(202).send(run);
  });
}
