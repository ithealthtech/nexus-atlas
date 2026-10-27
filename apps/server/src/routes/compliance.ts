import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { schema, type Database } from '@atlas/db';
import { ACCESS_REVIEW_DAYS, ROLE_INFO, type Role } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { hasMfa } from '../identity/service.js';
import { AccessReviewService } from '../services/access-reviews.js';
import type { AuditService } from '../services/audit.js';
import { Scope } from '../services/scope.js';
import { securityEvent } from '../services/security-log.js';
import type { SettingsService } from '../services/settings.js';

const DAY = 86_400_000;
const csv = (header: string[], rows: string[][]) =>
  [header, ...rows].map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n') + '\r\n';
const yes = (b: boolean) => (b ? 'Yes' : 'No');
const safe = (name: string) => name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();

/**
 * The compliance evidence pack: one download for SOC 2 auditors or insurers, for the whole organization. It
 * holds proof the security log is intact (its hash chain is checked as the pack is made), the security log
 * itself, everyone's two-factor status, the vault policies, and each client's latest signed-off access review.
 * Administrators only, with a fresh password confirmation, like the log export.
 */
export function registerComplianceRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authed: { onRequest: onRequestHookHandler };
    recent: (req: FastifyRequest) => void;
    settings: SettingsService;
    audit: AuditService;
    requireStaffMfa: boolean;
  },
) {
  const { db, authed, recent, settings, audit } = deps;
  const reviews = new AccessReviewService(db);

  app.get('/api/compliance/evidence-pack', authed, async (req, reply) => {
    const actor = req.session!.actor;
    requireAdmin(actor);
    recent(req);
    const organization = req.session!.organization.name;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const files: Record<string, Uint8Array> = {};
    const summary: string[] = [];

    // 1. The security log's hash chain, checked now.
    const chain = await audit.verify(actor);
    files['01 Security log integrity.txt'] = strToU8(
      [
        `Security log integrity check for ${organization}`,
        `Checked ${chain.checkedAt} by ${actor.name}.`,
        '',
        `Result: ${chain.ok ? 'INTACT' : 'NOT INTACT'}`,
        `Entries checked: ${chain.checked} (ids ${chain.firstId ?? '-'} to ${chain.lastId ?? '-'})`,
        `First broken entry: ${chain.brokenAt ?? 'none'}`,
        `Signed checkpoint: ${chain.checkpoint === 'ok' ? 'matches' : chain.checkpoint === 'missing' ? 'none yet' : 'DOES NOT MATCH'}`,
        '',
        'Each entry stores a hash of its contents and of the entry before it, so changing or removing an entry',
        'breaks the chain from that point. A database trigger blocks edits, and a checkpoint signed with the',
        "server's key records the newest entry, so the chain can't be quietly rebuilt either.",
        '',
      ].join('\r\n'),
    );
    files['02 Security log.csv'] = strToU8(await audit.exportSecurity(actor));
    summary.push(`Security log: ${chain.ok ? 'intact' : 'NOT INTACT'}, ${chain.checked} entries checked.`);

    // 2. Everyone's account and two-factor status.
    const users = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.orgId, actor.orgId))
      .orderBy(schema.users.name);
    const active = users.filter((u) => !u.disabled);
    const staff = active.filter((u) => ROLE_INFO[u.role as Role].staff);
    files['03 Team and two-factor.csv'] = strToU8(
      csv(
        ['Name', 'Email', 'Role', 'Enabled', 'Two-factor', 'Last sign-in'],
        users.map((u) => [
          u.name,
          u.email,
          ROLE_INFO[u.role as Role].label,
          yes(!u.disabled),
          yes(hasMfa(u)),
          u.lastLoginAt?.toISOString() ?? 'Never',
        ]),
      ),
    );
    summary.push(
      `Two-factor: ${staff.filter(hasMfa).length} of ${staff.length} active staff, ${active.filter(hasMfa).length} of ${active.length} active accounts${deps.requireStaffMfa ? '; required for staff' : ''}.`,
    );

    // 3. Vault policies, in words.
    const policy = await settings.vaultPolicy(actor.orgId);
    files['04 Vault policies.txt'] = strToU8(
      [
        `Vault policies for ${organization}, as of ${day}`,
        '',
        `Two-factor required for staff: ${yes(deps.requireStaffMfa)}`,
        `Reason required for every reveal, copy, and share: ${yes(policy.requireRevealReason)}`,
        `Read-only roles can't reveal passwords: ${yes(policy.blockReadOnlyReveal)}`,
        `Restricted passwords only for the people listed on them: ${yes(policy.restrictedListedOnly)}`,
        `Personal vaults: ${policy.personalVaults ? 'On' : 'Off'}`,
        `Generated passwords: at least ${policy.generator.minLength} characters${policy.generator.requireDigits ? ', with digits' : ''}${policy.generator.requireSymbols ? ', with symbols' : ''}${policy.generator.allowPins ? '' : ', no PINs'}`,
        '',
        'Every reveal, copy, share, and file download of a password is recorded in its access history.',
        '',
      ].join('\r\n'),
    );

    // 4. Each client's latest signed-off access review, as the PDF it was signed as.
    const clients = await db
      .select({ id: schema.clients.id, name: schema.clients.name })
      .from(schema.clients)
      .where(eq(schema.clients.orgId, actor.orgId))
      .orderBy(schema.clients.name);
    const signed = await db
      .select({
        id: schema.accessReviews.id,
        clientId: schema.accessReviews.clientId,
        at: schema.accessReviews.completedAt,
      })
      .from(schema.accessReviews)
      .where(and(eq(schema.accessReviews.orgId, actor.orgId), isNotNull(schema.accessReviews.completedAt)))
      .orderBy(desc(schema.accessReviews.completedAt));
    const brand = await settings.branding(actor.orgId);
    const scope = new Scope(db, actor);
    const rows: string[][] = [];
    let current = 0;
    for (const c of clients) {
      const latest = signed.find((s) => s.clientId === c.id);
      const inDate = !!latest?.at && now.getTime() - latest.at.getTime() <= ACCESS_REVIEW_DAYS * DAY;
      if (inDate) current++;
      rows.push([c.name, latest?.at?.toISOString().slice(0, 10) ?? 'Never', latest ? yes(inDate) : 'No']);
      if (!latest) continue;
      const { data } = await reviews.pdf(scope, latest.id, organization, {
        name: brand.brandName,
        logo: brand.logo,
        accent: brand.accent,
      });
      files[`05 Access reviews/${safe(c.name)}.pdf`] = data;
    }
    files['05 Access reviews/Summary.csv'] = strToU8(
      csv(['Client', 'Last signed off', `Within ${ACCESS_REVIEW_DAYS} days`], rows),
    );
    summary.push(
      `Access reviews: ${current} of ${clients.length} clients signed off in the last ${ACCESS_REVIEW_DAYS} days.`,
    );

    files['README.txt'] = strToU8(
      [
        `Compliance evidence pack for ${organization}`,
        `Prepared ${now.toISOString()} by ${actor.name} from Atlas.`,
        '',
        ...summary,
        '',
        '01 Security log integrity.txt  The hash chain check, run as this pack was made.',
        '02 Security log.csv            Every security event, with its hashes.',
        '03 Team and two-factor.csv     Every account, its role, and whether it uses two-factor sign-in.',
        '04 Vault policies.txt          How passwords are protected.',
        "05 Access reviews/             Each client's latest signed-off review, and a summary.",
        '',
        'Passwords and document contents are never included.',
        '',
      ].join('\r\n'),
    );
    await securityEvent(db, {
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'Downloaded compliance evidence pack',
      detail: summary.join(' '),
      ip: req.ip,
    });
    return reply
      .header('cache-control', 'no-store')
      .header(
        'content-disposition',
        `attachment; filename="atlas-compliance-${day}.zip"; filename*=UTF-8''${encodeURIComponent(`${safe(organization)} compliance evidence ${day}.zip`)}`,
      )
      .type('application/zip')
      .send(Buffer.from(zipSync(files, { level: 6 })));
  });
}
