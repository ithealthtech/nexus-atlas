import type { Database } from '@atlas/db';
import { ROLE_INFO, atLeast, type AccessLevel, type Actor } from '@atlas/shared';
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

  get canReadGlobal() {
    return ROLE_INFO[this.actor.role].staff;
  }
}
