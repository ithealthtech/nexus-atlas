import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor, AuditVerification } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { KeyProvider } from '../crypto/keys.js';
import type { SettingsService } from './settings.js';

/** Spreadsheet apps run cells that start with these characters as formulas. */
const csvCell = (value: unknown) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export const toCsv = (header: string[], rows: unknown[][]) =>
  [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/**
 * The security log is hash-chained by a database trigger (see migration 0004). Verification recomputes every hash.
 * A signed checkpoint of the newest row, kept with a key derived from the master key, also catches rows deleted
 * from the end of the chain, which a chain alone can't show.
 */
export class AuditService {
  constructor(
    private readonly db: Database,
    private readonly keys: KeyProvider,
    private readonly settings: SettingsService,
  ) {}

  private mac(keyId: string, orgId: string, id: string, hash: string) {
    const key = createHmac('sha256', this.keys.key(keyId)).update('atlas-audit-checkpoint').digest();
    return `${keyId}:${createHmac('sha256', key).update(`${orgId}|${id}|${hash}`).digest('base64url')}`;
  }

  private macMatches(orgId: string, id: string, hash: string, mac: string) {
    const keyId = mac.split(':')[0] ?? '';
    try {
      const expected = Buffer.from(this.mac(keyId, orgId, id, hash));
      const actual = Buffer.from(mac);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false; // The key that signed it is no longer loaded.
    }
  }

  /** Signs the newest row as the checkpoint. Run after verifying, and on a schedule. */
  async checkpoint(orgId: string) {
    const [last] = await this.db
      .select({ id: schema.securityEvents.id, hash: schema.securityEvents.hash })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.orgId, orgId))
      .orderBy(desc(schema.securityEvents.id))
      .limit(1);
    if (!last) return;
    const id = String(last.id);
    await this.settings.saveAuditCheckpoint(orgId, {
      id,
      hash: last.hash,
      mac: this.mac(this.keys.keyId, orgId, id, last.hash),
      at: new Date().toISOString(),
    });
  }

  async verify(actor: Actor): Promise<AuditVerification> {
    requireAdmin(actor);
    const orgId = actor.orgId;
    const result = await this.db.execute(sql`
      select id::text as id, prev_hash, hash, atlas_event_hash(prev_hash, e) as expected
      from security_events e where org_id = ${orgId} order by id`);
    const rows = result.rows as { id: string; prev_hash: string; hash: string; expected: string }[];
    let brokenAt: string | null = null;
    rows.forEach((row, i) => {
      if (brokenAt) return;
      // The oldest remaining row may point at a row removed by the retention policy.
      const linked = i === 0 || row.prev_hash === rows[i - 1]!.hash;
      if (row.hash !== row.expected || !linked) brokenAt = row.id;
    });
    const saved = await this.settings.auditCheckpoint(orgId);
    let checkpoint: AuditVerification['checkpoint'] = 'missing';
    if (saved) {
      const row = rows.find((r) => r.id === saved.id);
      checkpoint =
        row && row.hash === saved.hash && this.macMatches(orgId, saved.id, saved.hash, saved.mac) ? 'ok' : 'mismatch';
    }
    const ok = !brokenAt && checkpoint !== 'mismatch';
    if (ok) await this.checkpoint(orgId);
    return {
      ok,
      checked: rows.length,
      firstId: rows[0]?.id ?? null,
      lastId: rows.at(-1)?.id ?? null,
      brokenAt,
      checkpoint,
      checkedAt: new Date().toISOString(),
    };
  }

  async exportSecurity(actor: Actor): Promise<string> {
    requireAdmin(actor);
    const rows = await this.db
      .select()
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.orgId, actor.orgId))
      .orderBy(asc(schema.securityEvents.id));
    return toCsv(
      ['id', 'time_utc', 'actor', 'action', 'detail', 'ip', 'prev_hash', 'hash'],
      rows.map((r) => [r.id, r.createdAt.toISOString(), r.actor, r.action, r.detail, r.ip, r.prevHash, r.hash]),
    );
  }

  async exportVault(actor: Actor): Promise<string> {
    requireAdmin(actor);
    const rows = await this.db
      .select({ a: schema.vaultAudit, clientName: schema.clients.name })
      .from(schema.vaultAudit)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.vaultAudit.clientId))
      .where(eq(schema.vaultAudit.orgId, actor.orgId))
      .orderBy(asc(schema.vaultAudit.id));
    return toCsv(
      ['id', 'time_utc', 'actor', 'action', 'client', 'password', 'reason', 'ip'],
      rows.map(({ a, clientName }) => [
        a.id,
        a.createdAt.toISOString(),
        a.actorName,
        a.action,
        clientName ?? '',
        a.passwordName,
        a.reason,
        a.ip,
      ]),
    );
  }

  /** Deletes log rows older than the organization's retention setting (none by default). */
  async applyRetention(orgId: string) {
    const { auditRetentionDays } = await this.settings.notifications(orgId);
    if (!auditRetentionDays) return;
    const before = new Date(Date.now() - auditRetentionDays * 86_400_000);
    await this.db
      .delete(schema.securityEvents)
      .where(and(eq(schema.securityEvents.orgId, orgId), lt(schema.securityEvents.createdAt, before)));
    await this.db
      .delete(schema.vaultAudit)
      .where(and(eq(schema.vaultAudit.orgId, orgId), lt(schema.vaultAudit.createdAt, before)));
  }
}
