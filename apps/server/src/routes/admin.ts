import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  RMM_HEALTH_FILTERS,
  WARRANTY_FILTERS,
  isAssetStatsFilter,
  testEmailSchema,
  type RmmHealthFilter,
  type WarrantyFilter,
} from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { AuditService } from '../services/audit.js';
import type { EmergencyAccessService } from '../services/emergency.js';
import { ExpirationService } from '../services/expirations.js';
import { GroupService } from '../services/groups.js';
import { graphPermissions, type MailService } from '../services/mail.js';
import { Notifier } from '../services/notifier.js';
import { RmmHealthService } from '../services/rmm-health.js';
import { TicketService } from '../services/tickets.js';
import { WarrantyService } from '../services/warranty.js';
import { AssetStatsService } from '../services/asset-stats.js';
import { Scope, isUuid } from '../services/scope.js';
import type { SettingsService, SmtpConfig } from '../services/settings.js';
import type { VaultService } from '../services/vault.js';

type Params = { id: string };

/** Groups, email and notification settings, expirations, RMM health, tickets, asset warranty, asset statistics, and the audit log. Returns the background notifier. */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    mail: MailService;
    audit: AuditService;
    vault: VaultService;
    emergency: EmergencyAccessService;
    publicOrigin: string;
    sendHour: number;
    /** Replaces the Microsoft 365 permission check (tests use a fake Microsoft). */
    health?: { nightly(orgId: string): Promise<void> };
    graphPermissions?: (config: SmtpConfig) => Promise<{ roles: string[]; canSend: boolean }>;
  },
): Notifier {
  const { db, authed, recent, settings, mail, audit } = deps;
  const groups = new GroupService(db);
  const expirations = new ExpirationService(deps.vault);
  const rmmHealth = new RmmHealthService(settings);
  const tickets = new TicketService(settings);
  const warranty = new WarrantyService(settings);
  const assetStats = new AssetStatsService(settings);
  const actorOf = (req: FastifyRequest) => req.session!.actor;
  const admin = (req: FastifyRequest) => {
    requireAdmin(actorOf(req));
    return actorOf(req).orgId;
  };

  // ---- groups ----
  app.get('/api/groups', authed, async (req) => groups.list(actorOf(req)));
  app.post('/api/groups', authed, async (req, reply) => {
    recent(req);
    return reply.status(201).send(await groups.create(actorOf(req), req.body, req.ip));
  });
  app.put<{ Params: Params }>('/api/groups/:id', authed, async (req) => {
    recent(req);
    return groups.update(actorOf(req), req.params.id, req.body, req.ip);
  });
  app.delete<{ Params: Params }>('/api/groups/:id', authed, async (req) => {
    recent(req);
    await groups.remove(actorOf(req), req.params.id, req.ip);
    return { ok: true };
  });

  // ---- email and notifications ----
  const event = (req: FastifyRequest, action: string, detail = '') =>
    db.insert(schema.securityEvents).values({
      orgId: actorOf(req).orgId,
      userId: actorOf(req).id,
      actor: actorOf(req).name,
      action,
      detail: detail.slice(0, 300),
      ip: req.ip,
    });
  app.get('/api/settings/email', authed, async (req) => settings.smtpView(admin(req)));
  app.put('/api/settings/email', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    const saved = await settings.saveSmtp(orgId, req.body);
    await event(
      req,
      'Email settings changed',
      !saved.enabled
        ? 'Email off'
        : saved.method === 'graph'
          ? `Microsoft 365 (Graph) app ${saved.clientId} in ${saved.tenantId}`
          : `${saved.host}:${saved.port}`,
    );
    return saved;
  });
  // Signs in to Microsoft 365 and lists the app's application permissions, without sending anything.
  app.post('/api/settings/email/permissions', authed, async (req) => {
    const orgId = admin(req);
    const config = await settings.smtpConfig(orgId);
    if (!config || config.method !== 'graph')
      throw new HttpError(409, 'Save Microsoft 365 (app registration) email settings with email turned on first.');
    try {
      return await (deps.graphPermissions ?? graphPermissions)(config);
    } catch (error) {
      throw new HttpError(502, (error as Error).message.slice(0, 400));
    }
  });
  app.post('/api/settings/email/test', authed, async (req) => {
    const orgId = admin(req);
    const { to } = testEmailSchema.parse(req.body ?? {});
    const [org] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, orgId));
    try {
      await mail.send(orgId, org!.name, {
        to,
        subject: 'MSP Atlas test email',
        paragraphs: ['Email from MSP Atlas is working. Password resets and expiry alerts will be sent this way.'],
      });
    } catch (error) {
      // The reason comes from the mail provider and never contains the secret; keep it for troubleshooting.
      req.log.warn({ reason: (error as Error).message }, 'Test email failed');
      await event(req, 'Test email failed', (error as Error).message);
      throw error;
    }
    await event(req, 'Test email sent', to);
    return { ok: true };
  });
  app.get('/api/settings/notifications', authed, async (req) => settings.notifications(admin(req)));
  app.put('/api/settings/notifications', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    const saved = await settings.saveNotifications(orgId, req.body);
    await event(
      req,
      'Notification settings changed',
      `Alerts ${saved.alertDays.join('/')} days · digest ${saved.weeklyDigest ? 'on' : 'off'} · retention ${saved.auditRetentionDays ?? 'forever'}`,
    );
    return saved;
  });

  app.get('/api/settings/rmm-health', authed, async (req) => settings.rmmHealth(req.session!.actor.orgId));
  app.put('/api/settings/rmm-health', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    const saved = await settings.saveRmmHealth(orgId, req.body);
    await event(
      req,
      'RMM health settings changed',
      `Stale after ${saved.staleDays} days · very stale after ${saved.veryStaleDays}`,
    );
    return saved;
  });

  // ---- expirations ----
  app.get<{ Querystring: { days?: string } }>('/api/expirations', authed, async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
    return expirations.list(new Scope(db, actorOf(req)), days);
  });

  // ---- RMM health ----
  type HealthQuery = { client?: string; staleDays?: string; veryStaleDays?: string; filter?: string };
  /** The scope and options for an RMM health request; a client the actor can't read is not found. */
  const healthScope = async (req: FastifyRequest<{ Querystring: HealthQuery }>) => {
    const scope = new Scope(db, actorOf(req));
    const { client, staleDays, veryStaleDays } = req.query;
    if (client !== undefined) {
      if (!isUuid(client)) throw new HttpError(404, 'Client not found.');
      await scope.require(client, 'read', 'Client');
    }
    return { scope, opts: { clientId: client, stale: staleDays, veryStale: veryStaleDays } };
  };
  app.get<{ Querystring: HealthQuery }>('/api/rmm-health', authed, async (req) => {
    const { scope, opts } = await healthScope(req);
    return rmmHealth.report(scope, opts);
  });
  app.get<{ Querystring: HealthQuery & { days?: string } }>('/api/rmm-health/trend', authed, async (req) => {
    const { scope, opts } = await healthScope(req);
    return rmmHealth.trend(scope, { clientId: opts.clientId, days: req.query.days });
  });
  app.get<{ Querystring: HealthQuery }>('/api/rmm-health/devices', authed, async (req) => {
    const filter = req.query.filter as RmmHealthFilter;
    if (!RMM_HEALTH_FILTERS.includes(filter)) throw new HttpError(400, 'Choose which devices to list.');
    const { scope, opts } = await healthScope(req);
    return rmmHealth.devices(scope, filter, opts);
  });

  // ---- tickets (read-only, from the ConnectWise platform) ----
  type TicketQuery = { client?: string; days?: string; status?: string };
  const ticketScope = async (req: FastifyRequest<{ Querystring: TicketQuery }>) => {
    const scope = new Scope(db, actorOf(req));
    const { client } = req.query;
    if (client !== undefined) {
      if (!isUuid(client)) throw new HttpError(404, 'Client not found.');
      await scope.require(client, 'read', 'Client');
    }
    return scope;
  };
  app.get<{ Querystring: TicketQuery }>('/api/tickets', authed, async (req) =>
    tickets.report(await ticketScope(req), { clientId: req.query.client, days: req.query.days }),
  );
  app.get<{ Querystring: TicketQuery }>('/api/tickets/list', authed, async (req) => {
    const { status } = req.query;
    if (status !== undefined && (typeof status !== 'string' || status.length > 100))
      throw new HttpError(400, 'Choose which tickets to list.');
    return tickets.list(await ticketScope(req), { clientId: req.query.client, status, days: req.query.days });
  });

  // ---- asset warranty ----
  type WarrantyQuery = { client?: string; soonDays?: string; filter?: string };
  const warrantyScope = async (req: FastifyRequest<{ Querystring: WarrantyQuery }>) => {
    const scope = new Scope(db, actorOf(req));
    const { client, soonDays } = req.query;
    if (client !== undefined) {
      if (!isUuid(client)) throw new HttpError(404, 'Client not found.');
      await scope.require(client, 'read', 'Client');
    }
    return { scope, opts: { clientId: client, soonDays } };
  };
  app.get<{ Querystring: WarrantyQuery }>('/api/warranty', authed, async (req) => {
    const { scope, opts } = await warrantyScope(req);
    return warranty.report(scope, opts);
  });
  app.get<{ Querystring: WarrantyQuery }>('/api/warranty/assets', authed, async (req) => {
    const filter = req.query.filter as WarrantyFilter;
    if (!WARRANTY_FILTERS.includes(filter)) throw new HttpError(400, 'Choose which assets to list.');
    const { scope, opts } = await warrantyScope(req);
    return warranty.assets(scope, filter, opts);
  });
  app.get('/api/settings/warranty', authed, async (req) => settings.warranty(actorOf(req).orgId));
  app.put('/api/settings/warranty', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    const saved = await settings.saveWarranty(orgId, req.body);
    await event(req, 'Warranty settings changed', `Expiring soon within ${saved.soonDays} days`);
    return saved;
  });

  // ---- asset statistics ----
  type StatsQuery = { client?: string; filter?: string };
  const statsScope = async (req: FastifyRequest<{ Querystring: StatsQuery }>) => {
    const scope = new Scope(db, actorOf(req));
    const { client } = req.query;
    if (client !== undefined) {
      if (!isUuid(client)) throw new HttpError(404, 'Client not found.');
      await scope.require(client, 'read', 'Client');
    }
    return { scope, opts: { clientId: client } };
  };
  app.get<{ Querystring: StatsQuery }>('/api/asset-stats', authed, async (req) => {
    const { scope, opts } = await statsScope(req);
    return assetStats.report(scope, opts);
  });
  app.get<{ Querystring: StatsQuery }>('/api/asset-stats/assets', authed, async (req) => {
    const filter = req.query.filter;
    if (!isAssetStatsFilter(filter)) throw new HttpError(400, 'Choose which assets to list.');
    const { scope, opts } = await statsScope(req);
    return assetStats.assets(scope, filter, opts);
  });
  app.get('/api/settings/asset-stats', authed, async (req) => settings.assetStats(actorOf(req).orgId));
  app.put('/api/settings/asset-stats', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    const saved = await settings.saveAssetStats(orgId, req.body);
    const chosen = Object.keys(saved.layouts).length;
    await event(
      req,
      'Asset statistics settings changed',
      chosen ? `${chosen} layout${chosen === 1 ? '' : 's'} set by hand` : 'Every layout automatic',
    );
    return saved;
  });

  // ---- audit log ----
  app.post('/api/audit/verify', authed, async (req) => audit.verify(actorOf(req)));
  app.get<{ Params: { kind: string } }>('/api/audit/export/:kind', authed, async (req, reply) => {
    requireAdmin(actorOf(req));
    recent(req);
    const kind = req.params.kind === 'vault' ? 'vault' : 'security';
    const csv = kind === 'vault' ? await audit.exportVault(actorOf(req)) : await audit.exportSecurity(actorOf(req));
    await event(req, 'Audit log exported', kind === 'vault' ? 'Password activity' : 'Security events');
    const date = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="atlas-${kind}-log-${date}.csv"`)
      .send(csv);
  });

  return new Notifier(db, {
    mail,
    settings,
    expirations,
    audit,
    emergency: deps.emergency,
    health: deps.health,
    publicOrigin: deps.publicOrigin,
    sendHour: deps.sendHour,
  });
}
