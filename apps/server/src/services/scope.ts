import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { ROLE_INFO, atLeast, vaultPolicySchema, type AccessLevel, type Actor, type VaultPolicy } from '@atlas/shared';
import { clientLevels } from '../authz.js';
import { HttpError } from '../errors.js';

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Per-request view of what the actor can reach. Client items follow per-client levels;
 * the MSP-wide knowledge base (clientId = null) is staff-only: technicians and admins edit, read-only technicians read.
 */
export class Scope {
  private cached?: Promise<Map<string, AccessLevel>>;
  private policyCache?: Promise<VaultPolicy>;
  private restrictedCache?: Promise<RestrictedAccess>;
  constructor(
    readonly db: Database,
    readonly actor: Actor,
  ) {}

  levels() {
    return (this.cached ??= clientLevels(this.db, this.actor));
  }

  async level(clientId: string | null): Promise<AccessLevel> {
    if (clientId === null) {
      const info = ROLE_INFO[this.actor.role];
      if (!info.staff) return 'none';
      return info.cap === 'read' ? 'read' : 'edit';
    }
    return (await this.levels()).get(clientId) ?? 'none';
  }

  /** Throws 404 when the actor has no access (so existence isn't revealed) and 403 when access is too low. */
  async require(clientId: string | null, required: AccessLevel, what = 'Item'): Promise<AccessLevel> {
    const level = await this.level(clientId);
    if (level === 'none') throw new HttpError(404, `${what} not found.`);
    if (!atLeast(level, required)) throw new HttpError(403, 'Your access here is read-only.');
    return level;
  }

  async readableClientIds(): Promise<string[]> {
    return [...(await this.levels())].filter(([, level]) => level !== 'none').map(([id]) => id);
  }

  /** The organization's vault policies. */
  policy() {
    return (this.policyCache ??= vaultPolicy(this.db, this.actor.orgId));
  }

  /**
   * Which restricted passwords the actor may use besides those they're listed on: `all` (the owner, and
   * administrators unless restricted passwords are for listed people only), `emergency` (all, through emergency
   * access that is running now), or `listed` (only those).
   */
  restrictedAccess() {
    return (this.restrictedCache ??= this.findRestrictedAccess());
  }

  private async findRestrictedAccess(): Promise<RestrictedAccess> {
    const { role } = this.actor;
    if (role === 'owner') return 'all';
    if (!ROLE_INFO[role].admin) return 'listed';
    if (!(await this.policy()).restrictedListedOnly) return 'all';
    return (await activeEmergencyRequest(this.db, this.actor)) ? 'emergency' : 'listed';
  }

  get canReadGlobal() {
    return ROLE_INFO[this.actor.role].staff;
  }
}

export type RestrictedAccess = 'all' | 'emergency' | 'listed';

export async function vaultPolicy(db: Database, orgId: string): Promise<VaultPolicy> {
  const [row] = await db
    .select({ policy: sql<unknown>`${schema.orgs.settings} -> 'vaultPolicy'` })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId));
  return vaultPolicySchema.parse(row?.policy ?? {});
}

/**
 * The actor's emergency access running now, if any: an administrator still on the owner's trusted list, whose
 * request's wait has passed (or the owner approved it), and which hasn't been denied, ended, or run out.
 */
export async function activeEmergencyRequest(db: Database, actor: Actor) {
  if (!ROLE_INFO[actor.role].admin) return null;
  const r = schema.emergencyRequests;
  const now = new Date();
  const [row] = await db
    .select({ id: r.id, endsAt: r.endsAt })
    .from(r)
    .innerJoin(
      schema.emergencyContacts,
      and(eq(schema.emergencyContacts.orgId, r.orgId), eq(schema.emergencyContacts.userId, r.userId)),
    )
    .where(
      and(
        eq(r.orgId, actor.orgId),
        eq(r.userId, actor.id),
        isNull(r.deniedAt),
        isNull(r.endedAt),
        sql`coalesce(${r.approvedAt}, ${r.availableAt}) <= ${now}`,
        gt(r.endsAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}
