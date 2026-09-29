import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  complexityProblem,
  rotationCandidateSchema,
  rotationComplexitySchema,
  rotationPolicySchema,
  rotationResultSchema,
  rotationSettingsSchema,
  rotationTargetSchema,
  rotationTargetUpdateSchema,
  ROTATION_ACCOUNT_TYPE_LABELS,
  type Actor,
  type RotationAccountType,
  type RotationComplexity,
  type RotationPolicyView,
  type RotationRunStatus,
  type RotationRunView,
  type RotationSettings,
  type RotationTargetView,
} from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { CwRmmClient, ROTATION_SCOPES } from './integrations/cw-rmm.js';
import type { MailService } from './mail.js';
import { isUuid, Scope } from './scope.js';
import type { SettingsService } from './settings.js';
import { ROTATION_ACTOR, type VaultService } from './vault.js';

const DAY = 86_400_000;
/** How long a device has to report back before the run fails and its token stops working. */
export const RUN_HOURS = 2;
/** After a failed attempt, the scheduler waits this long before trying the same account again. */
const RETRY_AFTER = DAY;
const OPEN: RotationRunStatus[] = ['dispatched', 'candidate'];
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKEN = /^Bearer (atlasrot_[A-Za-z0-9_-]{43})$/;

type Run = typeof schema.rotationRuns.$inferSelect;
type Policy = typeof schema.rotationPolicies.$inferSelect;

/**
 * Automated password rotation: per-client policies, the vault passwords enrolled for rotation, and each attempt.
 *
 * An attempt runs the Atlas rotation script on the account's ConnectWise RMM device with a token for that attempt
 * only. The script generates a password to the policy, reports it (Atlas seals it to the attempt), sets it, then
 * reports whether that worked. Only a confirmed change reaches the vault; anything else keeps the old password and
 * raises an alert.
 */
