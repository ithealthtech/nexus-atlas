import { and, asc, count, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  HEALTH_PART_INFO,
  ROLE_INFO,
  type ClientHealth,
  type ClientHealthDetail,
  type ClientHealthSummary,
  type HealthFinding,
  type HealthPart,
  type HealthPartScore,
  type PasswordHealthReport,
  type RmmHealthCounts,
  type TrackerReport,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { actorFor } from '../identity/service.js';
import { clientEndpoints } from './integrations/bitdefender.js';
import { RmmHealthService } from './rmm-health.js';
import { Scope } from './scope.js';
import type { SettingsService } from './settings.js';
import { WarrantyService } from './warranty.js';

const DAY = 86_400_000;
const KEEP_DAYS = 400;
/** How long a recorded score stands before it is worked out again when someone looks. */
const FRESH_MS = 60 * 60_000;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Dated items in one category: past their date, due within the trackers' window, or in date. */
export interface Dated {
  expired: number;
  soon: number;
  active: number;
  /** No date known: not counted either way, but worth checking. */
  unknown: number;
}
/** What a client's score is worked out from. */
export interface HealthInputs {
  passwords: { total: number; withIssues: number; breached: number };
  /** RMM devices, or null when the client has none. */
  devices: RmmHealthCounts | null;
  staleDays: number;
  /** Devices whose BitLocker state the collector reported, and those with a volume not encrypted. */
  encryption: { reported: number; unprotected: number };
  /**
   * Bitdefender GravityZone, for a client linked to it: the endpoints it manages, those infected or needing attention,
   * and RMM devices it doesn't manage. Missing or null when the client isn't linked.
   */
  bitdefender?: { endpoints: number; infected: number; attention: number; missing: number } | null;
  documents: { total: number; overdue: number };
  primaryContact: boolean;
  locations: number;
  assets: number;
  domains: Dated;
  certificates: Dated;
  warranties: Dated;
  subscriptions: Dated;
}

/** One thing measured within a part: how well it does (0–1), how much it counts, and what lowers it. */
interface Measure {
  value: number;
  weight: number;
  /** `loss` is the share of this measure (0–1) each finding costs. */
  findings: { text: string; section: string; loss: number }[];
}
const ratio = (good: number, total: number) => (total ? good / total : 1);
const simple = (value: number, text: string, section: string, weight = 1): Measure => ({
  value,
  weight,
  findings: value < 1 ? [{ text, section, loss: 1 - value }] : [],
});

/**
 * A client's health from its inputs. Each part is the weighted mean of what it measures; the overall score is the
 * weighted mean of the parts that measured anything. Each finding says how many points fixing it would add.
 */
export function scoreClient(clientId: string, clientName: string, input: HealthInputs, now = new Date()): ClientHealth {
  const parts: { part: HealthPart; detail: string; measures: Measure[] }[] = [];

  const { passwords: pw, devices, encryption } = input;
  const security: Measure[] = [];
  if (pw.total)
    security.push(
      simple(
        ratio(pw.total - pw.withIssues, pw.total),
        `${pw.withIssues} of ${plural(pw.total, 'password')} ${pw.withIssues === 1 ? 'has' : 'have'} issues${pw.breached ? `, ${pw.breached} found in a data breach` : ''}`,
        '/passwords',
      ),
    );
  if (devices?.total) {
    const missing = devices.total - devices.protectionRunning;
    security.push(
      simple(
        ratio(devices.protectionRunning, devices.total),
        `${plural(missing, 'device')} without endpoint protection running`,
        '/assets',
      ),
    );
  }
  if (encryption.reported)
    security.push(
      simple(
        ratio(encryption.reported - encryption.unprotected, encryption.reported),
        `${plural(encryption.unprotected, 'device')} with a disk not encrypted`,
        '/assets',
      ),
    );
  const bd = input.bitdefender;
  if (bd && bd.endpoints + bd.missing > 0) {
    // Its findings point at the client's overview, where the Bitdefender card lists each endpoint and device.
    if (bd.endpoints) {
      // Malware still on a machine counts double: it's the one thing here that is already a breach.
      security.push(
        simple(
          ratio(bd.endpoints - bd.infected, bd.endpoints),
          `${plural(bd.infected, 'endpoint')} still infected, per Bitdefender`,
          '',
          2,
        ),
        simple(
          ratio(bd.endpoints - bd.attention, bd.endpoints),
          `${plural(bd.attention, 'Bitdefender endpoint')} needing attention`,
          '',
        ),
      );
    }
    security.push(
      simple(ratio(bd.endpoints, bd.endpoints + bd.missing), `${plural(bd.missing, 'device')} without Bitdefender`, ''),
    );
  }
  parts.push({
    part: 'security',
    detail: [
      pw.total && plural(pw.total, 'password'),
      devices?.total && `protection on ${plural(devices.total, 'device')}`,
      encryption.reported && `BitLocker on ${encryption.reported}`,
      bd?.endpoints && `Bitdefender on ${bd.endpoints}`,
    ]
      .filter(Boolean)
      .join(', '),
    measures: security,
  });

  parts.push({
    part: 'endpoints',
    detail: devices?.total ? `${plural(devices.total, 'device')} in the RMM` : '',
    measures: devices?.total
      ? [
          simple(
            ratio(devices.online, devices.total),
            `${plural(devices.total - devices.online, 'device')} not online`,
            '/assets',
          ),
          simple(
            ratio(devices.current, devices.total),
            `${plural(devices.total - devices.current, 'device')} not checked in within ${input.staleDays} days`,
            '/assets',
          ),
        ]
      : [],
  });

  const docs = input.documents;
  parts.push({
    part: 'documentation',
    detail: `${plural(input.assets, 'asset')}, ${plural(docs.total, 'document')}`,
    measures: [
      simple(input.primaryContact ? 1 : 0, 'No primary contact', '/contacts'),
      simple(input.locations ? 1 : 0, 'No locations', '/locations'),
      simple(input.assets ? 1 : 0, 'No assets documented', '/assets'),
      simple(docs.total ? 1 : 0, 'No documents yet', '/documents'),
      ...(docs.total
        ? [
            simple(
              ratio(docs.total - docs.overdue, docs.total),
              `${plural(docs.overdue, 'document')} past ${docs.overdue === 1 ? 'its' : 'their'} review date`,
              '/documents',
              2,
            ),
          ]
        : []),
    ],
  });

  // Renewals: an expired item counts fully against it, one due soon counts half.
  const kinds = [
    ['domain', input.domains, '/trackers/domains'],
    ['SSL certificate', input.certificates, '/trackers/ssl'],
    ['warranty', input.warranties, '/assets'],
    ['subscription', input.subscriptions, '/licenses'],
  ] as const;
  const tracked = kinds.reduce((n, [, d]) => n + d.expired + d.soon + d.active, 0);
  const renewals: Measure[] = tracked
    ? [
        {
          value: ratio(tracked - kinds.reduce((n, [, d]) => n + d.expired + d.soon / 2, 0), tracked),
          weight: 1,
          findings: kinds.flatMap(([noun, d, section]) => [
            ...(d.expired
              ? [
                  {
                    text: `${plural(d.expired, noun, noun === 'warranty' ? 'warranties' : undefined)} expired`,
                    section,
                    loss: d.expired / tracked,
                  },
                ]
              : []),
            ...(d.soon
              ? [
                  {
                    text: `${plural(d.soon, noun, noun === 'warranty' ? 'warranties' : undefined)} expiring soon`,
                    section,
                    loss: d.soon / 2 / tracked,
                  },
                ]
              : []),
          ]),
        },
      ]
    : [];
  const unknownDates = input.domains.unknown + input.certificates.unknown;
  parts.push({
    part: 'renewals',
    detail: tracked ? `${plural(tracked, 'dated item')}` : '',
    measures: renewals,
  });

  // The overall score, and what each finding is worth in it.
  const measured = parts.filter((p) => p.measures.length);
  const totalWeight = measured.reduce((n, p) => n + HEALTH_PART_INFO[p.part].weight, 0);
  const partScore = (ms: Measure[]) => {
    const w = ms.reduce((n, m) => n + m.weight, 0);
    return ms.reduce((n, m) => n + m.value * m.weight, 0) / w;
  };
  const scored: HealthPartScore[] = parts.map((p) => {
    if (!p.measures.length)
      return { part: p.part, score: null, detail: p.detail || 'Nothing to measure yet', findings: [] };
    const w = p.measures.reduce((n, m) => n + m.weight, 0);
    const share = HEALTH_PART_INFO[p.part].weight / totalWeight;
    const findings: HealthFinding[] = p.measures.flatMap((m) =>
      m.findings.map((f) => ({
        text: f.text,
        section: f.section,
        gain: Math.max(1, Math.round(((f.loss * m.weight) / w) * 100 * share)),
      })),
    );
    if (p.part === 'renewals' && unknownDates)
      findings.push({
        text: `${plural(unknownDates, 'domain or certificate', 'domains or certificates')} with no known expiry date`,
        section: '/trackers/domains',
        gain: 0,
      });
    return { part: p.part, score: Math.round(partScore(p.measures) * 100), detail: p.detail, findings };
  });
  const score = measured.length
    ? Math.round(
        measured.reduce((n, p) => n + partScore(p.measures) * 100 * HEALTH_PART_INFO[p.part].weight, 0) / totalWeight,
      )
    : null;
  return { clientId, clientName, score, parts: scored, computedAt: now.toISOString() };
}

const emptyDated = (): Dated => ({ expired: 0, soon: 0, active: 0, unknown: 0 });
const dated = ({ expired, soon, active, unknown }: Dated): Dated => ({ expired, soon, active, unknown });

/**
 * Works out every client's health score and keeps one row per client per day, for the trend. Scores are worked
 * out with the owner's view, so everyone on staff sees the same number for a client, and only staff see them.
 */
export class ClientHealthService {
  constructor(
    private readonly db: Database,
    private readonly deps: {
      settings: SettingsService;
      passwords: { report(scope: Scope): Promise<PasswordHealthReport> };
      trackers: { report(scope: Scope): Promise<TrackerReport> };
    },
  ) {}

  /** Works out and keeps today's score for every client of the organization. */
  async record(orgId: string, now = Date.now()) {
    const scores = await this.compute(orgId, now);
    if (!scores.length) return;
    const t = schema.clientHealth;
    const day = dayOf(now);
    await this.db
      .insert(t)
      .values(scores.map((s) => ({ orgId, clientId: s.clientId, day, score: s.score, parts: s.parts })))
      .onConflictDoUpdate({
        target: [t.orgId, t.clientId, t.day],
        set: { score: sql`excluded.score`, parts: sql`excluded.parts`, updatedAt: new Date(now) },
      });
    await this.db.delete(t).where(and(eq(t.orgId, orgId), lt(t.day, dayOf(now - KEEP_DAYS * DAY))));
  }

  /** Records again when today's scores are missing or more than an hour old (on the background pass, and on view). */
  async refresh(orgId: string, clientId?: string) {
    const t = schema.clientHealth;
    const [row] = await this.db
      .select({ updatedAt: sql<Date | null>`min(${t.updatedAt})` })
      .from(t)
      .where(and(eq(t.orgId, orgId), eq(t.day, dayOf(Date.now())), clientId ? eq(t.clientId, clientId) : undefined));
    if (!row?.updatedAt || Date.now() - new Date(row.updatedAt).getTime() > FRESH_MS) await this.record(orgId);
  }

  /** One client's score, what lowers it, and its trend. Staff only. */
  async forClient(scope: Scope, clientId: string, days = 90): Promise<ClientHealthDetail> {
    if (!ROLE_INFO[scope.actor.role].staff) throw new HttpError(404, 'Client not found.');
    await scope.require(clientId, 'read', 'Client');
    await this.refresh(scope.actor.orgId, clientId);
    const t = schema.clientHealth;
    const rows = await this.db
      .select({ day: t.day, score: t.score, parts: t.parts, updatedAt: t.updatedAt, name: schema.clients.name })
      .from(t)
      .innerJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .where(and(eq(t.orgId, scope.actor.orgId), eq(t.clientId, clientId), gte(t.day, dayOf(Date.now() - days * DAY))))
      .orderBy(asc(t.day));
    const latest = rows.at(-1);
    if (!latest) throw new HttpError(404, 'Client not found.');
    const trend = rows.flatMap((r) => (r.score === null ? [] : [{ day: r.day, score: r.score }]));
    return {
      clientId,
      clientName: latest.name,
      score: latest.score,
      parts: latest.parts as HealthPartScore[],
      computedAt: latest.updatedAt.toISOString(),
      trend,
      change: change(trend, latest.score),
    };
  }

  /** Every client this person can see, lowest score first. Staff only. */
  async list(scope: Scope): Promise<ClientHealthSummary[]> {
    if (!ROLE_INFO[scope.actor.role].staff) return [];
    await this.refresh(scope.actor.orgId);
    const levels = await scope.levels();
    const t = schema.clientHealth;
    const rows = await this.db
      .select({ clientId: t.clientId, day: t.day, score: t.score, parts: t.parts, name: schema.clients.name })
      .from(t)
      .innerJoin(schema.clients, eq(schema.clients.id, t.clientId))
      .where(and(eq(t.orgId, scope.actor.orgId), gte(t.day, dayOf(Date.now() - 30 * DAY))))
      .orderBy(asc(t.day));
    const byClient = new Map<string, typeof rows>();
    for (const r of rows) {
      if ((levels.get(r.clientId) ?? 'none') === 'none') continue;
      byClient.set(r.clientId, [...(byClient.get(r.clientId) ?? []), r]);
    }
    return [...byClient.values()]
      .map((list) => {
        const latest = list.at(-1)!;
        const trend = list.flatMap((r) => (r.score === null ? [] : [{ day: r.day, score: r.score }]));
        const parts = (latest.parts as HealthPartScore[]).filter((p) => p.score !== null);
        const weakest = parts.sort((a, b) => a.score! - b.score!)[0];
        return {
          clientId: latest.clientId,
          clientName: latest.name,
          score: latest.score,
          change: change(trend, latest.score),
          weakest: weakest && weakest.score! < 90 ? weakest.part : null,
          trend: trend.map((p) => p.score),
        };
      })
      .sort((a, b) => (a.score ?? 101) - (b.score ?? 101) || a.clientName.localeCompare(b.clientName));
  }

  /** Every client's score, worked out from what the owner can see. */
  async compute(orgId: string, now = Date.now()): Promise<ClientHealth[]> {
    const db = this.db;
    const [owner] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), eq(schema.users.role, 'owner'), eq(schema.users.disabled, false)))
      .orderBy(asc(schema.users.createdAt))
      .limit(1);
    if (!owner) return [];
    const scope = new Scope(db, { ...actorFor(owner), name: 'Client health' });
    const clients = await db
      .select({ id: schema.clients.id, name: schema.clients.name })
      .from(schema.clients)
      .where(eq(schema.clients.orgId, orgId));
    if (!clients.length) return [];
    const today = dayOf(now);
    const soon = dayOf(now + 30 * DAY);
    const inputs = new Map<string, HealthInputs>(
      clients.map((c) => [
        c.id,
        {
          passwords: { total: 0, withIssues: 0, breached: 0 },
          devices: null,
          staleDays: 7,
          encryption: { reported: 0, unprotected: 0 },
          documents: { total: 0, overdue: 0 },
          primaryContact: false,
          locations: 0,
          assets: 0,
          domains: emptyDated(),
          certificates: emptyDated(),
          warranties: emptyDated(),
          subscriptions: emptyDated(),
        },
      ]),
    );
    const each = (clientId: string | null, apply: (input: HealthInputs) => void) => {
      const input = clientId ? inputs.get(clientId) : undefined;
      if (input) apply(input);
    };

    const passwords = await this.deps.passwords.report(scope);
    for (const c of passwords.clients)
      each(c.id, (i) => ((i.passwords.total = c.total), (i.passwords.withIssues = c.withIssues)));
    for (const item of passwords.items)
      if (item.issues.includes('breached')) each(item.clientId, (i) => i.passwords.breached++);

    const rmm = await new RmmHealthService(this.deps.settings).report(scope);
    for (const c of rmm.clients) each(c.clientId, (i) => ((i.devices = c.counts), (i.staleDays = rmm.staleDays)));

    // Bitdefender, for each client linked to a GravityZone company.
    const links = (await this.deps.settings.bitdefenderLinks(orgId)) ?? {};
    for (const m of Object.values(links)) {
      if (m.action !== 'link' || !inputs.has(m.clientId)) continue;
      const view = await clientEndpoints(db, orgId, m.clientId, true, now);
      each(m.clientId, (i) => {
        i.bitdefender = {
          endpoints: view.endpoints.length,
          infected: view.counts.infected,
          attention: view.counts.attention,
          missing: view.missing.length,
        };
      });
    }

    const warranty = await new WarrantyService(this.deps.settings).report(scope);
    for (const c of warranty.clients) each(c.clientId, (i) => (i.warranties = dated(c.counts)));
    const trackers = await this.deps.trackers.report(scope);
    for (const c of trackers.clients)
      each(c.clientId, (i) => ((i.domains = dated(c.domain)), (i.certificates = dated(c.ssl))));

    for (const d of await db
      .select({ clientId: schema.bitlockerDevices.clientId, volumes: schema.bitlockerDevices.volumes })
      .from(schema.bitlockerDevices)
      .where(and(eq(schema.bitlockerDevices.orgId, orgId), eq(schema.bitlockerDevices.blocked, false))))
      if (d.volumes.length)
        each(d.clientId, (i) => {
          i.encryption.reported++;
          if (d.volumes.some((v) => v.protection === 'Off')) i.encryption.unprotected++;
        });
    for (const d of await db
      .select({
        clientId: schema.documents.clientId,
        total: count(),
        overdue: sql<number>`count(*) filter (where ${schema.documents.reviewDate} < ${today})`.mapWith(Number),
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.orgId, orgId),
          isNotNull(schema.documents.clientId),
          eq(schema.documents.archived, false),
        ),
      )
      .groupBy(schema.documents.clientId))
      each(d.clientId, (i) => (i.documents = { total: d.total, overdue: d.overdue }));
    for (const c of await db
      .selectDistinct({ clientId: schema.contacts.clientId })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.orgId, orgId), eq(schema.contacts.primary, true))))
      each(c.clientId, (i) => (i.primaryContact = true));
    for (const l of await db
      .select({ clientId: schema.locations.clientId, n: count() })
      .from(schema.locations)
      .where(eq(schema.locations.orgId, orgId))
      .groupBy(schema.locations.clientId))
      each(l.clientId, (i) => (i.locations = l.n));
    for (const a of await db
      .select({ clientId: schema.assets.clientId, n: count() })
      .from(schema.assets)
      .where(and(eq(schema.assets.orgId, orgId), eq(schema.assets.archived, false)))
      .groupBy(schema.assets.clientId))
      each(a.clientId, (i) => (i.assets = a.n));
    for (const l of await db
      .select({ clientId: schema.licenses.clientId, renewalDate: schema.licenses.renewalDate })
      .from(schema.licenses)
      .where(
        and(
          eq(schema.licenses.orgId, orgId),
          eq(schema.licenses.status, 'active'),
          isNotNull(schema.licenses.renewalDate),
        ),
      ))
      each(l.clientId, (i) => {
        const date = l.renewalDate!;
        if (date < today) i.subscriptions.expired++;
        else if (date <= soon) i.subscriptions.soon++;
        else i.subscriptions.active++;
      });

    return clients.map((c) => scoreClient(c.id, c.name, inputs.get(c.id)!, new Date(now)));
  }
}

/** Points up or down since about 30 days ago: the first score recorded in the last 30 days. */
function change(trend: { day: string; score: number }[], latest: number | null) {
  const since = dayOf(Date.now() - 30 * DAY);
  const then = trend.find((p) => p.day >= since);
  if (latest === null || !then || then === trend.at(-1)) return null;
  return latest - then.score;
}
