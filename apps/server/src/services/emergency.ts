import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  EMERGENCY_ACCESS_HOURS,
  emergencyContactSchema,
  emergencyRequestSchema,
  type Actor,
  type EmergencyAccessView,
  type EmergencyStatus,
} from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import type { MailService } from './mail.js';
import { isUuid } from './scope.js';

type RequestRow = typeof schema.emergencyRequests.$inferSelect;
const HOUR = 3_600_000;

export function emergencyStatus(r: RequestRow, now = new Date()): EmergencyStatus {
  if (r.deniedAt) return 'denied';
  if (r.endedAt) return 'ended';
  if (r.endsAt <= now) return 'expired';
  return (r.approvedAt ?? r.availableAt) <= now ? 'active' : 'pending';
}

const requireOwner = (actor: Actor) => {
  if (actor.role !== 'owner') throw new HttpError(403, 'Only the owner can do this.');
};
const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;

/**
 * Emergency access: the owner names administrators they trust, each with a waiting period. A trusted administrator
 * can ask for access to every restricted password; the owner is told at once and can deny it until the wait is over
 * (or approve it sooner). Access then lasts EMERGENCY_ACCESS_HOURS. Every step is a security event and an email, and
 * each password used through it is marked in the vault's access history (VaultService.audit).
 *
 * The access itself is granted by Scope.restrictedAccess; it only matters where restricted passwords are for listed
 * people only, since otherwise administrators already see them.
 */
export class EmergencyAccessService {
  constructor(
    private readonly db: Database,
    private readonly mail: MailService,
    private readonly publicOrigin: string,
  ) {}

  private event(actor: Actor | null, orgId: string, action: string, detail: string, ip = '') {
    return this.db.insert(schema.securityEvents).values({
      orgId,
      userId: actor?.id ?? null,
      actor: actor?.name ?? 'Atlas',
      action,
      detail: detail.slice(0, 300),
      ip: ip.slice(0, 64),
    });
  }

