import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { testEmailSchema } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { AuditService } from '../services/audit.js';
import { ExpirationService } from '../services/expirations.js';
import { GroupService } from '../services/groups.js';
import type { MailService } from '../services/mail.js';
import { Notifier } from '../services/notifier.js';
import { Scope } from '../services/scope.js';
import type { SettingsService } from '../services/settings.js';
import type { VaultService } from '../services/vault.js';

type Params = { id: string };

/** Groups, email and notification settings, expirations, and the audit log. Returns the background notifier. */
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
    publicOrigin: string;
    sendHour: number;
  },
): Notifier {
  const { db, authed, recent, settings, mail, audit } = deps;
  const groups = new GroupService(db);
  const expirations = new ExpirationService(deps.vault);
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
    await event(req, 'Email settings changed', saved.enabled ? `${saved.host}:${saved.port}` : 'Email off');
    return saved;
  });
  app.post('/api/settings/email/test', authed, async (req) => {
    const orgId = admin(req);
    const { to } = testEmailSchema.parse(req.body ?? {});
    const [org] = await db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, orgId));
    await mail.send(orgId, org!.name, {
      to,
      subject: 'MSP Atlas test email',
      paragraphs: ['Email from MSP Atlas is working. Password resets and expiry alerts will be sent this way.'],
    });
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

  // ---- expirations ----
  app.get<{ Querystring: { days?: string } }>('/api/expirations', authed, async (req) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 730);
    return expirations.list(new Scope(db, actorOf(req)), days);
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
    publicOrigin: deps.publicOrigin,
    sendHour: deps.sendHour,
  });
}
