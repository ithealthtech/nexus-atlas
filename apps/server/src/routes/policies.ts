import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Role, VaultPolicy, VaultPolicyView } from '@atlas/shared';
import { clientLevels, requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { actorFor, hasMfa } from '../identity/service.js';
import type { EmergencyAccessService } from '../services/emergency.js';
import type { SettingsService } from '../services/settings.js';
import type { SiemForwarder } from '../services/siem.js';

type Params = { id: string };
const onOff = (on: boolean) => (on ? 'on' : 'off');
const describe = (p: VaultPolicy) =>
  [
    `Generator ${p.generator.minLength}+ characters${p.generator.requireDigits ? ', numbers' : ''}${p.generator.requireSymbols ? ', symbols' : ''}${p.generator.allowPins ? '' : ', no PINs'}`,
    `reasons ${onOff(p.requireRevealReason)}`,
    `read-only reveals ${p.blockReadOnlyReveal ? 'blocked' : 'allowed'}`,
    `restricted for listed people only ${onOff(p.restrictedListedOnly)}`,
  ].join(' · ');

/** Vault policies (owner), emergency access to restricted passwords, and streaming the audit logs to a SIEM. */
export function registerPolicyRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    emergency: EmergencyAccessService;
    siem: SiemForwarder;
    requireStaffMfa: boolean;
  },
) {
  const { db, authed, recent, settings, emergency, siem } = deps;
  const actorOf = (req: FastifyRequest) => req.session!.actor;
  const event = (req: FastifyRequest, action: string, detail = '') =>
    db.insert(schema.securityEvents).values({
      orgId: actorOf(req).orgId,
      userId: actorOf(req).id,
      actor: actorOf(req).name,
      action,
      detail: detail.slice(0, 300),
      ip: req.ip,
    });
  const owner = (req: FastifyRequest) => {
    if (actorOf(req).role !== 'owner') throw new HttpError(403, 'Only the owner can change vault policies.');
    return actorOf(req).orgId;
  };

  /** Active accounts that can reach passwords without an authenticator app or passkey. */
  async function withoutMfa(orgId: string, policy: VaultPolicy): Promise<VaultPolicyView['mfa']['withoutMfa']> {
    const roles: Role[] = ['owner', 'admin', 'technician', 'client_editor'];
    if (!policy.blockReadOnlyReveal) roles.push('client_viewer');
    const users = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.disabled, false), inArray(schema.users.role, roles)));
    const out: VaultPolicyView['mfa']['withoutMfa'] = [];
    for (const user of users) {
      if (hasMfa(user)) continue;
      // A technician reaches passwords only where they have "edit + passwords".
      if (user.role === 'technician') {
        const levels = await clientLevels(db, actorFor(user));
        if (![...levels.values()].includes('edit_passwords')) continue;
      }
      out.push({ id: user.id, name: user.name, email: user.email, role: user.role as Role });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- vault policies ----
  // Everyone signed in reads the policy: the generator and the reveal prompts follow it.
  app.get('/api/vault/policy', authed, async (req) => settings.vaultPolicy(actorOf(req).orgId));
  app.get('/api/settings/vault-policy', authed, async (req): Promise<VaultPolicyView> => {
    requireAdmin(actorOf(req));
    const policy = await settings.vaultPolicy(actorOf(req).orgId);
    return {
      ...policy,
      mfa: { requiredForStaff: deps.requireStaffMfa, withoutMfa: await withoutMfa(actorOf(req).orgId, policy) },
    };
  });
  app.put('/api/settings/vault-policy', authed, async (req) => {
    const orgId = owner(req);
    recent(req);
    const saved = await settings.saveVaultPolicy(orgId, req.body);
    await event(req, 'Vault policies changed', describe(saved));
    return {
      ...saved,
      mfa: { requiredForStaff: deps.requireStaffMfa, withoutMfa: await withoutMfa(orgId, saved) },
    } satisfies VaultPolicyView;
  });

  // ---- emergency access ----
  app.get('/api/emergency-access', authed, async (req) => emergency.view(actorOf(req)));
  app.put('/api/emergency-access/contacts', authed, async (req) => {
    recent(req);
    return emergency.saveContact(actorOf(req), req.body ?? {}, req.ip);
  });
  app.delete<{ Params: Params }>('/api/emergency-access/contacts/:id', authed, async (req) => {
    recent(req);
    return emergency.removeContact(actorOf(req), req.params.id, req.ip);
  });
  app.post('/api/emergency-access/requests', authed, async (req) => {
    recent(req);
    return emergency.request(actorOf(req), req.body ?? {}, req.ip);
  });
  app.post<{ Params: Params }>('/api/emergency-access/requests/:id/approve', authed, async (req) => {
    recent(req);
    return emergency.approve(actorOf(req), req.params.id, req.ip);
  });
  app.post<{ Params: Params }>('/api/emergency-access/requests/:id/deny', authed, async (req) =>
    emergency.deny(actorOf(req), req.params.id, req.ip),
  );
  app.post<{ Params: Params }>('/api/emergency-access/requests/:id/end', authed, async (req) =>
    emergency.end(actorOf(req), req.params.id, req.ip),
  );

  // ---- SIEM ----
  const admin = (req: FastifyRequest) => {
    requireAdmin(actorOf(req));
    return actorOf(req).orgId;
  };
  app.get('/api/settings/siem', authed, async (req) => siem.view(admin(req)));
  app.put('/api/settings/siem', authed, async (req) => {
    const orgId = admin(req);
    recent(req);
    const saved = await settings.saveSiem(orgId, req.body, await siem.newest(orgId));
    const logs = [saved.security && 'security', saved.vault && 'vault'].filter(Boolean).join(' and ');
    await event(
      req,
      'SIEM streaming changed',
      !saved.enabled
        ? 'Off'
        : saved.method === 'webhook'
          ? `Webhook ${new URL(saved.url).host} · ${logs}`
          : `Syslog ${saved.transport.toUpperCase()} ${saved.host}:${saved.port} · ${logs}`,
    );
    return siem.view(orgId);
  });
  app.post('/api/settings/siem/test', authed, async (req) => {
    const orgId = admin(req);
    await siem.test(orgId, actorOf(req).name);
    await event(req, 'SIEM test event sent');
    return { ok: true };
  });
  // Sends what's waiting now instead of on the next background pass.
  app.post('/api/settings/siem/send', authed, async (req) => {
    const orgId = admin(req);
    const result = await siem.forward(orgId);
    if (result.error) throw new HttpError(502, result.error);
    return { ...(await siem.view(orgId)), sent: result.sent };
  });
}
