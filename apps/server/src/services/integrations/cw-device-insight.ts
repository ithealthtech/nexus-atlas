import { and, eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { RmmDeviceInsight } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { isUuid, type Scope } from '../scope.js';
import type { SettingsService } from '../settings.js';
import { ACCESS_DENIED, CwRmmClient, listOf, pick, text } from './cw-rmm.js';

type Json = Record<string, unknown>;

/** Device groups and policies each get their own token, so a key without those permissions still shows the rest. */
export const GROUP_SCOPES = 'platform.deviceGroups.read';
export const POLICY_SCOPES = 'platform.policies.read';
// A day of samples for the usage lines; kept to this many points.
const WINDOW_MINUTES = 1440;
const MAX_SAMPLES = 48;
const CACHE_MS = 5 * 60_000;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const byTime = (a: Json, b: Json) => Date.parse(text(a, 'createTimeUTC')) - Date.parse(text(b, 'createTimeUTC'));

/** At most `max` evenly spaced values, keeping the last one. */
export function thin(values: number[], max = MAX_SAMPLES): number[] {
  if (values.length <= max) return values;
  const step = values.length / max;
  return Array.from({ length: max }, (_, i) => values[Math.min(values.length - 1, Math.round((i + 1) * step) - 1)]!);
}

/** Logical disks from the disk-usage response: each storage's partitions where they carry sizes, else the storage. */
export function disksOf(body: unknown): RmmDeviceInsight['disks'] {
  const latest = listOf(body).sort(byTime).at(-1);
  const storages = latest && Array.isArray(latest.storages) ? (latest.storages as Json[]) : [];
  const out: RmmDeviceInsight['disks'] = [];
  for (const s of storages) {
    const parts = (Array.isArray(s.partitions) ? (s.partitions as Json[]) : []).filter(
      (p) => num(pick(p, 'metric.totalSpaceBytes')) > 0,
    );
    for (const d of parts.length ? parts : [s]) {
      const totalBytes = num(pick(d, 'metric.totalSpaceBytes'));
      if (!(totalBytes > 0)) continue;
      out.push({
        name: text(d, 'mountPoint', 'name') || `Disk ${out.length + 1}`,
        freeBytes: Math.max(0, num(pick(d, 'metric.freeSpaceBytes')) || 0),
        totalBytes,
      });
    }
  }
  return out;
}

/** Memory use from the memory-usage samples, oldest first; null with no samples. */
export function memoryOf(body: unknown): RmmDeviceInsight['memory'] {
  const samples = listOf(body)
    .filter((m) => num(m.physicalTotalBytes) > 0)
    .sort(byTime);
  const last = samples.at(-1);
  if (!last) return null;
  const values = samples.map((m) => pct(num(m.physicalInUseBytes), num(m.physicalTotalBytes)));
  return {
    totalBytes: num(last.physicalTotalBytes),
    percent: values.at(-1)!,
    peakPercent: Math.max(...values),
    samples: thin(values),
  };
}

/** CPU utilization from the cpu-usage samples, oldest first; null with no samples. */
export function cpuOf(body: unknown): RmmDeviceInsight['cpu'] {
  const values = listOf(body)
    .sort(byTime)
    .map((c) => num(pick(c, 'metric.percentUtil')))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10);
  if (!values.length) return null;
  return { percent: values.at(-1)!, peakPercent: Math.max(...values), samples: thin(values) };
}

/** Group IDs from the device-groups response: a list of IDs, or of records carrying one. */
export function groupIdsOf(body: unknown): string[] {
  const list = Array.isArray(body) ? body : listOf(body);
  return [
    ...new Set(
      list
        .map((g) => (typeof g === 'string' ? g : g && typeof g === 'object' ? text(g as Json, 'id', 'deviceGroupId') : ''))
        .filter(Boolean),
    ),
  ];
}

/** The policies that won the device's settings, most settings first. */
export function policiesOf(body: unknown): NonNullable<RmmDeviceInsight['policies']> {
  const mapping = pick((body ?? {}) as Json, 'mapping');
  const counts = new Map<string, { name: string; level: string; settings: number }>();
  for (const m of Array.isArray(mapping) ? (mapping as Json[]) : []) {
    const name = text(m, 'policy.name', 'policyGroup.name') || 'Unnamed policy';
    const level = text(m, 'container.type');
    const key = `${text(m, 'policy.id') || name}|${level}`;
    const entry = counts.get(key) ?? { name, level, settings: 0 };
    entry.settings++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.settings - a.settings || a.name.localeCompare(b.name));
}

/** Resource use, device groups, and effective policy for a synced device, read live from ConnectWise RMM. */
export class CwDeviceInsight {
  private cache = new Map<string, { at: number; value: RmmDeviceInsight }>();

