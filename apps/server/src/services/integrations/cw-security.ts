import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type {
  BackupAlarm,
  BackupJob,
  BackupReport,
  BackupStatus,
  ClientSecurity,
  DeviceSecurity,
  MissingPatch,
  PatchDevice,
  PatchReport,
  SecurityCase,
  SecuritySection,
  VulnCounts,
  VulnDevice,
  VulnReport,
  VulnSeverity,
  Vulnerability,
} from '@atlas/shared';
import { HttpError } from '../../errors.js';
import type { SettingsService } from '../settings.js';
import { ACCESS_DENIED, listOf, pick, text, CwRmmClient } from './cw-rmm.js';

type Json = Record<string, unknown>;
type Saved = NonNullable<Awaited<ReturnType<SettingsService['cwRmm']>>>;

/**
 * Patch compliance, backup status, vulnerabilities and MDR cases from the ConnectWise platform, read live when a
 * client or device page asks and kept in memory for a few minutes. Read-only: nothing is written to ConnectWise
 * and nothing is stored in Atlas.
 *
 * Each area signs in with its own scopes, so a key (or a partner) without backup or MDR still gets patching. Backup,
 * vulnerability and MDR data only exist for partners that use those ConnectWise products, so a refused or empty
 * answer is shown as "not available", never as an error.
 */
type Area = 'osPatch' | 'tpPatch' | 'backup' | 'vuln' | 'mdr';
// Scopes from the platform API spec; vulnerabilities list none, so they use the device sync's own scopes.
const AREA_SCOPES: Record<Area, string | undefined> = {
  osPatch: 'platform.ospatching.management.read',
  tpPatch: 'platform.tppatching.management.read',
  backup: 'backupdashboard.jobs.read backupdashboard.dr-readiness.read backupdashboard.alarms.read',
  vuln: undefined,
  mdr: 'security.cases.read',
};
const UNAVAILABLE: Record<'patching' | 'backup' | 'vuln' | 'mdr', string> = {
  patching: 'ConnectWise returned no patch data. Patching may not be turned on for these devices, or the API key lacks the OS or third-party patching read permission.',
  backup: 'ConnectWise returned no backup data. This needs the ConnectWise backup dashboard and the backup read permissions on the API key.',
  vuln: 'ConnectWise returned no vulnerability data. This needs ConnectWise vulnerability management for these devices.',
  mdr: 'ConnectWise returned no security cases. This needs ConnectWise MDR and the security cases read permission on the API key.',
};
const FRESH_MS = 10 * 60_000;
/** A key that can't sign in for an area isn't asked again for this long: ConnectWise locks keys that sign in too often. */
const DENIED_MS = 60 * 60_000;
const MAX_PAGES = 20;
const COMPANIES_PER_CALL = 4;
const VULN_ENDPOINTS_PER_CALL = 300;
const LIST_CAP = 200;
const CASE_DETAILS = 20;

// ConnectWise's text is someone else's: control characters are dropped and the length capped.
// eslint-disable-next-line no-control-regex
const clean = (s: string, max = 300) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
/** A time from Unix milliseconds or an ISO string; null when missing or implausible. */
export const timeOf = (v: unknown): string | null => {
  const ms = typeof v === 'number' ? v : typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms < Date.now() + 86_400_000
    ? new Date(ms).toISOString()
    : null;
};
const webLink = (s: string) => (/^https:\/\/[^\s"'<>]{1,1000}$/i.test(s) ? s : null);
const chunks = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const ok = <T>(data: T): SecuritySection<T> => ({ state: 'ok', data });
const none = <T>(reason: string): SecuritySection<T> => ({ state: 'unavailable', reason });
const pct = (v: number | null) => (v === null ? null : Math.round(Math.min(Math.max(v, 0), 100)));
const average = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? pct(known.reduce((a, b) => a + b, 0) / known.length) : null;
};

const SEVERITIES: VulnSeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
const zero = (): VulnCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });
const severityOf = (s: string): VulnSeverity => {
  const v = s.toLowerCase() as VulnSeverity;
  return SEVERITIES.includes(v) ? v : 'unknown';
};
/** Worst first: by critical, then high, and so on. */
const byCounts = (a: VulnCounts, b: VulnCounts) => {
  for (const s of SEVERITIES) if (a[s] !== b[s]) return b[s] - a[s];
  return 0;
};
const BACKUP_STATUSES: BackupStatus[] = ['failure', 'missed', 'warning', 'running', 'paused', 'unknown', 'success'];
const backupStatus = (s: string): BackupStatus => {
  const v = s.toLowerCase() as BackupStatus;
  return BACKUP_STATUSES.includes(v) ? v : 'unknown';
};
const ALARM_ORDER = ['critical', 'high', 'medium', 'low', 'informational'];