  /** Emails people; email trouble never blocks the safeguard it reports on. */
  private async tell(orgId: string, to: string[], subject: string, paragraphs: string[]) {
    try {
      if (!to.length || !(await this.mail.enabled(orgId))) return;
      const [org] = await this.db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, orgId));
      const action = { label: 'Open vault policies', url: `${this.publicOrigin}/admin/vault-policies` };
      for (const address of new Set(to))
        await this.mail
          .send(orgId, org?.name ?? 'MSP Atlas', { to: address, subject, paragraphs, action })
          .catch(() => undefined);
    } catch {
      // Unreadable email settings are reported on the status page; they never stop the request itself.
    }
  }

  private async owners(orgId: string) {
    const rows = await this.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.role, 'owner'), eq(schema.users.disabled, false)));
    return rows.map((r) => r.email);
  }

  private async emailOf(userId: string | null) {
    if (!userId) return [];
    const [row] = await this.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    return row ? [row.email] : [];
  }

  private async contact(orgId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(schema.emergencyContacts)
      .where(and(eq(schema.emergencyContacts.orgId, orgId), eq(schema.emergencyContacts.userId, userId)));
    return row ?? null;
  }

  async view(actor: Actor): Promise<EmergencyAccessView> {
    requireAdmin(actor);
    const owner = actor.role === 'owner';
    const c = schema.emergencyContacts;
    const contacts = await this.db
      .select({
        userId: c.userId,
        name: schema.users.name,
        email: schema.users.email,
        waitHours: c.waitHours,
        addedByName: c.addedByName,
        createdAt: c.createdAt,
      })
      .from(c)
      .innerJoin(schema.users, eq(schema.users.id, c.userId))
      .where(and(eq(c.orgId, actor.orgId), ...(owner ? [] : [eq(c.userId, actor.id)])))
      .orderBy(schema.users.name);
    const r = schema.emergencyRequests;
    const requests = await this.db
      .select()
      .from(r)
      .where(and(eq(r.orgId, actor.orgId), ...(owner ? [] : [eq(r.userId, actor.id)])))
      .orderBy(desc(r.requestedAt))
      .limit(50);
    const now = new Date();
    const mine = contacts.find((x) => x.userId === actor.id);
    return {
      canManage: owner,
      me: { trusted: !!mine, waitHours: mine?.waitHours ?? null },
      contacts: contacts.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
      requests: requests.map((x) => ({
        id: x.id,
        userId: x.userId,
        userName: x.userName,
        reason: x.reason,
        status: emergencyStatus(x, now),
        requestedAt: x.requestedAt.toISOString(),
        availableAt: (x.approvedAt ?? x.availableAt).toISOString(),
        endsAt: x.endsAt.toISOString(),
        decidedByName: x.decidedByName,
        decidedAt: (x.deniedAt ?? x.endedAt ?? x.approvedAt)?.toISOString() ?? null,
      })),
    };
  }

  /** Adds a trusted administrator, or changes their waiting period. */
  async saveContact(actor: Actor, input: unknown, ip: string) {
    requireOwner(actor);
    const body = emergencyContactSchema.parse(input);
    const [user] = await this.db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        role: schema.users.role,
        disabled: schema.users.disabled,
      })
      .from(schema.users)
      .where(and(eq(schema.users.id, body.userId), eq(schema.users.orgId, actor.orgId)));
    if (!user) throw new HttpError(404, 'Person not found.');
    if (user.role !== 'admin' || user.disabled)
      throw new HttpError(400, 'Choose an active administrator. The owner already has access to everything.');
    const existing = await this.contact(actor.orgId, user.id);
    await this.db
      .insert(schema.emergencyContacts)
      .values({ orgId: actor.orgId, userId: user.id, waitHours: body.waitHours, addedByName: actor.name })
      .onConflictDoUpdate({
        target: [schema.emergencyContacts.orgId, schema.emergencyContacts.userId],
        set: { waitHours: body.waitHours },
      });
    await this.event(
      actor,
      actor.orgId,
      existing ? 'Emergency access wait changed' : 'Emergency access contact added',
      `${user.name} · wait ${hours(body.waitHours)}`,
      ip,
    );
    await this.tell(actor.orgId, await this.emailOf(user.id), 'Atlas: you can request emergency access', [
      `${actor.name} named you as a trusted administrator for emergency access to restricted passwords.`,
      `If you ever request it, the owner is told at once and has ${hours(body.waitHours)} to deny it before access starts.`,
    ]);
    return this.view(actor);
  }

  /** Removes a trusted administrator; any request of theirs that is waiting or running ends. */
  async removeContact(actor: Actor, userId: string, ip: string) {
    requireOwner(actor);
    const existing = isUuid(userId) ? await this.contact(actor.orgId, userId) : null;
    if (!existing) throw new HttpError(404, 'That person is not a trusted administrator.');
    const [user] = await this.db
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.emergencyContacts)
        .where(and(eq(schema.emergencyContacts.orgId, actor.orgId), eq(schema.emergencyContacts.userId, userId)));
      await tx
        .update(schema.emergencyRequests)
        .set({ endedAt: new Date(), decidedByName: actor.name })
        .where(and(this.open(actor.orgId), eq(schema.emergencyRequests.userId, userId)));
    });
    await this.event(actor, actor.orgId, 'Emergency access contact removed', user?.name ?? 'Unknown', ip);
    return this.view(actor);
  }

  /** Requests that are waiting or running. */
  private open(orgId: string) {
    const r = schema.emergencyRequests;
    return and(eq(r.orgId, orgId), isNull(r.deniedAt), isNull(r.endedAt), gt(r.endsAt, new Date()));
  }

  async request(actor: Actor, input: unknown, ip: string) {
    requireAdmin(actor);
    const body = emergencyRequestSchema.parse(input);
    const contact = actor.role === 'admin' ? await this.contact(actor.orgId, actor.id) : null;
    if (!contact)
      throw new HttpError(403, 'The owner hasn’t named you as a trusted administrator for emergency access.');
    const [open] = await this.db
      .select({ id: schema.emergencyRequests.id })
      .from(schema.emergencyRequests)
      .where(and(this.open(actor.orgId), eq(schema.emergencyRequests.userId, actor.id)));
    if (open) throw new HttpError(409, 'You already have an emergency access request waiting or running.');
    const now = Date.now();
    const availableAt = new Date(now + contact.waitHours * HOUR);
    await this.db.insert(schema.emergencyRequests).values({
      orgId: actor.orgId,
      userId: actor.id,
      userName: actor.name,
      reason: body.reason,
      requestedAt: new Date(now),
      availableAt,
      endsAt: new Date(availableAt.getTime() + EMERGENCY_ACCESS_HOURS * HOUR),
    });
    await this.event(
      actor,
      actor.orgId,
      'Emergency access requested',
      `Starts ${availableAt.toISOString()} unless denied · ${body.reason}`,
      ip,
    );
    await this.tell(actor.orgId, await this.owners(actor.orgId), 'Atlas: emergency access was requested', [
      `${actor.name} asked for emergency access to restricted passwords. Their reason: “${body.reason}”`,
      `Access starts at ${availableAt.toUTCString()} and lasts ${hours(EMERGENCY_ACCESS_HOURS)}, unless you deny it first. You can also approve it now.`,
      'If you did not expect this, deny it and check who is using that administrator’s account.',
    ]);
    return this.view(actor);
  }

  private async load(actor: Actor, id: string) {
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.emergencyRequests)
          .where(and(eq(schema.emergencyRequests.id, id), eq(schema.emergencyRequests.orgId, actor.orgId)))
      : [];
    // Administrators only see their own requests.
    if (!row || (actor.role !== 'owner' && row.userId !== actor.id)) throw new HttpError(404, 'Request not found.');
    return row;
  }

  /** The owner starts a waiting request now instead of at the end of the wait. */
  async approve(actor: Actor, id: string, ip: string) {
    requireOwner(actor);
    const row = await this.load(actor, id);
    if (emergencyStatus(row) !== 'pending') throw new HttpError(409, 'Only a waiting request can be approved.');
    const now = new Date();
    await this.db
      .update(schema.emergencyRequests)
      .set({
        approvedAt: now,
        endsAt: new Date(now.getTime() + EMERGENCY_ACCESS_HOURS * HOUR),
        decidedByName: actor.name,
        startNoticeAt: now,
      })
      .where(eq(schema.emergencyRequests.id, row.id));
    await this.event(actor, actor.orgId, 'Emergency access approved', row.userName, ip);
    await this.tell(actor.orgId, await this.emailOf(row.userId), 'Atlas: your emergency access was approved', [
      `${actor.name} approved your request for emergency access. It is on now and lasts ${hours(EMERGENCY_ACCESS_HOURS)}.`,
      'Each password you use is recorded as emergency access in its access history.',
    ]);
    return this.view(actor);
  }

  async deny(actor: Actor, id: string, ip: string) {
    requireOwner(actor);
    const row = await this.load(actor, id);
    if (emergencyStatus(row) !== 'pending') throw new HttpError(409, 'Only a waiting request can be denied.');
    await this.db
      .update(schema.emergencyRequests)
      .set({ deniedAt: new Date(), decidedByName: actor.name })
      .where(eq(schema.emergencyRequests.id, row.id));
    await this.event(actor, actor.orgId, 'Emergency access denied', row.userName, ip);
    await this.tell(actor.orgId, await this.emailOf(row.userId), 'Atlas: your emergency access was denied', [
      `${actor.name} denied your request for emergency access to restricted passwords.`,
    ]);
    return this.view(actor);
  }

  /** Ends a waiting or running request: the owner revoking it, or the administrator who asked withdrawing it. */
  async end(actor: Actor, id: string, ip: string) {
    requireAdmin(actor);
    const row = await this.load(actor, id);
    const status = emergencyStatus(row);
    if (status !== 'pending' && status !== 'active') throw new HttpError(409, 'This request has already finished.');
    await this.db
      .update(schema.emergencyRequests)
      .set({ endedAt: new Date(), decidedByName: actor.name })
      .where(eq(schema.emergencyRequests.id, row.id));
    const own = row.userId === actor.id;
    await this.event(
      actor,
      actor.orgId,
      status === 'pending' ? 'Emergency access request withdrawn' : 'Emergency access ended',
      row.userName,
      ip,
    );
    await this.tell(
      actor.orgId,
      own ? await this.owners(actor.orgId) : await this.emailOf(row.userId),
      'Atlas: emergency access ended',
      [
        own
          ? `${actor.name} ${status === 'pending' ? 'withdrew their request for' : 'ended their'} emergency access.`
          : `${actor.name} ended your emergency access to restricted passwords.`,
      ],
    );
    return this.view(actor);
  }

  /**
   * Run in the background: logs and announces each request whose wait has just ended, once. The access itself starts
   * on time whether or not this has run.
   */
  async announceStarts(orgId: string, now = new Date()) {
    const r = schema.emergencyRequests;
    const started = await this.db
      .update(r)
      .set({ startNoticeAt: now })
      .where(
        and(
          this.open(orgId),
          isNull(r.startNoticeAt),
          lte(r.availableAt, now),
          // Still trusted: removing the contact ends the request anyway, but not in the same statement.
          sql`exists (select 1 from ${schema.emergencyContacts} c where c.org_id = ${r.orgId} and c.user_id = ${r.userId})`,
        ),
      )
      .returning();
    for (const row of started) {
      await this.event(null, orgId, 'Emergency access started', `${row.userName} · until ${row.endsAt.toISOString()}`);
      await this.tell(
        orgId,
        [...(await this.owners(orgId)), ...(await this.emailOf(row.userId))],
        'Atlas: emergency access has started',
        [
          `The wait is over and ${row.userName} now has emergency access to restricted passwords, until ${row.endsAt.toUTCString()}.`,
          'The owner can end it at any time in Settings → Vault policies.',
        ],
      );
    }
    return started.length;
  }
}
