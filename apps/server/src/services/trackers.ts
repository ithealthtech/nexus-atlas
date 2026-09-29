import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database, type DatabaseHandle } from '@atlas/db';
import {
  TRACKER_SOON_DAYS,
  atLeast,
  type Actor,
  type TrackerCounts,
  type TrackerFilter,
  type TrackerItem,
  type TrackerKind,
  type TrackerReport,
  type TrackerRunResult,
} from '@atlas/shared';
import { actorFor } from '../identity/service.js';
import { AssetService } from './assets.js';
import { certificateHost, type CertProbe, type ServedCertificate } from './cert-probe.js';
import type { DomainLookup } from './domain-lookup.js';
import { LayoutService } from './layouts.js';
import { Scope } from './scope.js';
import type { SettingsService } from './settings.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** How many domains and hosts one scheduled run checks, so a large organization is spread over several runs. */
const PER_RUN = 40;
/** How many lookups run at once. */
const PARALLEL = 5;
const MAX_ITEMS = 1000;
/** Keeps two servers sharing a database from running the same checks. */
const LOCK = 727278;
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const today = () => new Date().toISOString().slice(0, 10);

/** The built-in layouts the trackers read, and the fields that hold what they track. */
const LAYOUT: Record<TrackerKind, { key: string; source: string }> = {
  domain: { key: 'domain', source: 'registrar' },
  ssl: { key: 'ssl_certificate', source: 'issuer' },
};

export const emptyCounts = (): TrackerCounts => ({ total: 0, expired: 0, soon: 0, active: 0, unknown: 0 });

/** Where an expiry date falls: expired, within the soon window, active, or unknown (no date). */
export function standing(date: string | null, now = today(), soonDays = TRACKER_SOON_DAYS): TrackerFilter {
  if (!isDate(date)) return 'unknown';
  if (date < now) return 'expired';
  const soon = new Date(Date.parse(`${now}T00:00:00Z`) + soonDays * DAY).toISOString().slice(0, 10);
  return date <= soon ? 'soon' : 'active';
}

/**
 * Whether an item is due for another check. Certificates are read daily. A domain is looked up daily when it
 * expires within 60 days or its date is unknown, and weekly otherwise; registries rate-limit, and a registration
 * date rarely changes. A failed check is retried after six hours.
 */
export function due(
  kind: TrackerKind,
  last: { checkedAt: Date; ok: boolean } | null,
  expires: string | null,
  now = Date.now(),
) {
  if (!last) return true;
  const age = now - last.checkedAt.getTime();
  if (!last.ok) return age >= 6 * HOUR;
  if (kind === 'ssl') return age >= 20 * HOUR;
  const soon = !isDate(expires) || Date.parse(`${expires}T00:00:00Z`) - now < 60 * DAY;
  return age >= (soon ? 20 * HOUR : 7 * DAY);
}

type Row = {
  id: string;
  kind: TrackerKind;
  name: string;
  clientId: string;
  clientName: string;
  fields: Record<string, unknown>;
  version: number;
  checkedAt: Date | null;
  ok: boolean | null;
  detail: string | null;
};

