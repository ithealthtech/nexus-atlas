import { constants, createHash, createPrivateKey, generateKeyPair, privateDecrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { and, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  bitlockerReportSchema,
  createBitlockerEnrollmentSchema,
  type Actor,
  type BitlockerDeviceView,
  type BitlockerEnrollmentCreated,
  type BitlockerEnrollmentView,
  type BitlockerReport,
} from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import type { VaultKeys } from '../crypto/vault-keys.js';
import { HttpError } from '../errors.js';
import { actorFor } from '../identity/service.js';
import { bitlockerKeysIn } from './bitlocker-keys.js';
import { collectorScript } from './bitlocker-collector-script.js';
import { ClientService } from './clients.js';
import { linkItems } from './integrations/cw-rmm.js';
import { isUuid, Scope } from './scope.js';
import type { VaultService } from './vault.js';

const generate = promisify(generateKeyPair);
const SOURCE = 'bitlocker-collector';
const LINK_NOTE = 'BitLocker recovery key (collector)';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const keyAad = (enrollmentId: string) => `bitlocker-enrollment|${enrollmentId}|private-key`;
const norm = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

type BitlockerVolume = schema.BitlockerVolume;
type EnrollmentRow = typeof schema.bitlockerEnrollments.$inferSelect;
type DeviceRow = typeof schema.bitlockerDevices.$inferSelect;

/**
 * A machine is protected only if every volume it reported is. One volume with protection off is a finding, and
 * one that couldn't be read means nobody knows: it never counts as protected.
 */
function statusOf(volumes: BitlockerVolume[]): BitlockerDeviceView['status'] {
  if (volumes.some((v) => v.protection === 'Off')) return 'unprotected';
  return volumes.length && volumes.every((v) => v.protection === 'On') ? 'protected' : 'unknown';
}

/**
 * The BitLocker collector's server side. An administrator enrolls a client (or one device) and gets a script for
 * the RMM. The script encrypts each recovery password to the enrollment's public key; here the report is checked,
 * the passwords are decrypted with the private key (sealed under the organization's vault key) and saved to the
 * client's vault, and the machine's encryption status is kept for its asset.
 */
export class BitlockerCollectorService {
  constructor(
    private readonly db: Database,
    private readonly keys: VaultKeys,
    private readonly vault: VaultService,
    private readonly publicOrigin: string,
  ) {}

  private enrollmentView(row: EnrollmentRow, clientName: string, devices: number): BitlockerEnrollmentView {
    return {
      id: row.id,
      clientId: row.clientId,
      clientName,
      name: row.name,
      scope: row.scope as BitlockerEnrollmentView['scope'],
      revoked: !!row.revokedAt,
      devices,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private deviceView(row: DeviceRow, clientName: string, assetName: string | null): BitlockerDeviceView {
    return {
      id: row.id,
      enrollmentId: row.enrollmentId,
      clientId: row.clientId,
      clientName,
      hostname: row.hostname,
      os: row.os,
      serialNumber: row.serialNumber,
      assetId: row.assetId,
      assetName,
      volumes: row.volumes.map((v) => ({
        mountPoint: v.mountPoint,
        protection: v.protection,
        encryptionMethod: v.encryptionMethod,
        encryptionPercentage: v.encryptionPercentage,
        conversionStatus: v.conversionStatus,
        keys: v.keyIds.length,
        error: v.error ?? null,
      })),
      status: statusOf(row.volumes),
      collectedAt: row.collectedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      blocked: row.blocked,
    };
  }

  // ---------- administration ----------
  async overview(actor: Actor): Promise<{ enrollments: BitlockerEnrollmentView[]; devices: BitlockerDeviceView[] }> {
    requireAdmin(actor);
    const e = schema.bitlockerEnrollments;
    const d = schema.bitlockerDevices;
    const enrollments = await this.db
      .select({ row: e, clientName: schema.clients.name })
      .from(e)
      .innerJoin(schema.clients, eq(schema.clients.id, e.clientId))
      .where(eq(e.orgId, actor.orgId))
      .orderBy(desc(e.createdAt));
    const devices = await this.db
      .select({ row: d, clientName: schema.clients.name, assetName: schema.assets.name })
      .from(d)
      .innerJoin(schema.clients, eq(schema.clients.id, d.clientId))
      .leftJoin(schema.assets, eq(schema.assets.id, d.assetId))
      .where(eq(d.orgId, actor.orgId))
      .orderBy(schema.clients.name, d.hostname);
    const counts = new Map<string, number>();
    for (const x of devices) counts.set(x.row.enrollmentId, (counts.get(x.row.enrollmentId) ?? 0) + 1);
    return {
      enrollments: enrollments.map((x) => this.enrollmentView(x.row, x.clientName, counts.get(x.row.id) ?? 0)),
      devices: devices.map((x) => this.deviceView(x.row, x.clientName, x.assetName)),
    };
  }

  /** Makes an enrollment and returns its script. The token inside is stored only as a hash, so this is the one time. */
  async enroll(actor: Actor, input: unknown, ip: string): Promise<BitlockerEnrollmentCreated> {
    requireAdmin(actor);
    const body = createBitlockerEnrollmentSchema.parse(input);
    const client = await new ClientService(this.db).get(actor, body.clientId);
    const { publicKey, privateKey } = await generate('rsa', { modulusLength: 3072 });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const base64 = (url: string) => Buffer.from(url, 'base64url').toString('base64');
    const token = randomBytes(32).toString('hex');
    const row = await this.db.transaction(async (tx) => {
      const [made] = await tx
        .insert(schema.bitlockerEnrollments)
        .values({
          orgId: actor.orgId,
          clientId: client.id,
          name: body.name,
          scope: body.scope,
          tokenHash: sha256(token),
          publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          // Filled in below, once the row's ID (part of what the seal is bound to) is known.
          privateKey: '',
          createdBy: actor.id,
        })
        .returning();
      const sealed = await this.keys.seal(
        actor.orgId,
        privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        keyAad(made!.id),
      );
      await tx
        .update(schema.bitlockerEnrollments)
        .set({ privateKey: sealed })
        .where(eq(schema.bitlockerEnrollments.id, made!.id));
      await tx.insert(schema.securityEvents).values({
        orgId: actor.orgId,
        userId: actor.id,
        actor: actor.name,
        action: 'BitLocker collector enrolled',
        detail: `${client.name}: ${body.name} (${body.scope === 'device' ? 'one device' : 'all devices'})`.slice(
          0,
          300,
        ),
        ip,
      });
      return made!;
    });
    return {
      enrollment: this.enrollmentView(row, client.name, 0),
      filename: `Atlas-BitLocker-${client.name.replace(/[^\w-]+/g, '-').slice(0, 40)}.ps1`,
      script: collectorScript({
        name: `${client.name}: ${body.name}`,
        agentId: row.id,
        endpoint: `${this.publicOrigin}/api/bitlocker/ingest`,
        token,
        modulus: base64(jwk.n),
        exponent: base64(jwk.e),
      }),
    };
  }

  private async enrollment(actor: Actor, id: string) {
    requireAdmin(actor);
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.bitlockerEnrollments)
          .where(and(eq(schema.bitlockerEnrollments.id, id), eq(schema.bitlockerEnrollments.orgId, actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'Enrollment not found.');
    return row;
  }

  /** Stops an enrollment's script from uploading. Keys already in the vault and the devices' status stay. */
  async revoke(actor: Actor, id: string, ip: string) {
    const row = await this.enrollment(actor, id);
    if (row.revokedAt) return;
    await this.db
      .update(schema.bitlockerEnrollments)
      .set({ revokedAt: new Date() })
      .where(eq(schema.bitlockerEnrollments.id, id));
    await this.db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'BitLocker collector enrollment revoked',
      detail: row.name.slice(0, 300),
      ip,
    });
  }

  /** Refuses (or accepts again) one machine's reports without touching the rest of its enrollment. */
  async setBlocked(actor: Actor, deviceId: string, blocked: boolean, ip: string) {
    requireAdmin(actor);
    const [row] = isUuid(deviceId)
      ? await this.db
          .update(schema.bitlockerDevices)
          .set({ blocked })
          .where(and(eq(schema.bitlockerDevices.id, deviceId), eq(schema.bitlockerDevices.orgId, actor.orgId)))
          .returning()
      : [];
    if (!row) throw new HttpError(404, 'Device not found.');
    await this.db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: blocked ? 'BitLocker collector device blocked' : 'BitLocker collector device unblocked',
      detail: row.hostname.slice(0, 300),
      ip,
    });
  }

  /** The encryption status the collector last reported for an asset's machine, for anyone who can read the asset. */
  async forAsset(scope: Scope, assetId: string): Promise<BitlockerDeviceView[]> {
    const [asset] = isUuid(assetId)
      ? await scope.db
          .select({ id: schema.assets.id, name: schema.assets.name, clientId: schema.assets.clientId })
          .from(schema.assets)
          .where(and(eq(schema.assets.id, assetId), eq(schema.assets.orgId, scope.actor.orgId)))
      : [];
    if (!asset) throw new HttpError(404, 'Asset not found.');
    await scope.require(asset.clientId, 'read', 'Asset');
    const rows = await scope.db
      .select({ row: schema.bitlockerDevices, clientName: schema.clients.name })
      .from(schema.bitlockerDevices)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.bitlockerDevices.clientId))
      .where(and(eq(schema.bitlockerDevices.assetId, assetId), eq(schema.bitlockerDevices.orgId, scope.actor.orgId)))
      .orderBy(desc(schema.bitlockerDevices.collectedAt));
    return rows.map((x) => this.deviceView(x.row, x.clientName, asset.name));
  }

  // ---------- reports from machines ----------
  /** The enrollment a token belongs to, or null. Revoked ones are returned so the caller can say so. */
  async enrollmentForToken(token: string): Promise<EnrollmentRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.bitlockerEnrollments)
      .where(eq(schema.bitlockerEnrollments.tokenHash, sha256(token)));
    return row ?? null;
  }

  /** Who the collector's vault entries are saved as: the administrator who enrolled it, or failing that an owner. */
  private async actorFor(enrollment: EnrollmentRow): Promise<Actor> {
    const users = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, enrollment.orgId), eq(schema.users.disabled, false)));
    const able = users.filter((u) => u.role === 'owner' || u.role === 'admin');
    const user = able.find((u) => u.id === enrollment.createdBy) ?? able.find((u) => u.role === 'owner') ?? able[0];
    if (!user) throw new HttpError(503, 'No administrator is available to receive the report.');
    // Vault history and activity name the collector, not just the person it acts for.
    return { ...actorFor(user), name: `BitLocker collector (${enrollment.name})`.slice(0, 120) };
  }

  /** The client's asset for a machine: by serial number first, then by name or hostname. */
  private async matchAsset(orgId: string, clientId: string, report: BitlockerReport): Promise<string | null> {
    const rows = await this.db
      .select({ id: schema.assets.id, name: schema.assets.name, fields: schema.assets.fields })
      .from(schema.assets)
      .where(
        and(eq(schema.assets.orgId, orgId), eq(schema.assets.clientId, clientId), eq(schema.assets.archived, false)),
      );
    const serial = norm(report.serialNumber);
    const host = norm(report.hostname);
    const field = (r: (typeof rows)[number], key: string) => norm((r.fields as Record<string, unknown>)[key]);
    // Placeholder serials ("To be filled by O.E.M.", "0", "System Serial Number") are shared by many machines.
    const realSerial = serial.length >= 5 && !/o\.?e\.?m|serial|default|^0+$|none|n\/a/.test(serial);
    const bySerial = realSerial ? rows.filter((r) => field(r, 'serial_number') === serial) : [];
    if (bySerial.length === 1) return bySerial[0]!.id;
    const byName = rows.filter((r) => norm(r.name) === host || field(r, 'hostname') === host);
    return byName.length === 1 ? byName[0]!.id : null;
  }

  /**
   * Takes in one report. A repeated report changes nothing. A report older than the machine's latest still has
   * its keys saved (a key is a fact, whenever it was read), but doesn't overwrite the newer status.
   */
  async ingest(enrollment: EnrollmentRow, input: unknown, ip: string) {
    const parsed = bitlockerReportSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, 'Invalid report.');
    const report = parsed.data;
    if (report.agentId !== enrollment.id) throw new HttpError(403, 'Wrong enrollment.');
    const collectedAt = new Date(report.collectedAt);
    const d = schema.bitlockerDevices;
    const assetId = await this.matchAsset(enrollment.orgId, enrollment.clientId, report);
    const volumes: BitlockerVolume[] = report.volumes.map((v) => ({
      volumeId: v.volumeId,
      mountPoint: v.mountPoint,
      protection: v.protection,
      encryptionMethod: v.encryptionMethod,
      encryptionPercentage: v.encryptionPercentage,
      conversionStatus: v.conversionStatus,
      keyIds: v.protectors.map((k) => k.keyId),
      ...(v.error ? { error: v.error } : {}),
    }));

    const device = await this.db.transaction(async (tx) => {
      // One report at a time per enrollment, so the checks below can't race a second upload.
      const [current] = await tx
        .select()
        .from(schema.bitlockerEnrollments)
        .where(eq(schema.bitlockerEnrollments.id, enrollment.id))
        .for('update');
      if (!current || current.revokedAt) throw new HttpError(403, 'Enrollment revoked.', 'revoked');
      const known = await tx.select().from(d).where(eq(d.enrollmentId, enrollment.id));
      const existing = known.find((x) => x.machineId === report.machineId);
      // A one-device enrollment belongs to the first machine that used it.
      if (current.scope === 'device' && !existing && known.length)
        throw new HttpError(403, 'Enrollment belongs to a different machine.', 'machine');
      if (existing?.blocked) throw new HttpError(403, 'Device blocked.', 'blocked');
      const fresh = await tx
        .insert(schema.bitlockerReports)
        .values({ enrollmentId: enrollment.id, reportId: report.reportId })
        .onConflictDoNothing()
        .returning();
      if (!fresh.length) return null;
      await tx
        .update(schema.bitlockerEnrollments)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.bitlockerEnrollments.id, enrollment.id));
      const details = {
        hostname: report.hostname,
        os: report.os,
        serialNumber: report.serialNumber,
        // An asset matched earlier is kept if this report matches nothing (renamed in Atlas, say).
        assetId: assetId ?? existing?.assetId ?? null,
        lastSeenAt: new Date(),
      };
      if (!existing) {
        const [made] = await tx
          .insert(d)
          .values({
            orgId: enrollment.orgId,
            clientId: enrollment.clientId,
            enrollmentId: enrollment.id,
            machineId: report.machineId,
            volumes,
            collectedAt,
            ...details,
          })
          .returning();
        return made!;
      }
      const newer = collectedAt.getTime() > existing.collectedAt.getTime();
      const [updated] = await tx
        .update(d)
        .set(newer ? { ...details, volumes, collectedAt } : { lastSeenAt: new Date() })
        .where(eq(d.id, existing.id))
        .returning();
      return updated!;
    });
    if (!device) return { accepted: false, duplicate: true };
    // Once a day, forget report IDs old enough that a replay would change nothing anyway.
    if (Date.now() - this.pruned > 86_400_000) {
      this.pruned = Date.now();
      await this.prune();
    }

    // Decrypt and save the keys. Outside the transaction, because the vault does its own. If anything here fails,
    // the report is forgotten again, so the script's retry is processed in full instead of being acknowledged as a
    // duplicate and deleted with keys unsaved. (Saving is by key, so a retry never saves one twice.)
    try {
      const { saved, rejected } = await this.saveKeys(enrollment, device, report, ip);
      return { accepted: true, keys: saved, ...(rejected ? { rejected } : {}) };
    } catch (error) {
      await this.db
        .delete(schema.bitlockerReports)
        .where(
          and(
            eq(schema.bitlockerReports.enrollmentId, enrollment.id),
            eq(schema.bitlockerReports.reportId, report.reportId),
          ),
        );
      throw error;
    }
  }

  /** Decrypts a report's recovery passwords and saves the new ones to the vault, linked to the machine's asset. */
  private async saveKeys(enrollment: EnrollmentRow, device: DeviceRow, report: BitlockerReport, ip: string) {
    const pem = await this.keys.open(enrollment.orgId, enrollment.privateKey, keyAad(enrollment.id));
    const privateKey = createPrivateKey(pem);
    const actor = await this.actorFor(enrollment);
    const scope = new Scope(this.db, actor);
    const r = schema.externalRefs;
    let saved = 0;
    let rejected = 0;
    for (const volume of report.volumes)
      for (const protector of volume.protectors) {
        let key: string;
        try {
          key = privateDecrypt(
            { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
            Buffer.from(protector.cipher, 'base64'),
          ).toString('utf8');
        } catch {
          rejected++;
          continue;
        }
        // Only a real recovery password, and nothing else, is ever put in the vault from a report.
        const [found] = bitlockerKeysIn([{ name: '', value: key }]);
        if (!found || found.key !== key) {
          rejected++;
          continue;
        }
        const externalId = `${device.id}:${sha256(key).slice(0, 24)}`;
        const [seen] = await this.db
          .select({ id: r.entityId })
          .from(r)
          .where(
            and(eq(r.orgId, enrollment.orgId), eq(r.source, SOURCE), eq(r.kind, 'key'), eq(r.externalId, externalId)),
          );
        // The same protector may already be in the vault, typed in or imported from the RMM's custom field.
        const [same] = seen
          ? []
          : await this.db
              .select({ id: schema.passwords.id })
              .from(schema.passwords)
              .where(
                and(
                  eq(schema.passwords.orgId, enrollment.orgId),
                  eq(schema.passwords.clientId, enrollment.clientId),
                  eq(schema.passwords.kind, 'bitlocker'),
                  sql`lower(${schema.passwords.username}) = ${protector.keyId.toLowerCase()}`,
                ),
              );
        let passwordId = seen?.id ?? same?.id;
        if (!passwordId) {
          const created = await this.vault.create(
            scope,
            enrollment.clientId,
            {
              kind: 'bitlocker',
              name: `${report.hostname} · ${volume.mountPoint || 'BitLocker'}`.slice(0, 200),
              username: protector.keyId.toUpperCase(),
              secret: key,
              notes: `Collected from ${report.hostname} by the BitLocker collector, ${report.collectedAt.slice(0, 10)}.`,
            },
            ip,
          );
          passwordId = created.id;
          saved++;
        }
        if (!seen)
          await this.db
            .insert(r)
            .values({ orgId: enrollment.orgId, source: SOURCE, kind: 'key', externalId, entityId: passwordId })
            .onConflictDoNothing();
        if (device.assetId)
          await linkItems(
            this.db,
            enrollment.orgId,
            { type: 'asset', id: device.assetId },
            { type: 'password', id: passwordId },
            LINK_NOTE,
          );
      }
    return { saved, rejected };
  }

  private pruned = 0;
  private async prune(olderThanDays = 90) {
    await this.db
      .delete(schema.bitlockerReports)
      .where(sql`${schema.bitlockerReports.receivedAt} < now() - make_interval(days => ${olderThanDays})`);
  }
}