/** An Atlas device synced from ConnectWise: its endpoint ID and asset. */
interface Endpoint {
  endpointId: string;
  assetId: string;
  name: string;
}

/** The endpoints inside a patching response ({ data: [{ companyID, siteID, endpoints: [...] }] }). */
const endpointsOf = (body: unknown): Json[] =>
  listOf(body).flatMap((g) => (Array.isArray(g.endpoints) ? (g.endpoints as Json[]) : [g]));

/** Whether a failure means this area isn't there for this key or partner (as opposed to ConnectWise being down). */
const refused = (error: unknown) =>
  error instanceof HttpError && (error.code === ACCESS_DENIED || [400, 401, 403, 404].includes(error.status));

export class CwSecurityService {
  private readonly cache = new Map<string, { expires: number; value: Promise<unknown> }>();
  private readonly denied = new Map<string, { until: number; reason: string }>();

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly fetcher?: typeof fetch,
  ) {}

  /** The client's security and compliance picture, for its overview page. The caller checks access. */
  async forClient(orgId: string, clientId: string): Promise<ClientSecurity> {
    const saved = await this.settings.cwRmm(orgId);
    const companies = saved ? companiesOf(saved, clientId) : [];
    const fetchedAt = new Date().toISOString();
    if (!saved || !companies.length) return { linked: false, fetchedAt, ...notLinked() };
    const endpoints = await this.endpoints(orgId, { clientId });
    const [patching, backup, vulnerabilities, incidents] = await Promise.all([
      this.section(orgId, `patch|${companies}`, () => this.clientPatching(saved, companies, endpoints)),
      this.section<BackupReport>(orgId, `backup|${companies}`, async () => {
        const report = await this.backupReport(saved, companies, endpoints);
        return report.jobs || report.drChecks || report.alarms.length ? ok(report) : none(UNAVAILABLE.backup);
      }),
      this.section(orgId, `vuln|client|${clientId}`, () => this.clientVulns(saved, endpoints)),
      this.section(orgId, `mdr|${companies}`, async () => ok(await this.cases(saved, companies))),
    ]);
    return { linked: true, fetchedAt, patching, backup, vulnerabilities, incidents };
  }

  /** One device's patches, backups and vulnerabilities, for its asset page. The caller checks access. */
  async forDevice(orgId: string, clientId: string, assetId: string): Promise<DeviceSecurity> {
    const saved = await this.settings.cwRmm(orgId);
    const [endpoint] = saved ? await this.endpoints(orgId, { assetId }) : [];
    const fetchedAt = new Date().toISOString();
    if (!saved || !endpoint)
      return {
        linked: false,
        fetchedAt,
        patching: none('This device was not synced from ConnectWise RMM.'),
        backup: none('This device was not synced from ConnectWise RMM.'),
        vulnerabilities: none('This device was not synced from ConnectWise RMM.'),
      };
    const companies = companiesOf(saved, clientId);
    const id = endpoint.endpointId;
    const [patching, backup, vulnerabilities] = await Promise.all([
      this.section(orgId, `patch|device|${id}`, () => this.devicePatching(saved, endpoint)),
      this.section<BackupJob[]>(orgId, `backup|device|${id}|${companies}`, async () => {
        const jobs = (await this.backupJobs(saved, companies, [endpoint])).filter((j) => j.endpointId === id);
        return jobs.length ? ok(jobs.map(({ endpointId: _, ...j }) => j)) : none('ConnectWise reports no backup jobs for this device.');
      }),
      this.section<{ counts: VulnCounts; list: Vulnerability[] }>(orgId, `vuln|device|${id}`, async () => {
        const [device] = await this.vulns(saved, [endpoint]);
        if (!device) return none(UNAVAILABLE.vuln);
        const counts = zero();
        for (const v of device.list) counts[v.severity]++;
        return ok({ counts, list: device.list.slice(0, LIST_CAP) });
      }),
    ]);
    return { linked: true, fetchedAt, patching, backup, vulnerabilities };
  }

  /**
   * Runs one area's read, kept for a few minutes. A failure becomes "not available"; one that means the key can't
   * use the area also stops that area being asked for the whole organization for an hour.
   */
  private section<T>(orgId: string, key: string, read: () => Promise<SecuritySection<T>>): Promise<SecuritySection<T>> {
    const area = key.split('|')[0]!;
    const block = this.denied.get(`${orgId}|${area}`);
    if (block && block.until > Date.now()) return Promise.resolve(none(block.reason));
    const cacheKey = `${orgId}|${key}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<SecuritySection<T>>;
    const value = read().catch((error: unknown): SecuritySection<T> => {
      const said = error instanceof HttpError ? error.message : 'ConnectWise could not be reached.';
      const reason = `${UNAVAILABLE[area === 'patch' ? 'patching' : (area as 'backup' | 'vuln' | 'mdr')]} (${said.slice(0, 200)})`;
      if (error instanceof HttpError && error.code === ACCESS_DENIED)
        this.denied.set(`${orgId}|${area}`, { until: Date.now() + DENIED_MS, reason });
      return none(reason);
    });
    this.cache.set(cacheKey, { expires: Date.now() + FRESH_MS, value });
    if (this.cache.size > 2000)
      for (const [k, v] of this.cache) if (v.expires <= Date.now()) this.cache.delete(k);
    return value;
  }

  private client(saved: Saved, area: Area) {
    return CwRmmClient.for(saved.region, saved.clientId, saved.clientSecret, this.fetcher, AREA_SCOPES[area]);
  }

  /** Devices synced from ConnectWise into Atlas, by client or by asset. */
  private async endpoints(orgId: string, by: { clientId: string } | { assetId: string }): Promise<Endpoint[]> {
    const s = schema.rmmDeviceStatus;
    const rows = await this.db
      .select({ endpointId: s.externalId, assetId: s.assetId, name: schema.assets.name })
      .from(s)
      .innerJoin(schema.assets, eq(schema.assets.id, s.assetId))
      .where(
        and(
          eq(s.orgId, orgId),
          eq(s.source, 'cw-rmm'),
          'clientId' in by ? eq(s.clientId, by.clientId) : eq(s.assetId, by.assetId),
        ),
      );
    return rows;
  }

  /** Every page of a POST that takes { resourceType, resources } and pages with a Link header. */
  private async resourcePages(client: CwRmmClient, path: string, resourceType: string, resources: string[]) {
    const out: Json[] = [];
    for (const group of chunks(resources, resourceType === 'company' ? COMPANIES_PER_CALL : 500)) {
      for (let cursor = 0, page = 0; page < MAX_PAGES; page++) {
        let res: { body: unknown; nextCursor: number | null };
        try {
          res = await client.page('POST', `${path}?limit=500&cursor=${cursor}`, { resourceType, resources: group });
        } catch (error) {
          // "Not found" is how the platform answers when there's nothing for these resources.
          if (error instanceof HttpError && error.status === 404 && error.code !== ACCESS_DENIED) break;
          throw error;
        }
        out.push(...endpointsOf(res.body));
        if (res.nextCursor === null || res.nextCursor <= cursor) break;
        cursor = res.nextCursor;
      }
    }
    return out;
  }

  /** OS and third-party compliance per endpoint. Either may be missing; both missing is an error. */
  private async compliance(saved: Saved, resourceType: 'company' | 'endpoint', resources: string[]) {
    const [os, tp] = await Promise.allSettled([
      this.resourcePages(this.client(saved, 'osPatch'), '/api/platform/v2/os-patching/compliance/summary', resourceType, resources),
      this.resourcePages(
        this.client(saved, 'tpPatch'),
        '/api/platform/v2/third-party-patching/compliance/summary',
        resourceType,
        resources,
      ),
    ]);
    if (os.status === 'rejected' && tp.status === 'rejected') throw os.reason;
    const devices = new Map<string, PatchDevice>();
    const get = (id: string) => {
      let d = devices.get(id);
      if (!d)
        devices.set(
          id,
          (d = {
            endpointId: id,
            assetId: null,
            name: '',
            osScore: null,
            missing: 0,
            pendingReboot: 0,
            outOfSupport: false,
            thirdPartyScore: null,
            thirdPartyPending: 0,
            assessedAt: null,
          }),
        );
      return d;
    };
    for (const e of os.status === 'fulfilled' ? os.value : []) {
      const id = text(e, 'endpointID', 'endpointId');
      if (!id) continue;
      const d = get(id);
      d.osScore = pct(num(pick(e, 'compliance', 'complianceScore')));
      d.missing = num(pick(e, 'missingPatchCount', 'missingCount')) ?? 0;
      d.pendingReboot = num(pick(e, 'pendingRebootPatchCount', 'pendingRebootCount')) ?? 0;
      d.outOfSupport = pick(e, 'outOfSupport') === true;
      d.assessedAt = timeOf(pick(e, 'assessedAt'));
    }
    for (const e of tp.status === 'fulfilled' ? tp.value : []) {
      const id = text(e, 'endpointID', 'endpointId');
      if (!id) continue;
      const d = get(id);
      d.thirdPartyScore = pct(num(pick(e, 'complianceScore', 'compliance')));
      d.thirdPartyPending = num(pick(e, 'updatesPending')) ?? 0;
      d.assessedAt ??= timeOf(pick(e, 'assessedAt'));
    }
    return [...devices.values()];
  }

  private async clientPatching(saved: Saved, companies: string[], endpoints: Endpoint[]) {
    const known = new Map(endpoints.map((e) => [e.endpointId, e]));
    const devices = (await this.compliance(saved, 'company', companies)).map((d) => ({
      ...d,
      assetId: known.get(d.endpointId)?.assetId ?? null,
      name: known.get(d.endpointId)?.name ?? 'Device not synced to Atlas',
    }));
    if (!devices.length) return none<PatchReport>(UNAVAILABLE.patching);
    const assessed = devices.filter((d) => d.osScore !== null || d.thirdPartyScore !== null);
    const worst = (d: PatchDevice) => Math.min(d.osScore ?? 100, d.thirdPartyScore ?? 100);
    return ok<PatchReport>({
      osScore: average(devices.map((d) => d.osScore)),
      thirdPartyScore: average(devices.map((d) => d.thirdPartyScore)),
      compliant: assessed.filter((d) => d.missing === 0 && d.thirdPartyPending === 0).length,
      assessed: assessed.length,
      missing: devices.reduce((n, d) => n + d.missing, 0),
      devices: devices
        .sort((a, b) => worst(a) - worst(b) || b.missing - a.missing || a.name.localeCompare(b.name))
        .slice(0, LIST_CAP),
    });
  }

  private async devicePatching(saved: Saved, endpoint: Endpoint) {
    const id = endpoint.endpointId;
    const [summary, osPatches, tpApps] = await Promise.allSettled([
      this.compliance(saved, 'endpoint', [id]),
      this.client(saved, 'osPatch').get(`/api/platform/v2/patching/${encodeURIComponent(id)}/patches`),
      this.resourcePages(
        this.client(saved, 'tpPatch'),
        '/api/platform/v2/third-party-patching/patch/details',
        'endpoint',
        [id],
      ),
    ]);
    if (summary.status === 'rejected' && osPatches.status === 'rejected' && tpApps.status === 'rejected')
      throw summary.reason;
    const device = summary.status === 'fulfilled' ? summary.value.find((d) => d.endpointId === id) : undefined;
    const missing: MissingPatch[] = [];
    if (osPatches.status === 'fulfilled') {
      const body = (osPatches.value ?? {}) as Json;
      // The spec doesn't say what each numeric status means, so a patch counts as missing while it has no
      // install date.
      for (const p of Array.isArray(body.patches) ? (body.patches as Json[]) : listOf(body))
        if (!text(p, 'installedDate'))
          missing.push({
            name: clean(text(p, 'kbArticleID', 'kbArticleId', 'title', 'updateID'), 100) || 'Unnamed update',
            kind: 'os',
            detail: clean([text(p, 'msrcSeverity'), text(p, 'classification')].filter(Boolean).join(' · '), 200),
            link: webLink(text(p, 'moreInformationLink')),
          });
    }
    if (tpApps.status === 'fulfilled')
      for (const e of tpApps.value)
        for (const a of Array.isArray(e.applications) ? (e.applications as Json[]) : [])
          if (/out.?of.?date/i.test(text(a, 'status')))
            missing.push({
              name: clean(text(a, 'applicationName', 'applicationID'), 200) || 'Unnamed application',
              kind: 'third_party',
              detail: clean(
                [
                  text(a, 'installedVersion') && `Installed ${text(a, 'installedVersion')}`,
                  text(a, 'latestVersion') && `latest ${text(a, 'latestVersion')}`,
                ]
                  .filter(Boolean)
                  .join(', '),
                200,
              ),
              link: null,
            });
    if (!device && !missing.length) return none<{ device: PatchDevice | null; missing: MissingPatch[] }>(UNAVAILABLE.patching);
    return ok({
      device: device ? { ...device, assetId: endpoint.assetId, name: endpoint.name } : null,
      missing: missing.slice(0, LIST_CAP),
    });
  }

  /** Every page of a backup dashboard list for each company. */
  private async backupList(saved: Saved, companies: string[], what: 'instances' | 'dr-readiness' | 'alarms') {
    const client = this.client(saved, 'backup');
    const out: Json[] = [];
    for (const company of companies)
      for (let cursor = 0, page = 0; page < MAX_PAGES; page++) {
        const res = await client.page(
          'GET',
          `/api/backup-dashboard/companies/${encodeURIComponent(company)}/${what}?limit=500&cursor=${cursor}`,
        );
        out.push(...listOf(res.body));
        if (res.nextCursor === null || res.nextCursor <= cursor) break;
        cursor = res.nextCursor;
      }
    return out;
  }

  private backupJobs(saved: Saved, companies: string[], endpoints: Endpoint[]) {
    const key = `${saved.clientId}|jobs|${companies}`;
    const hit = this.cache.get(key);
    const raw =
      hit && hit.expires > Date.now()
        ? (hit.value as Promise<Json[]>)
        : this.backupList(saved, companies, 'instances');
    if (!hit || hit.expires <= Date.now()) {
      this.cache.set(key, { expires: Date.now() + FRESH_MS, value: raw });
      raw.catch(() => this.cache.delete(key));
    }
    const known = new Map(endpoints.map((e) => [e.endpointId, e]));
    return raw.then((jobs) =>
      jobs.map((j): BackupJob & { endpointId: string } => {
        const endpointId = text(j, 'endpointId', 'endpointID');
        return {
          endpointId,
          name: clean(text(j, 'backupJobName', 'backupName', 'name'), 200) || 'Backup job',
          device: clean(known.get(endpointId)?.name ?? text(j, 'vendorDeviceName', 'deviceName'), 200),
          assetId: known.get(endpointId)?.assetId ?? null,
          product: clean(text(j, 'productName'), 100),
          status: backupStatus(text(j, 'dashboardBackupStatus', 'status')),
          lastBackupAt: timeOf(pick(j, 'lastBackupTimestamp', 'endTimestamp', 'startTimestamp')),
          summary: clean(text(j, 'summary', 'vendorBackupStatus'), 300),
        };
      }),
    );
  }

  private async backupReport(saved: Saved, companies: string[], endpoints: Endpoint[]): Promise<BackupReport> {
    const jobs = await this.backupJobs(saved, companies, endpoints);
    // DR readiness and alarms are extras: a product that doesn't report them still shows its jobs.
    const [dr, alarms] = await Promise.all([
      this.backupList(saved, companies, 'dr-readiness').catch((error) => (refused(error) ? [] : Promise.reject(error))),
      this.backupList(saved, companies, 'alarms').catch((error) => (refused(error) ? [] : Promise.reject(error))),
    ]);
    const byStatus: BackupReport['byStatus'] = {};
    for (const j of jobs) byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
    const drChecks = dr.filter((d) => !/^unknown$/i.test(text(d, 'status')));
    const rank = (s: BackupStatus) => BACKUP_STATUSES.indexOf(s);
    const known = new Map(endpoints.map((e) => [e.endpointId, e.name]));
    return {
      jobs: jobs.length,
      byStatus,
      lastBackupAt: jobs.map((j) => j.lastBackupAt).reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null),
      drScore: drChecks.length
        ? pct((drChecks.filter((d) => /^success$/i.test(text(d, 'status'))).length / drChecks.length) * 100)
        : null,
      drChecks: drChecks.length,
      failing: jobs
        .filter((j) => ['failure', 'missed', 'warning'].includes(j.status))
        .sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name))
        .slice(0, LIST_CAP)
        .map(({ endpointId: _, ...j }) => j),
      alarms: alarms
        .filter((a) => /^open$/i.test(text(a, 'status')))
        .map(
          (a): BackupAlarm => ({
            name: clean(text(a, 'name', 'family'), 200) || 'Alarm',
            severity: clean(text(a, 'severity'), 40),
            device: clean(known.get(text(a, 'endpointId')) ?? text(a, 'vendorDeviceName', 'siteName'), 200),
            description: clean(text(a, 'description'), 500),
            at: timeOf(pick(a, 'alarmTimestamp', 'createdAt')),
          }),
        )
        .sort((a, b) => {
          const r = (s: string) => ALARM_ORDER.indexOf(s.toLowerCase()) >>> 0;
          return r(a.severity) - r(b.severity) || (b.at ?? '').localeCompare(a.at ?? '');
        })
        .slice(0, LIST_CAP),
    };
  }

  /** Each device's vulnerabilities; devices ConnectWise didn't report on are left out. */
  private async vulns(saved: Saved, endpoints: Endpoint[]) {
    const client = this.client(saved, 'vuln');
    const known = new Map(endpoints.map((e) => [e.endpointId, e]));
    const out: { endpoint: Endpoint; list: Vulnerability[] }[] = [];
    for (const group of chunks(endpoints, VULN_ENDPOINTS_PER_CALL)) {
      let body: Json;
      try {
        body = ((await client.page('POST', '/api/v2/vulnerabilities', { endpointIDs: group.map((e) => e.endpointId) }))
          .body ?? {}) as Json;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404 && error.code !== ACCESS_DENIED) continue;
        throw error;
      }
      const sites = listOf(pick(body, 'successfulRecords') ?? body);
      for (const device of sites.flatMap((s) => (Array.isArray(s.devices) ? (s.devices as Json[]) : []))) {
        const endpoint = known.get(text(device, 'deviceId', 'deviceID', 'endpointId'));
        if (!endpoint) continue;
        const list = (Array.isArray(device.vulnerabilities) ? (device.vulnerabilities as Json[]) : [])
          .map(
            (v): Vulnerability => ({
              cve: clean(text(v, 'cve_id', 'cveId', 'cve'), 40),
              severity: severityOf(text(v, 'severity')),
              cvss: num(pick(v, 'cvss_score', 'cvssScore')),
              epss: num(pick(v, 'epss_score', 'epssScore')),
            }),
          )
          .filter((v) => v.cve)
          .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.cvss ?? 0) - (a.cvss ?? 0));
        out.push({ endpoint, list });
      }
    }
    return out;
  }

  private async clientVulns(saved: Saved, endpoints: Endpoint[]) {
    if (!endpoints.length) return none<VulnReport>('No devices have been synced from ConnectWise RMM for this client yet.');
    const reported = await this.vulns(saved, endpoints);
    if (!reported.length) return none<VulnReport>(UNAVAILABLE.vuln);
    const counts = zero();
    const devices: VulnDevice[] = [];
    for (const { endpoint, list } of reported) {
      const c = zero();
      for (const v of list) c[v.severity]++;
      for (const s of SEVERITIES) counts[s] += c[s];
      if (list.length) devices.push({ endpointId: endpoint.endpointId, assetId: endpoint.assetId, name: endpoint.name, counts: c });
    }
    return ok<VulnReport>({ counts, devices: devices.sort((a, b) => byCounts(a.counts, b.counts)).slice(0, LIST_CAP) });
  }

  /** Open MDR cases for the companies, with the devices and users each touches. */
  private async cases(saved: Saved, companies: string[]): Promise<SecurityCase[]> {
    const client = this.client(saved, 'mdr');
    const items: Json[] = [];
    let next = '';
    for (let page = 0; page < 5; page++) {
      let body: Json;
      try {
        body = (await client.get(
          `/api/v1/cases?company_ids=${encodeURIComponent(companies.join(','))}&limit=100&sort=updated_at&order=desc${
            next ? `&next_cursor=${encodeURIComponent(next)}` : ''
          }`,
        )) as Json;
      } catch (error) {
        // The cases API answers "not found" when no cases match.
        if (error instanceof HttpError && error.status === 404 && error.code !== ACCESS_DENIED) break;
        throw error;
      }
      items.push(...listOf(body));
      next = text(body, 'pagination.next_cursor');
      if (!next) break;
    }
    const cases = items
      .map(
        (c): SecurityCase => ({
          id: clean(text(c, 'case_id', 'caseId', 'id'), 100),
          title: clean(text(c, 'title'), 300) || 'Security case',
          severity: clean(text(c, 'severity'), 40),
          status: clean(text(c, 'status'), 40),
          category: clean(text(c, 'category'), 100),
          alerts: num(pick(c, 'alerts_count', 'alertsCount')) ?? 0,
          createdAt: timeOf(pick(c, 'created_at', 'createdAt')),
          updatedAt: timeOf(pick(c, 'updated_at', 'updatedAt')),
          impacted: [],
        }),
      )
      .filter((c) => c.id && !/^closed$/i.test(c.status));
    await Promise.all(
      cases.slice(0, CASE_DETAILS).map(async (c) => {
        try {
          const body = await client.get(`/api/v1/cases/${encodeURIComponent(c.id)}/impacted-entities?limit=100`);
          c.impacted = [
            ...new Set(
              listOf(body)
                .map((e) => clean(text(e, 'endpoint.name', 'user.name', 'user.email', 'ip_address'), 200))
                .filter(Boolean),
            ),
          ].slice(0, 50);
        } catch {
          // The list of cases still shows without what each touches.
        }
      }),
    );
    return cases;
  }
}

/** The ConnectWise companies linked to an Atlas client. */
function companiesOf(saved: Saved, clientId: string) {
  return Object.entries(saved.map)
    .flatMap(([companyId, m]) => (m.action === 'link' && m.clientId === clientId ? [companyId] : []))
    .sort();
}

function notLinked() {
  const reason = 'This client is not linked to a ConnectWise company.';
  return { patching: none<PatchReport>(reason), backup: none<BackupReport>(reason), vulnerabilities: none<VulnReport>(reason), incidents: none<SecurityCase[]>(reason) };
}