async function pool<T>(items: T[], work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

/**
 * The domain and SSL trackers. Domains assets are re-looked-up (RDAP and DNS) on a schedule; the certificate each
 * domain, and each SSL certificates asset's host, serves is read over TLS. What's found is saved on the asset, as
 * a new version, so the Expirations page and its email alerts (at the organization's alert days, and on the day)
 * see it. The report and lists read the assets the viewer can see.
 */
export class TrackerService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly deps: { domains?: DomainLookup; probe?: CertProbe },
  ) {}

  /** Domains and SSL certificates assets in these clients, with the tracker's last check of each. */
  private async rows(db: Database, orgId: string, clientIds: string[], kinds: TrackerKind[] = ['domain', 'ssl']) {
    if (!clientIds.length) return [];
    const layouts = await db
      .select({ id: schema.assetLayouts.id, key: schema.assetLayouts.key })
      .from(schema.assetLayouts)
      .where(
        and(
          eq(schema.assetLayouts.orgId, orgId),
          inArray(
            schema.assetLayouts.key,
            kinds.map((k) => LAYOUT[k].key),
          ),
        ),
      );
    if (!layouts.length) return [];
    const kindOf = new Map(layouts.map((l) => [l.id, l.key === 'domain' ? 'domain' : 'ssl'] as const));
    const rows = await db
      .select({
        id: schema.assets.id,
        layoutId: schema.assets.layoutId,
        name: schema.assets.name,
        clientId: schema.assets.clientId,
        clientName: schema.clients.name,
        fields: schema.assets.fields,
        version: schema.assets.version,
      })
      .from(schema.assets)
      .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
      .where(
        and(
          eq(schema.assets.orgId, orgId),
          eq(schema.assets.archived, false),
          inArray(schema.assets.clientId, clientIds),
          inArray(
            schema.assets.layoutId,
            layouts.map((l) => l.id),
          ),
        ),
      )
      .orderBy(asc(schema.assets.name))
      .limit(20_000);
    // Each row's own check: a domain's registration check, or a certificate's TLS check.
    const c = schema.trackerChecks;
    const checks = await db
      .select({ assetId: c.assetId, kind: c.kind, checkedAt: c.checkedAt, ok: c.ok, detail: c.detail })
      .from(c)
      .where(and(eq(c.orgId, orgId), inArray(c.clientId, clientIds)));
    const checkOf = new Map(checks.map((k) => [`${k.assetId}:${k.kind}`, k]));
    return rows.map(({ layoutId, ...r }): Row => {
      const kind = kindOf.get(layoutId)!;
      const check = checkOf.get(`${r.id}:${kind}`);
      return {
        ...r,
        kind,
        fields: (r.fields ?? {}) as Record<string, unknown>,
        checkedAt: check?.checkedAt ?? null,
        ok: check?.ok ?? null,
        detail: check?.detail ?? null,
      };
    });
  }

  private async readable(scope: Scope, clientId?: string) {
    const ids = await scope.readableClientIds();
    return clientId ? ids.filter((id) => id === clientId) : ids;
  }

  async report(scope: Scope, opts: { clientId?: string } = {}): Promise<TrackerReport> {
    const now = today();
    const totals = { domain: emptyCounts(), ssl: emptyCounts() };
    const byClient = new Map<string, TrackerReport['clients'][number]>();
    for (const r of await this.rows(scope.db, scope.actor.orgId, await this.readable(scope, opts.clientId))) {
      const s = standing(isDate(r.fields.expires) ? r.fields.expires : null, now);
      totals[r.kind].total++;
      totals[r.kind][s]++;
      let entry = byClient.get(r.clientId);
      if (!entry)
        byClient.set(
          r.clientId,
          (entry = { clientId: r.clientId, clientName: r.clientName, domain: emptyCounts(), ssl: emptyCounts() }),
        );
      entry[r.kind].total++;
      entry[r.kind][s]++;
    }
    const attention = (e: TrackerReport['clients'][number]) =>
      e.domain.expired + e.ssl.expired + (e.domain.soon + e.ssl.soon) / 1000;
    const clients = [...byClient.values()].sort(
      (a, b) => attention(b) - attention(a) || a.clientName.localeCompare(b.clientName),
    );
    return { soonDays: TRACKER_SOON_DAYS, ...totals, clients };
  }

  /** One tracker's items, soonest expiry first (unknown dates last), optionally only one standing. */
  async items(
    scope: Scope,
    kind: TrackerKind,
    opts: { clientId?: string; filter?: TrackerFilter } = {},
  ): Promise<TrackerItem[]> {
    const now = today();
    const start = Date.parse(`${now}T00:00:00Z`);
    return (await this.rows(scope.db, scope.actor.orgId, await this.readable(scope, opts.clientId), [kind]))
      .map((r): TrackerItem => {
        const expires = isDate(r.fields.expires) ? r.fields.expires : null;
        return {
          assetId: r.id,
          kind,
          name: r.name,
          clientId: r.clientId,
          clientName: r.clientName,
          source: text(r.fields[LAYOUT[kind].source]),
          expires,
          daysLeft: expires ? Math.round((Date.parse(`${expires}T00:00:00Z`) - start) / DAY) : null,
          standing: standing(expires, now),
          checkedAt: r.checkedAt?.toISOString() ?? null,
          ok: r.ok,
          detail: r.detail ?? '',
        };
      })
      .filter((i) => !opts.filter || i.standing === opts.filter)
      .sort(
        (a, b) =>
          (a.expires ?? '9999').localeCompare(b.expires ?? '9999') ||
          a.clientName.localeCompare(b.clientName) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, MAX_ITEMS);
  }

  private async record(
    orgId: string,
    r: { id: string; clientId: string },
    kind: TrackerKind,
    host: string,
    ok: boolean,
    detail: string,
  ) {
    const values = { clientId: r.clientId, host, checkedAt: new Date(), ok, detail: detail.slice(0, 500) };
    await this.db
      .insert(schema.trackerChecks)
      .values({ orgId, assetId: r.id, kind, ...values })
      .onConflictDoUpdate({ target: [schema.trackerChecks.assetId, schema.trackerChecks.kind], set: values });
  }

  /** Saves changed fields on an asset as a new version; nothing is saved when nothing changed. */
  private async save(scope: Scope, assets: AssetService, r: Row, fields: Record<string, unknown>) {
    const next = { ...r.fields, ...fields };
    if (Object.keys(fields).every((k) => text(r.fields[k]) === text(fields[k]))) return;
    await assets.update(scope, r.id, { version: r.version, fields: next }, 'Updated by the domain and SSL tracker');
  }

  /**
   * Checks what's due (or everything, with force) in the clients the actor can edit, up to a limit per run.
   * Returns what was checked. Failures are recorded on the item, never thrown.
   */
  async run(
    actor: Actor,
    opts: { clientId?: string; force?: boolean; limit?: number } = {},
  ): Promise<TrackerRunResult> {
    const scope = new Scope(this.db, actor);
    const editable = [...(await scope.levels())]
      .filter(([id, level]) => atLeast(level, 'edit') && (!opts.clientId || id === opts.clientId))
      .map(([id]) => id);
    const result: TrackerRunResult = { domains: 0, certificates: 0, created: 0, failed: 0 };
    if (!editable.length) return result;
    const { createCertificates } = await this.settings.trackers(actor.orgId);
    const layouts = new LayoutService(this.db);
    const assets = new AssetService(layouts);
    const rows = await this.rows(this.db, actor.orgId, editable);
    const checks = await this.db
      .select()
      .from(schema.trackerChecks)
      .where(and(eq(schema.trackerChecks.orgId, actor.orgId), inArray(schema.trackerChecks.clientId, editable)));
    const lastOf = new Map(checks.map((c) => [`${c.assetId}:${c.kind}`, c]));
    const expiresOf = (r: Row) => (isDate(r.fields.expires) ? r.fields.expires : null);
    const isDue = (r: Row, kind: TrackerKind) =>
      opts.force ||
      due(kind, lastOf.get(`${r.id}:${kind}`) ?? null, kind === 'ssl' && r.kind === 'domain' ? null : expiresOf(r));

    // Hosts the SSL certificates assets already cover, per client, so a domain doesn't get a second one.
    const certHost = (r: Row) =>
      certificateHost(text(r.fields.common_name)) ??
      certificateHost(r.name) ??
      certificateHost(text(r.fields.installed_on));
    const covered = new Set(rows.filter((r) => r.kind === 'ssl').map((r) => `${r.clientId}:${certHost(r)}`));

    type Job = { run: () => Promise<void> };
    const jobs: Job[] = [];
    let limit = opts.limit ?? PER_RUN;
    for (const r of rows) {
      if (limit <= 0) break;
      if (r.kind === 'domain' && this.deps.domains && isDue(r, 'domain')) {
        limit--;
        jobs.push({ run: () => this.checkDomain(scope, assets, r, result) });
      }
      if (limit <= 0) break;
      if (!this.deps.probe) continue;
      if (r.kind === 'ssl' && isDue(r, 'ssl')) {
        limit--;
        jobs.push({ run: () => this.checkCertificate(scope, assets, r, certHost(r), result) });
      } else if (
        r.kind === 'domain' &&
        createCertificates &&
        !covered.has(`${r.clientId}:${certificateHost(r.name)}`) &&
        isDue(r, 'ssl')
      ) {
        // Two Domains assets for the same host would otherwise each add a certificate.
        covered.add(`${r.clientId}:${certificateHost(r.name)}`);
        limit--;
        jobs.push({ run: () => this.certificateFor(scope, assets, layouts, r, result) });
      }
    }
    await pool(jobs, (j) => j.run());
    return result;
  }

  private async checkDomain(scope: Scope, assets: AssetService, r: Row, result: TrackerRunResult) {
    result.domains++;
    const orgId = scope.actor.orgId;
    try {
      const found = await this.deps.domains!.lookup(r.name);
      if (!found) {
        result.failed++;
        return await this.record(orgId, r, 'domain', r.name, false, 'Not a domain name that can be looked up.');
      }
      if (!found.expires) {
        result.failed++;
        return await this.record(orgId, r, 'domain', found.domain, false, "The registry didn't give an expiry date.");
      }
      const fields: Record<string, unknown> = { expires: found.expires };
      if (found.registrar) fields.registrar = found.registrar;
      if (found.nameservers) fields.nameservers = found.nameservers;
      if (found.dns_host) fields.dns_host = found.dns_host;
      await this.save(scope, assets, r, fields);
      await this.record(orgId, r, 'domain', found.domain, true, found.registrar ? `Registrar: ${found.registrar}` : '');
    } catch (error) {
      result.failed++;
      await this.record(orgId, r, 'domain', r.name, false, (error as Error).message);
    }
  }

  private async checkCertificate(
    scope: Scope,
    assets: AssetService,
    r: Row,
    host: string | null,
    result: TrackerRunResult,
  ) {
    result.certificates++;
    const orgId = scope.actor.orgId;
    if (!host) {
      result.failed++;
      return this.record(
        orgId,
        r,
        'ssl',
        r.name,
        false,
        'No host to check: enter the site it protects as the common name (a wildcard needs a host under Installed on).',
      );
    }
    try {
      const cert = await this.deps.probe!(host);
      const fields: Record<string, unknown> = { expires: cert.expires };
      if (cert.issuer) fields.issuer = cert.issuer;
      if (cert.altNames.length && !text(r.fields.subject_alt_names))
        fields.subject_alt_names = cert.altNames.join('\n');
      await this.save(scope, assets, r, fields);
      await this.record(orgId, r, 'ssl', host, true, summary(cert));
    } catch (error) {
      result.failed++;
      await this.record(orgId, r, 'ssl', host, false, (error as Error).message);
    }
  }

  /** Reads the certificate a domain's website serves and, when there is one, adds an SSL certificates asset for it. */
  private async certificateFor(
    scope: Scope,
    assets: AssetService,
    layouts: LayoutService,
    r: Row,
    result: TrackerRunResult,
  ) {
    const host = certificateHost(r.name);
    const orgId = scope.actor.orgId;
    if (!host) return;
    result.certificates++;
    let cert: ServedCertificate;
    try {
      cert = await this.deps.probe!(host);
    } catch (error) {
      // Many domains serve no website; remember that, so it's asked again only after the retry interval.
      return this.record(orgId, r, 'ssl', host, false, (error as Error).message);
    }
    try {
      const layout = (await layouts.list(scope.actor)).find((l) => l.key === 'ssl_certificate' && !l.archived);
      if (!layout) return await this.record(orgId, r, 'ssl', host, false, 'The SSL certificates layout is archived.');
      const created = await assets.create(scope, r.clientId, {
        layoutId: layout.id,
        name: host,
        fields: {
          common_name: host,
          issuer: cert.issuer,
          expires: cert.expires,
          subject_alt_names: cert.altNames.join('\n'),
        },
        notes: 'Added by the SSL tracker from the certificate this domain serves.',
      });
      result.created++;
      await this.record(orgId, r, 'ssl', host, true, `Added as an SSL certificate`);
      await this.record(orgId, { id: created.id, clientId: r.clientId }, 'ssl', host, true, summary(cert));
    } catch (error) {
      result.failed++;
      await this.record(orgId, r, 'ssl', host, false, (error as Error).message);
    }
  }

  /** The organization's owner, as whom scheduled checks save their findings; null when there's none to use. */
  async trackerActor(orgId: string): Promise<Actor | null> {
    const [owner] = await this.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.role, 'owner'), eq(schema.users.disabled, false)))
      .orderBy(asc(schema.users.createdAt))
      .limit(1);
    return owner ? { ...actorFor(owner), name: 'Domain and SSL tracker' } : null;
  }
}

function summary(cert: ServedCertificate) {
  const who = cert.issuer ? `Issued by ${cert.issuer}` : 'Certificate read';
  return cert.trusted ? who : `${who}; not trusted (${cert.problem || 'unknown reason'})`;
}

/** Runs each organization's scheduled checks every few minutes, a batch at a time. */
export class TrackerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly handle: DatabaseHandle,
    private readonly settings: SettingsService,
    private readonly trackers: TrackerService,
    private readonly log: (error: unknown) => void,
  ) {}

  start(intervalMs = 15 * 60_000) {
    this.timer = setInterval(() => void this.tick().catch(this.log), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    // Advisory locks belong to one database session, so take and release it on one pooled connection.
    const client = await this.handle.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [LOCK]);
      if (!rows[0]!.ok) return;
      try {
        for (const { id } of await this.handle.db.select({ id: schema.orgs.id }).from(schema.orgs)) {
          if (!(await this.settings.trackers(id)).enabled) continue;
          const actor = await this.trackers.trackerActor(id);
          if (actor) await this.trackers.run(actor).catch(this.log);
        }
      } finally {
        await client.query('select pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
      }
    } finally {
      client.release();
      this.running = false;
    }
  }
}