  constructor(
    private readonly settings: SettingsService,
    private readonly fetcher?: typeof fetch,
  ) {}

  /** Null when the asset wasn't synced from ConnectWise RMM, or RMM isn't connected. */
  async forAsset(scope: Scope, assetId: string): Promise<RmmDeviceInsight | null> {
    const orgId = scope.actor.orgId;
    const [asset] = isUuid(assetId)
      ? await scope.db
          .select({ clientId: schema.assets.clientId })
          .from(schema.assets)
          .where(and(eq(schema.assets.id, assetId), eq(schema.assets.orgId, orgId)))
      : [];
    if (!asset) throw new HttpError(404, 'Asset not found.');
    await scope.require(asset.clientId, 'read', 'Asset');
    const [ref] = await scope.db
      .select({ endpointId: schema.externalRefs.externalId })
      .from(schema.externalRefs)
      .where(
        and(
          eq(schema.externalRefs.orgId, orgId),
          eq(schema.externalRefs.source, 'cw-rmm'),
          eq(schema.externalRefs.kind, 'assets'),
          eq(schema.externalRefs.entityId, assetId),
        ),
      );
    const saved = await this.settings.cwRmm(orgId);
    if (!ref || !saved) return null;
    const key = `${orgId}|${ref.endpointId}`;
    const hit = this.cache.get(key);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
    const companies = Object.entries(saved.map)
      .filter(([, m]) => m.action === 'link' && m.clientId === asset.clientId)
      .map(([companyId]) => companyId);
    const client = (scopes?: string) =>
      CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, this.fetcher, scopes);
    const value = await this.read(client, ref.endpointId, companies);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  private async read(
    client: (scopes?: string) => CwRmmClient,
    endpointId: string,
    companies: string[],
  ): Promise<RmmDeviceInsight> {
    const notes: string[] = [];
    const id = encodeURIComponent(endpointId);
    /** A part's value, or its fallback with a note on why it's missing (none when ConnectWise just has no data). */
    const attempt = async <T>(what: string, permission: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        if (error.code === ACCESS_DENIED) notes.push(`${what}: the API key needs the ${permission} permission.`);
        else if (error.status !== 404) notes.push(`${what}: ${error.message.replace(/^ConnectWise RMM /, '')}`);
        return fallback;
      }
    };
    const devices = client();
    // The usage reads share one token. Device groups and policy each sign in with their own scope, one after the
    // other: ConnectWise locks a key (423) that asks for several tokens at once.
    const [disks, memory, cpu] = await Promise.all([
      attempt('Disks', 'Devices read', [], async () =>
        disksOf(await devices.get(`/api/platform/v2/device/endpoints/${id}/disk-usage`)),
      ),
      attempt('Memory', 'Devices read', null, async () =>
        memoryOf(await devices.get(`/api/platform/v2/device/endpoints/${id}/memory-usage?minutes=${WINDOW_MINUTES}`)),
      ),
      attempt('CPU', 'Devices read', null, async () =>
        cpuOf(await devices.get(`/api/platform/v2/device/endpoints/${id}/cpu-usage?minutes=${WINDOW_MINUTES}`)),
      ),
    ]);
    const groups = await attempt('Device groups', 'Device Groups read', null, () => this.groups(client(GROUP_SCOPES), id));
    const policies = await attempt('Policy', 'Policies read', null, () => this.policies(client, endpointId, companies));
    return { disks, memory, cpu, groups, policies, notes };
  }

  /** The device's group names: the spec lists the device's group IDs, and every group with its name. */
  private async groups(groups: CwRmmClient, id: string): Promise<string[]> {
    const ids = groupIdsOf(await groups.get(`/api/platform/v2/managed-endpoints/${id}/device-groups`));
    if (!ids.length) return [];
    const names = new Map(listOf(await groups.get('/api/platform/v1/device-groups')).map((g) => [text(g, 'id'), text(g, 'name')]));
    return ids.map((g) => names.get(g) || g).sort((a, b) => a.localeCompare(b));
  }

  /** The effective policy lives under the device's company and site; each linked company's sites are tried in turn. */
  private async policies(client: (scopes?: string) => CwRmmClient, endpointId: string, companies: string[]) {
    const policy = client(POLICY_SCOPES);
    for (const companyId of companies) {
      for (const site of await client().sites(companyId)) {
        try {
          return policiesOf(
            await policy.get(
              `/api/platform/v2/policy/companies/${encodeURIComponent(companyId)}/sites/${encodeURIComponent(site.id)}/endpoints/${encodeURIComponent(endpointId)}/effective-policy/mapping`,
            ),
          );
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 404)) throw error;
        }
      }
    }
    return null;
  }
}
