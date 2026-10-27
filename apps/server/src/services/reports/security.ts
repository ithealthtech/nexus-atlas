import { asc, and, eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import {
  LEVEL_INFO,
  PASSWORD_ISSUE_LABELS,
  ROLE_INFO,
  levelRank,
  type Role,
  type RotationRunStatus,
} from '@atlas/shared';
import { actorFor, hasMfa } from '../../identity/service.js';
import { Scope } from '../scope.js';
import {
  DAY,
  MAX_REPORT_ROWS,
  capped,
  iso,
  newest,
  onlineText,
  type Collector,
  type ReportContext,
} from './context.js';

const ROTATION_RESULT: Record<RotationRunStatus, string> = {
  dispatched: 'In progress',
  candidate: 'In progress',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** A machine's BitLocker state: any unprotected volume counts against it, and no volumes is not "encrypted". */
export function encryptionOf(volumes: schema.BitlockerVolume[]) {
  if (!volumes.length) return 'Unknown';
  if (volumes.some((v) => v.protection === 'Off')) return 'Not encrypted';
  return volumes.every((v) => v.protection === 'On') ? 'Encrypted' : 'Unknown';
}

/** Password health for the clients whose vault this person can open, through the vault's own access rules. */
export async function passwords(report: ReportContext) {
  const { security, scope } = report;
  const vaultIds = new Set<string>();
  if (security && ROLE_INFO[report.actor.role].staff)
    for (const c of report.clients) if ((await scope.level(c.id)) === 'edit_passwords') vaultIds.add(c.id);
  for (const c of report.clients.filter((c) => !vaultIds.has(c.id)))
    report.warn(`${c.name}: passwords are not included because you don't have password access here.`);
  const health = vaultIds.size ? await security!.passwordHealth(scope) : null;
  if (health) {
    report.source(
      'Atlas password vault',
      'Password names and health flags only. Passwords, usernames, notes and custom fields are excluded.',
      health.breach.lastRunAt,
    );
    if (!health.breach.enabled)
      report.warn('Breach checks are turned off, so passwords found in data breaches are not detected.');
    else if (health.breach.unchecked)
      report.warn('Some logins have not been checked against known breaches yet. They are not counted as breached.');
  }
  return {
    vaultIds,
    health,
    issues: health?.items.filter((i) => vaultIds.has(i.clientId)) ?? [],
    totals: new Map(health?.clients.map((c) => [c.id, c]) ?? []),
  };
}

/** Passwords, device protection, disk encryption, and automatic rotation, per client. */
export const security: Collector = async (report) => {
  const endpoints = await report.endpoints();
  const bitdefender = await report.bitdefender();
  const { vaultIds, health, issues, totals } = await passwords(report);
  const devices = capped(
    await report.db
      .select({
        clientId: schema.bitlockerDevices.clientId,
        assetId: schema.bitlockerDevices.assetId,
        hostname: schema.bitlockerDevices.hostname,
        volumes: schema.bitlockerDevices.volumes,
        collectedAt: schema.bitlockerDevices.collectedAt,
      })
      .from(schema.bitlockerDevices)
      .where(and(report.selected(schema.bitlockerDevices), eq(schema.bitlockerDevices.blocked, false)))
      .orderBy(asc(schema.bitlockerDevices.hostname))
      .limit(MAX_REPORT_ROWS + 1),
  );
  report.source(
    'BitLocker collector',
    'Volume protection reported by enrolled machines. Recovery keys are excluded.',
    newest(devices.map((d) => d.collectedAt)),
  );
  // Rotation is administration: anyone else's report leaves it out rather than failing.
  const targets = report.security
    ? await report.security
        .rotationTargets(report.scope)
        .then((all) => all.filter((r) => report.names.has(r.clientId)))
        .catch(() => null)
    : null;
  if (targets)
    report.source('Automatic password rotation', 'Rotation targets and their last result. Passwords are excluded.');
  else report.warn('Automatic password rotation is shown to administrators only.');

  report.section(
    'Security overview',
    [
      'Client',
      'Passwords',
      'Password issues',
      'Breached',
      'Endpoints',
      'Offline',
      'Protection missing / stopped',
      'Not encrypted',
      'Rotation failing',
      ...(bitdefender.size ? ['Bitdefender infected', 'Bitdefender attention', 'Without Bitdefender'] : []),
    ],
    report.clients.map((c) => {
      const bd = bitdefender.get(c.id);
      const vault = vaultIds.has(c.id);
      const total = totals.get(c.id);
      const machines = endpoints.filter((e) => e.clientId === c.id);
      const encrypted = devices.filter((d) => d.clientId === c.id);
      const when = (known: boolean, n: () => number) => (known ? String(n()) : 'Not available');
      return [
        c.name,
        when(vault, () => total?.total ?? 0),
        when(vault, () => total?.withIssues ?? 0),
        when(vault, () => issues.filter((i) => i.clientId === c.id && i.issues.includes('breached')).length),
        when(!!machines.length, () => machines.length),
        when(!!machines.length, () => machines.filter((e) => e.online === false).length),
        when(
          !!machines.length,
          () => machines.filter((e) => e.protection === 'missing' || e.protection === 'not_running').length,
        ),
        when(!!encrypted.length, () => encrypted.filter((d) => encryptionOf(d.volumes) === 'Not encrypted').length),
        when(!!targets, () => targets!.filter((r) => r.clientId === c.id && r.lastStatus === 'failed').length),
        ...(bitdefender.size
          ? [
              when(!!bd, () => bd!.counts.infected),
              when(!!bd, () => bd!.counts.attention),
              when(!!bd, () => bd!.missing.length),
            ]
          : []),
      ];
    }),
  );
  if (health)
    report.section(
      'Password issues',
      ['Client', 'Password', 'Category', 'Issues'],
      issues.map((i) => [
        report.client(i.clientId),
        i.name,
        i.category,
        i.issues.map((x) => PASSWORD_ISSUE_LABELS[x]).join(', '),
      ]),
    );
  // One row per machine: RMM devices with their BitLocker state, then BitLocker machines RMM doesn't know.
  const byAsset = new Map(devices.filter((d) => d.assetId).map((d) => [d.assetId!, d]));
  // Each row with the asset it opens, so the two stay together through the sort.
  const machineRows: { row: string[]; assetId: string | null }[] = endpoints.map((e) => {
    const disk = byAsset.get(e.assetId);
    return {
      row: [
        report.client(e.clientId),
        e.name,
        onlineText(e.online),
        e.protection ?? 'Unknown',
        disk ? encryptionOf(disk.volumes) : 'Not reported',
        iso(e.lastSeenAt) || 'Unknown',
      ],
      assetId: e.assetId,
    };
  });
  const known = new Set(endpoints.map((e) => e.assetId));
  for (const d of devices.filter((d) => !d.assetId || !known.has(d.assetId)))
    machineRows.push({
      row: [
        report.client(d.clientId),
        d.hostname,
        'Not in RMM',
        'Not in RMM',
        encryptionOf(d.volumes),
        iso(d.collectedAt),
      ],
      assetId: d.assetId,
    });
  machineRows.sort((a, b) => a.row[0]!.localeCompare(b.row[0]!) || a.row[1]!.localeCompare(b.row[1]!));
  report.section(
    'Device protection and encryption',
    ['Client', 'Device', 'Online', 'Protection', 'Encryption', 'Last check-in'],
    machineRows.map((m) => m.row),
    machineRows.map((m) => (m.assetId ? `/assets/${m.assetId}` : null)),
  );
  if (targets)
    report.section(
      'Automatic password rotation',
      ['Client', 'Device', 'Account', 'Enabled', 'Last rotated', 'Next due', 'Last result'],
      targets.map((r) => [
        r.clientName,
        r.assetName,
        r.passwordName,
        r.enabled ? 'Yes' : 'No',
        r.lastRotatedAt ?? 'Never',
        r.nextDueAt ?? 'No policy',
        r.lastStatus ? ROTATION_RESULT[r.lastStatus] : 'Not run yet',
      ]),
    );
  await bitdefenderSection(report);
  await accessReview(report);
};

/** An account unused this long is flagged in the access review. */
const DORMANT_DAYS = 60;

/**
 * Everyone with access to each chosen client, at what level, and whether they use two-factor sign-in: the list a
 * client's access review signs off. Administrators only, since it lists the team.
 */
export async function accessReview(report: ReportContext) {
  if (!ROLE_INFO[report.actor.role].admin) return;
  const users = await report.db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.orgId, report.actor.orgId), eq(schema.users.disabled, false)))
    .orderBy(asc(schema.users.name));
  const people = await Promise.all(
    users.map(async (u) => ({ u, levels: await new Scope(report.db, actorFor(u)).levels() })),
  );
  const now = Date.parse(report.generatedAt);
  report.section(
    'Who has access',
    ['Client', 'Person', 'Role', 'Access', 'Two-factor', 'Last sign-in', 'Note'],
    report.clients.flatMap((c) =>
      people
        .map(({ u, levels }) => ({ u, level: levels.get(c.id) ?? 'none' }))
        .filter((p) => p.level !== 'none')
        .sort((a, b) => levelRank(b.level) - levelRank(a.level) || a.u.name.localeCompare(b.u.name))
        .map(({ u, level }) => [
          report.client(c.id),
          `${u.name} <${u.email}>`,
          ROLE_INFO[u.role as Role].label,
          LEVEL_INFO[level].label,
          hasMfa(u) ? 'Yes' : 'No',
          iso(u.lastLoginAt) || 'Never',
          !u.lastLoginAt
            ? 'Has never signed in'
            : now - u.lastLoginAt.getTime() > DORMANT_DAYS * DAY
              ? `Inactive ${DORMANT_DAYS}+ days`
              : '',
        ]),
    ),
  );
}