export class RotationService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      vault: VaultService;
      settings: SettingsService;
      mail: MailService;
      publicOrigin: string;
      fetcher?: typeof fetch;
    },
  ) {}

  private event(actor: { orgId: string; id: string | null; name: string }, action: string, detail = '', ip = '') {
    return this.db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action,
      detail: detail.slice(0, 300),
      ip: ip.slice(0, 64),
    });
  }

  // ---------- settings ----------
  async settingsView(actor: Actor) {
    requireAdmin(actor);
    return this.deps.settings.rotation(actor.orgId);
  }

  async saveSettings(actor: Actor, input: unknown, ip: string): Promise<RotationSettings> {
    requireAdmin(actor);
    // Checked before saving, so refused settings never take effect.
    const body = rotationSettingsSchema.parse(input);
    if (body.enabled && !body.scriptId)
      throw new HttpError(400, 'Enter the ConnectWise RMM script ID before turning rotation on.', undefined, {
        scriptId: 'Enter the script ID.',
      });
    const saved = await this.deps.settings.saveRotation(actor.orgId, body);
    await this.event(
      actor,
      'Password rotation settings changed',
      `${saved.enabled ? 'On' : 'Off'} · script ${saved.scriptId || 'not set'}`,
      ip,
    );
    // Turning rotation off also stops any attempt in progress.
    if (!saved.enabled) await this.cancelOpen(actor.orgId, undefined, 'Password rotation was turned off.');
    return saved;
  }

  // ---------- policies ----------
  async policies(actor: Actor): Promise<RotationPolicyView[]> {
    requireAdmin(actor);
    const rows = await this.db
      .select({ p: schema.rotationPolicies, clientName: schema.clients.name })
      .from(schema.rotationPolicies)
      .leftJoin(schema.clients, eq(schema.clients.id, schema.rotationPolicies.clientId))
      .where(eq(schema.rotationPolicies.orgId, actor.orgId))
      .orderBy(sql`${schema.clients.name} asc nulls first`, schema.rotationPolicies.accountType);
    const scope = new Scope(this.db, actor);
    const out: RotationPolicyView[] = [];
    for (const r of rows) {
      if (r.p.clientId && (await scope.level(r.p.clientId)) !== 'edit_passwords') continue;
      out.push(this.policyView(r.p, r.clientName));
    }
    return out;
  }

  private policyView(p: Policy, clientName: string | null): RotationPolicyView {
    return {
      id: p.id,
      clientId: p.clientId,
      clientName,
      accountType: p.accountType as RotationAccountType,
      intervalDays: p.intervalDays,
      complexity: rotationComplexitySchema.parse(p.complexity),
      enabled: p.enabled,
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  /** Creates or replaces the policy for this client (or every client) and account type. */
  async savePolicy(actor: Actor, input: unknown, ip: string): Promise<RotationPolicyView> {
    requireAdmin(actor);
    const body = rotationPolicySchema.parse(input);
    let clientName: string | null = null;
    if (body.clientId) {
      await this.requireVaultClient(actor, body.clientId);
      [{ name: clientName }] = (await this.db
        .select({ name: schema.clients.name })
        .from(schema.clients)
        .where(eq(schema.clients.id, body.clientId))) as [{ name: string }];
    }
    const values = {
      intervalDays: body.intervalDays,
      complexity: body.complexity,
      enabled: body.enabled,
      updatedBy: actor.id,
      updatedAt: new Date(),
    };
    const [existing] = await this.db
      .select({ id: schema.rotationPolicies.id })
      .from(schema.rotationPolicies)
      .where(
        and(
          eq(schema.rotationPolicies.orgId, actor.orgId),
          body.clientId
            ? eq(schema.rotationPolicies.clientId, body.clientId)
            : isNull(schema.rotationPolicies.clientId),
          eq(schema.rotationPolicies.accountType, body.accountType),
        ),
      );
    const [row] = existing
      ? await this.db
          .update(schema.rotationPolicies)
          .set(values)
          .where(eq(schema.rotationPolicies.id, existing.id))
          .returning()
      : await this.db
          .insert(schema.rotationPolicies)
          .values({ orgId: actor.orgId, clientId: body.clientId, accountType: body.accountType, ...values })
          .returning();
    const c = body.complexity;
    await this.event(
      actor,
      existing ? 'Password rotation policy changed' : 'Password rotation policy added',
      `${ROTATION_ACCOUNT_TYPE_LABELS[body.accountType]} · ${clientName ?? 'All clients'} · every ${body.intervalDays} days · ${c.length} characters${body.enabled ? '' : ' · paused'}`,
      ip,
    );
    return this.policyView(row!, clientName);
  }

  async deletePolicy(actor: Actor, id: string, ip: string) {
    requireAdmin(actor);
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.rotationPolicies)
          .where(and(eq(schema.rotationPolicies.id, id), eq(schema.rotationPolicies.orgId, actor.orgId)))
      : [];
    if (!row || (row.clientId && !(await this.canUseVault(actor, row.clientId))))
      throw new HttpError(404, 'Policy not found.');
    await this.db.delete(schema.rotationPolicies).where(eq(schema.rotationPolicies.id, row.id));
    await this.event(
      actor,
      'Password rotation policy removed',
      `${ROTATION_ACCOUNT_TYPE_LABELS[row.accountType as RotationAccountType]} · ${row.clientId ? 'one client' : 'All clients'}`,
      ip,
    );
  }

  /** The policy for an account: the client's own, else the organization-wide one. */
  private async policyFor(orgId: string, clientId: string, accountType: string): Promise<Policy | null> {
    const rows = await this.db
      .select()
      .from(schema.rotationPolicies)
      .where(
        and(
          eq(schema.rotationPolicies.orgId, orgId),
          eq(schema.rotationPolicies.accountType, accountType),
          sql`(${schema.rotationPolicies.clientId} = ${clientId} or ${schema.rotationPolicies.clientId} is null)`,
        ),
      );
    return rows.find((r) => r.clientId === clientId) ?? rows.find((r) => r.clientId === null) ?? null;
  }

  // ---------- access ----------
  private async canUseVault(actor: Actor, clientId: string) {
    return (await new Scope(this.db, actor).level(clientId)) === 'edit_passwords';
  }

  /** Not found, never forbidden, for a client the actor can't use the vault of. */
  private async requireVaultClient(actor: Actor, clientId: string) {
    if (!(await this.canUseVault(actor, clientId))) throw new HttpError(404, 'Client not found.');
  }

  // ---------- enrolled accounts ----------
  async targets(actor: Actor): Promise<RotationTargetView[]> {
    requireAdmin(actor);
    const t = schema.rotationTargets;
    const rows = await this.db
      .select({
        t,
        clientName: schema.clients.name,
        passwordName: schema.passwords.name,
        username: schema.passwords.username,
        assetName: schema.assets.name,
      })
      .from(t)
      .innerJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .innerJoin(schema.passwords, eq(schema.passwords.id, t.passwordId))
      .innerJoin(schema.assets, eq(schema.assets.id, t.assetId))
      .where(eq(t.orgId, actor.orgId))
      .orderBy(schema.clients.name, schema.passwords.name);
    const scope = new Scope(this.db, actor);
    const visible = [];
    for (const r of rows) if ((await scope.level(r.t.clientId)) === 'edit_passwords') visible.push(r);
    if (!visible.length) return [];
    const policies = await this.db
      .select()
      .from(schema.rotationPolicies)
      .where(eq(schema.rotationPolicies.orgId, actor.orgId));
    const lastRuns = await this.db
      .selectDistinctOn([schema.rotationRuns.targetId], {
        targetId: schema.rotationRuns.targetId,
        status: schema.rotationRuns.status,
        error: schema.rotationRuns.error,
      })
      .from(schema.rotationRuns)
      .where(
        inArray(
          schema.rotationRuns.targetId,
          visible.map((r) => r.t.id),
        ),
      )
      .orderBy(schema.rotationRuns.targetId, desc(schema.rotationRuns.createdAt));
    const last = new Map(lastRuns.map((r) => [r.targetId, r]));
    return visible.map((r) => {
      const policy =
        policies.find((p) => p.clientId === r.t.clientId && p.accountType === r.t.accountType) ??
        policies.find((p) => p.clientId === null && p.accountType === r.t.accountType);
      const active = policy?.enabled ? policy : null;
      const run = last.get(r.t.id);
      return {
        id: r.t.id,
        clientId: r.t.clientId,
        clientName: r.clientName,
        passwordId: r.t.passwordId,
        passwordName: r.passwordName,
        username: r.username,
        assetId: r.t.assetId,
        assetName: r.assetName,
        accountType: r.t.accountType as RotationAccountType,
        enabled: r.t.enabled,
        policyId: active?.id ?? null,
        intervalDays: active?.intervalDays ?? null,
        lastRotatedAt: r.t.lastRotatedAt?.toISOString() ?? null,
        nextDueAt:
          active && r.t.enabled
            ? new Date(
                r.t.lastRotatedAt ? r.t.lastRotatedAt.getTime() + active.intervalDays * DAY : r.t.createdAt.getTime(),
              ).toISOString()
            : null,
        lastStatus: (run?.status as RotationRunStatus | undefined) ?? null,
        lastError: run?.error ?? '',
      };
    });
  }

  /** A client's devices synced from ConnectWise RMM: the ones the rotation script can run on. */
  async devices(actor: Actor, clientId: string): Promise<{ id: string; name: string }[]> {
    requireAdmin(actor);
    await this.requireVaultClient(actor, clientId);
    return this.db
      .select({ id: schema.assets.id, name: schema.assets.name })
      .from(schema.assets)
      .innerJoin(
        schema.externalRefs,
        and(
          eq(schema.externalRefs.orgId, schema.assets.orgId),
          eq(schema.externalRefs.source, 'cw-rmm'),
          eq(schema.externalRefs.kind, 'assets'),
          eq(schema.externalRefs.entityId, schema.assets.id),
        ),
      )
      .where(
        and(
          eq(schema.assets.orgId, actor.orgId),
          eq(schema.assets.clientId, clientId),
          eq(schema.assets.archived, false),
        ),
      )
      .orderBy(sql`lower(${schema.assets.name})`);
  }

  /** The RMM device an asset was synced from, or null when it wasn't. */
  private async endpointOf(orgId: string, assetId: string): Promise<string | null> {
    const [ref] = await this.db
      .select({ id: schema.externalRefs.externalId })
      .from(schema.externalRefs)
      .where(
        and(
          eq(schema.externalRefs.orgId, orgId),
          eq(schema.externalRefs.source, 'cw-rmm'),
          eq(schema.externalRefs.kind, 'assets'),
          eq(schema.externalRefs.entityId, assetId),
        ),
      );
    return ref?.id ?? null;
  }

  async addTarget(actor: Actor, input: unknown, ip: string) {
    requireAdmin(actor);
    const body = rotationTargetSchema.parse(input);
    // The vault's own check: the actor must be able to use this password (client access and restriction lists).
    const password = await this.deps.vault.get(new Scope(this.db, actor), body.passwordId);
    if (password.kind !== 'login') throw new HttpError(400, 'Only logins can be rotated.');
    if (!password.username.trim())
      throw new HttpError(
        400,
        'Add the account’s username to the password entry first; the script changes that account.',
      );
    const [asset] = await this.db
      .select({
        id: schema.assets.id,
        clientId: schema.assets.clientId,
        name: schema.assets.name,
        archived: schema.assets.archived,
      })
      .from(schema.assets)
      .where(and(eq(schema.assets.id, body.assetId), eq(schema.assets.orgId, actor.orgId)));
    // A device in another client is reported as missing, like any record the password can't be paired with.
    if (!asset || asset.clientId !== password.clientId) throw new HttpError(404, 'Device not found in this client.');
    if (asset.archived) throw new HttpError(400, 'That device is archived.');
    if (!(await this.endpointOf(actor.orgId, asset.id)))
      throw new HttpError(
        400,
        'That device isn’t synced from ConnectWise RMM, so the rotation script can’t run on it.',
      );
    const [row] = await this.db
      .insert(schema.rotationTargets)
      .values({
        orgId: actor.orgId,
        clientId: password.clientId,
        passwordId: password.id,
        assetId: asset.id,
        accountType: body.accountType,
        createdBy: actor.id,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HttpError(409, 'That password is already set to rotate.');
    await this.event(
      actor,
      'Password enrolled for automatic rotation',
      `${password.name} (${password.clientName}) on ${asset.name}`,
      ip,
    );
    return (await this.targets(actor)).find((t) => t.id === row.id)!;
  }

  private async target(actor: Actor, id: string) {
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.rotationTargets)
          .where(and(eq(schema.rotationTargets.id, id), eq(schema.rotationTargets.orgId, actor.orgId)))
      : [];
    if (!row || !(await this.canUseVault(actor, row.clientId))) throw new HttpError(404, 'Rotation not found.');
    return row;
  }

  async updateTarget(actor: Actor, id: string, input: unknown, ip: string) {
    requireAdmin(actor);
    const row = await this.target(actor, id);
    const { enabled } = rotationTargetUpdateSchema.parse(input);
    await this.db.update(schema.rotationTargets).set({ enabled }).where(eq(schema.rotationTargets.id, row.id));
    if (!enabled) await this.cancelOpen(actor.orgId, row.id, 'Rotation for this account was paused.');
    await this.event(
      actor,
      enabled ? 'Password rotation resumed' : 'Password rotation paused',
      await this.label(row),
      ip,
    );
    return (await this.targets(actor)).find((t) => t.id === row.id)!;
  }

  async removeTarget(actor: Actor, id: string, ip: string) {
    requireAdmin(actor);
    const row = await this.target(actor, id);
    await this.cancelOpen(actor.orgId, row.id, 'This account was taken out of rotation.');
    const label = await this.label(row);
    await this.db.delete(schema.rotationTargets).where(eq(schema.rotationTargets.id, row.id));
    await this.event(actor, 'Password removed from automatic rotation', label, ip);
  }

  private async label(row: { passwordId: string; assetId: string }) {
    const [r] = await this.db
      .select({ password: schema.passwords.name, asset: schema.assets.name })
      .from(schema.passwords)
      .innerJoin(schema.assets, eq(schema.assets.id, row.assetId))
      .where(eq(schema.passwords.id, row.passwordId));
    return r ? `${r.password} on ${r.asset}` : '';
  }

  // ---------- attempts ----------
  async runs(actor: Actor): Promise<RotationRunView[]> {
    requireAdmin(actor);
    const r = schema.rotationRuns;
    const rows = await this.db
      .select({ r, clientName: schema.clients.name })
      .from(r)
      .innerJoin(schema.clients, eq(schema.clients.id, r.clientId))
      .where(eq(r.orgId, actor.orgId))
      .orderBy(desc(r.createdAt))
      .limit(200);
    const scope = new Scope(this.db, actor);
    const out: RotationRunView[] = [];
    for (const row of rows) {
      if ((await scope.level(row.r.clientId)) !== 'edit_passwords') continue;
      out.push({
        id: row.r.id,
        targetId: row.r.targetId,
        clientName: row.clientName,
        passwordId: row.r.passwordId,
        passwordName: row.r.passwordName,
        assetName: row.r.assetName,
        status: row.r.status as RotationRunStatus,
        error: row.r.error,
        startedByName: row.r.startedByName,
        createdAt: row.r.createdAt.toISOString(),
        expiresAt: row.r.expiresAt.toISOString(),
        finishedAt: row.r.finishedAt?.toISOString() ?? null,
      });
    }
    return out;
  }

  /** Starts an attempt now for one account, whatever its schedule. */
  async rotateNow(actor: Actor, id: string, ip: string) {
    requireAdmin(actor);
    const row = await this.target(actor, id);
    const runId = await this.dispatch(actor.orgId, row, { id: actor.id, name: actor.name });
    await this.event(actor, 'Password rotation started', await this.label(row), ip);
    return (await this.runs(actor)).find((r) => r.id === runId)!;
  }

  /** Cancels an attempt; its token stops working at once. */
  async cancelRun(actor: Actor, id: string, ip: string) {
    requireAdmin(actor);
    const [run] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.rotationRuns)
          .where(and(eq(schema.rotationRuns.id, id), eq(schema.rotationRuns.orgId, actor.orgId)))
      : [];
    if (!run || !(await this.canUseVault(actor, run.clientId))) throw new HttpError(404, 'Rotation attempt not found.');
    if (!OPEN.includes(run.status as RotationRunStatus)) throw new HttpError(409, 'That attempt has already finished.');
    await this.close(run, 'cancelled', `Cancelled by ${actor.name}.`);
    await this.event(actor, 'Password rotation cancelled', `${run.passwordName} on ${run.assetName}`, ip);
  }

  /** Revokes every outstanding device token in the organization by cancelling the attempts they belong to. */
  async revokeAll(actor: Actor, ip: string) {
    requireAdmin(actor);
    const count = await this.cancelOpen(actor.orgId, undefined, `Device tokens revoked by ${actor.name}.`);
    await this.event(actor, 'Password rotation device tokens revoked', `${count} outstanding`, ip);
    return { revoked: count };
  }

  private async cancelOpen(orgId: string, targetId: string | undefined, reason: string) {
    const open = await this.db
      .select()
      .from(schema.rotationRuns)
      .where(
        and(
          eq(schema.rotationRuns.orgId, orgId),
          inArray(schema.rotationRuns.status, OPEN),
          targetId ? eq(schema.rotationRuns.targetId, targetId) : undefined,
        ),
      );
    for (const run of open) await this.close(run, 'cancelled', reason);
    return open.length;
  }

  /**
   * Ends an open attempt without applying it. A password the device already reported is kept in the entry's
   * history, since the device may have set it. Returns false when the attempt had already ended.
   */
  private async close(run: Run, status: 'failed' | 'cancelled', error: string, keepCandidate = true): Promise<boolean> {
    // The row is locked and re-read, so a password the device reports at this moment is either refused (the
    // attempt is already closed) or seen here and kept; it can't slip in between.
    const candidate = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: schema.rotationRuns.status, candidate: schema.rotationRuns.candidate })
        .from(schema.rotationRuns)
        .where(eq(schema.rotationRuns.id, run.id))
        .for('update');
      if (!row || !OPEN.includes(row.status as RotationRunStatus)) return undefined;
      await tx
        .update(schema.rotationRuns)
        .set({ status, error: error.slice(0, 500), finishedAt: new Date() })
        .where(eq(schema.rotationRuns.id, run.id));
      return row.candidate;
    });
    if (candidate === undefined) return false;
    if (candidate) {
      if (keepCandidate && run.passwordId)
        await this.deps.vault.keepUnconfirmedCandidate(this.db, run.orgId, {
          id: run.id,
          passwordId: run.passwordId,
          candidate,
        });
      // Cleared only once it is safely in the history.
      await this.db.update(schema.rotationRuns).set({ candidate: null }).where(eq(schema.rotationRuns.id, run.id));
    }
    return true;
  }

  /** Marks an attempt failed and alerts: vault access history, the security log, and email to administrators. */
  private async fail(run: Run, error: string, keepCandidate = true) {
    if (!(await this.close(run, 'failed', error, keepCandidate))) return;
    const what = `${run.passwordName} on ${run.assetName}`;
    await this.event(
      { orgId: run.orgId, id: null, name: ROTATION_ACTOR },
      'Password rotation failed',
      `${what}: ${error}`,
    );
    if (run.passwordId)
      await this.db.insert(schema.vaultAudit).values({
        orgId: run.orgId,
        clientId: run.clientId,
        passwordId: run.passwordId,
        passwordName: run.passwordName,
        actorName: ROTATION_ACTOR,
        action: 'Automatic rotation failed; the password was not changed',
        reason: error.slice(0, 300),
      });
    await this.alert(run, error).catch(() => undefined);
  }

  private async alert(run: Run, error: string) {
    if (!(await this.deps.mail.enabled(run.orgId))) return;
    const [org] = await this.db
      .select({ name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, run.orgId));
    const admins = await this.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.orgId, run.orgId),
          eq(schema.users.disabled, false),
          inArray(schema.users.role, ['owner', 'admin']),
        ),
      );
    for (const a of admins)
      await this.deps.mail.send(run.orgId, org?.name ?? 'MSP Atlas', {
        to: a.email,
        subject: `Password rotation failed: ${run.passwordName}`,
        paragraphs: [
          `The automatic rotation of ${run.passwordName} on ${run.assetName} did not complete. The password in Atlas was not changed.`,
          `Reason: ${error}`,
        ],
        action: run.passwordId
          ? { label: 'Open the password', url: `${this.deps.publicOrigin}/passwords/${run.passwordId}` }
          : undefined,
      });
  }

  /**
   * Starts an attempt: a token for this attempt only, then the script on the device. Returns the attempt's ID.
   */
  private async dispatch(
    orgId: string,
    target: typeof schema.rotationTargets.$inferSelect,
    by: { id: string | null; name: string },
  ): Promise<string> {
    const settings = await this.deps.settings.rotation(orgId);
    if (!settings.enabled || !settings.scriptId)
      throw new HttpError(400, 'Turn password rotation on and enter the ConnectWise RMM script ID first.');
    const rmm = await this.deps.settings.cwRmm(orgId);
    if (!rmm) throw new HttpError(400, 'Connect ConnectWise RMM first.');
    if (!target.enabled) throw new HttpError(400, 'Rotation for this account is paused.');
    const policy = await this.policyFor(orgId, target.clientId, target.accountType);
    if (!policy?.enabled)
      throw new HttpError(
        400,
        `No active rotation policy covers ${ROTATION_ACCOUNT_TYPE_LABELS[target.accountType as RotationAccountType].toLowerCase()} accounts for this client.`,
      );
    const [info] = await this.db
      .select({
        passwordName: schema.passwords.name,
        username: schema.passwords.username,
        archived: schema.passwords.archived,
        assetName: schema.assets.name,
      })
      .from(schema.passwords)
      .innerJoin(schema.assets, eq(schema.assets.id, target.assetId))
      .where(eq(schema.passwords.id, target.passwordId));
    if (!info) throw new HttpError(404, 'Rotation not found.');
    if (info.archived) throw new HttpError(400, 'The password is archived. Restore it to rotate it.');
    const endpointId = await this.endpointOf(orgId, target.assetId);
    const companyId = Object.entries(rmm.map).find(
      ([, m]) => m.action === 'link' && m.clientId === target.clientId,
    )?.[0];
    const complexity = rotationComplexitySchema.parse(policy.complexity);
    const token = `atlasrot_${randomBytes(32).toString('base64url')}`;
    const now = new Date();
    let run: Run;
    try {
      [run] = (await this.db
        .insert(schema.rotationRuns)
        .values({
          orgId,
          clientId: target.clientId,
          targetId: target.id,
          passwordId: target.passwordId,
          passwordName: info.passwordName,
          assetName: info.assetName,
          tokenHash: hashToken(token),
          complexity,
          startedBy: by.id,
          startedByName: by.name,
          expiresAt: new Date(now.getTime() + RUN_HOURS * 3_600_000),
        })
        .returning()) as [Run];
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } };
      if (e.code === '23505' || e.cause?.code === '23505')
        throw new HttpError(409, 'A rotation of this account is already in progress.');
      throw error;
    }
    await this.db
      .update(schema.rotationTargets)
      .set({ lastAttemptAt: now })
      .where(eq(schema.rotationTargets.id, target.id));
    if (!endpointId || !companyId) {
      await this.fail(
        run,
        'The device is no longer linked to a ConnectWise RMM device. Sync ConnectWise RMM, then try again.',
      );
      return run.id;
    }
    try {
      const client = CwRmmClient.for(rmm.region, rmm.clientId, rmm.clientSecret, this.deps.fetcher, ROTATION_SCOPES);
      await client.runScript({
        companyId,
        endpointId,
        scriptId: settings.scriptId,
        name: `Atlas password rotation: ${info.passwordName}`,
        parameters: {
          AtlasUrl: this.deps.publicOrigin,
          Token: token,
          AccountType: target.accountType,
          Account: info.username,
          Length: String(complexity.length),
          Upper: complexity.upper ? '1' : '0',
          Lower: complexity.lower ? '1' : '0',
          Digits: complexity.digits ? '1' : '0',
          Symbols: complexity.symbols ? '1' : '0',
        },
      });
    } catch (error) {
      await this.fail(
        run,
        error instanceof HttpError ? error.message : 'The rotation script could not be started in ConnectWise RMM.',
      );
    }
    return run.id;
  }

  // ---------- schedule ----------
  /** Fails attempts whose device never reported back, then starts the attempts that are due. */
  async tick(orgId: string, now = new Date()) {
    const expired = await this.db
      .select()
      .from(schema.rotationRuns)
      .where(
        and(
          eq(schema.rotationRuns.orgId, orgId),
          inArray(schema.rotationRuns.status, OPEN),
          lt(schema.rotationRuns.expiresAt, now),
        ),
      );
    for (const run of expired)
      await this.fail(
        run,
        run.candidate
          ? 'The device reported a new password but never confirmed setting it. The old password is still in the vault; the reported one is kept in the entry’s history in case the device did change it.'
          : `The device didn’t report back within ${RUN_HOURS} hours. Check that the script ran and that the device can reach Atlas.`,
      );

    const settings = await this.deps.settings.rotation(orgId);
    if (!settings.enabled || !settings.scriptId || !(await this.deps.settings.cwRmm(orgId))) return { started: 0 };
    const targets = await this.db
      .select()
      .from(schema.rotationTargets)
      .where(and(eq(schema.rotationTargets.orgId, orgId), eq(schema.rotationTargets.enabled, true)));
    let started = 0;
    for (const t of targets) {
      const policy = await this.policyFor(orgId, t.clientId, t.accountType);
      if (!policy?.enabled) continue;
      const due = !t.lastRotatedAt || t.lastRotatedAt.getTime() + policy.intervalDays * DAY <= now.getTime();
      const retrying = t.lastAttemptAt && t.lastAttemptAt.getTime() + RETRY_AFTER > now.getTime();
      if (!due || retrying) continue;
      try {
        await this.dispatch(orgId, t, { id: null, name: 'Schedule' });
        started++;
      } catch (error) {
        // Another attempt is open, or the policy changed under us: the next tick looks again.
        if (!(error instanceof HttpError)) throw error;
      }
    }
    return { started };
  }

  // ---------- the device's side ----------
  /** The open attempt a device token belongs to. Anything else gets the same answer, whatever the reason. */
  private async runFor(header: string | undefined): Promise<Run> {
    const token = TOKEN.exec(header ?? '')?.[1];
    const invalid = () => new HttpError(401, 'This rotation token is not valid. It may have expired or been revoked.');
    if (!token) throw invalid();
    const hash = hashToken(token);
    const [run] = await this.db.select().from(schema.rotationRuns).where(eq(schema.rotationRuns.tokenHash, hash));
    if (
      !run ||
      !timingSafeEqual(Buffer.from(run.tokenHash), Buffer.from(hash)) ||
      !OPEN.includes(run.status as RotationRunStatus) ||
      run.expiresAt.getTime() < Date.now()
    )
      throw invalid();
    return run;
  }

  /** Step 1: the device reports the password it generated, before setting it. Only the first report is kept. */
  async candidate(header: string | undefined, input: unknown) {
    const run = await this.runFor(header);
    const { password } = rotationCandidateSchema.parse(input);
    if (run.status !== 'dispatched') throw new HttpError(409, 'A password was already reported for this rotation.');
    const problem = complexityProblem(password, run.complexity as RotationComplexity);
    if (problem) throw new HttpError(400, `The password doesn’t meet the rotation policy. ${problem}`);
    const sealed = await this.deps.vault.sealCandidate(run.orgId, run.id, password);
    const [updated] = await this.db
      .update(schema.rotationRuns)
      .set({ status: 'candidate', candidate: sealed })
      .where(and(eq(schema.rotationRuns.id, run.id), eq(schema.rotationRuns.status, 'dispatched')))
      .returning({ id: schema.rotationRuns.id });
    if (!updated) throw new HttpError(409, 'A password was already reported for this rotation.');
    return { ok: true };
  }

  /** Step 2: the device says whether setting the password worked. Only a success changes the vault. */
  async result(header: string | undefined, input: unknown, ip: string) {
    const run = await this.runFor(header);
    const body = rotationResultSchema.parse(input);
    if (!body.ok) {
      // The device says the account wasn't changed, so the password it reported is dropped.
      await this.fail(run, body.error.trim() || 'The device could not set the new password.', false);
      return { ok: true };
    }
    if (run.status !== 'candidate' || !run.candidate || !run.passwordId)
      throw new HttpError(409, 'Report the new password before confirming it.');
    const passwordId = run.passwordId;
    let applied = false;
    await this.deps.vault.commitRotation(
      this.db,
      run.orgId,
      { id: run.id, passwordId, candidate: run.candidate, label: `On ${run.assetName}` },
      async (tx) => {
        const [done] = await tx
          .update(schema.rotationRuns)
          .set({ status: 'succeeded', candidate: null, finishedAt: new Date() })
          .where(and(eq(schema.rotationRuns.id, run.id), eq(schema.rotationRuns.status, 'candidate')))
          .returning({ id: schema.rotationRuns.id });
        // Cancelled or expired while this request was in flight: roll the change back.
        if (!done) throw new HttpError(409, 'This rotation was cancelled before it was confirmed.');
        if (run.targetId)
          await tx
            .update(schema.rotationTargets)
            .set({ lastRotatedAt: new Date() })
            .where(eq(schema.rotationTargets.id, run.targetId));
        applied = true;
      },
    );
    if (applied)
      await this.event(
        { orgId: run.orgId, id: null, name: ROTATION_ACTOR },
        'Password rotated automatically',
        `${run.passwordName} on ${run.assetName}`,
        ip,
      );
    return { ok: true };
  }
}
