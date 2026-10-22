import { and, asc, gte } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { HEALTH_PARTS, ROLE_INFO, type HealthPartScore } from '@atlas/shared';
import { DAY, type Collector } from './context.js';

/** One row per client: how much is documented, and how its devices are doing. */
export const executive: Collector = async (report) => {
  const assets = await report.assets();
  const documents = await report.documents();
  const licenses = await report.licenses();
  const endpoints = await report.endpoints();
  report.section(
    'Client overview',
    [
      'Client',
      'Assets',
      'Documents',
      'Reviews overdue',
      'Tracked subscriptions',
      'Endpoints',
      'Offline',
      'Protection missing / stopped',
      'Unknown protection',
    ],
    report.clients.map((c) => {
      const devices = endpoints.filter((e) => e.clientId === c.id);
      const count = (n: number) => (devices.length ? String(n) : 'Not available');
      return [
        c.name,
        String(assets.filter((a) => a.clientId === c.id).length),
        String(documents.filter((d) => d.clientId === c.id).length),
        String(documents.filter((d) => d.clientId === c.id && d.reviewDate && d.reviewDate < report.today).length),
        String(licenses.filter((l) => l.clientId === c.id && l.status === 'active').length),
        count(devices.length),
        count(devices.filter((e) => e.online === false).length),
        count(devices.filter((e) => e.protection === 'missing' || e.protection === 'not_running').length),
        count(devices.filter((e) => e.protection === null).length),
      ];
    }),
  );
  // Each client's health score, as Atlas last worked it out. Scores are for staff, so client accounts don't get them.
  if (!ROLE_INFO[report.actor.role].staff) return;
  const t = schema.clientHealth;
  const latest = new Map<string, { score: number | null; parts: HealthPartScore[]; day: string }>();
  for (const r of await report.db
    .select({ clientId: t.clientId, day: t.day, score: t.score, parts: t.parts })
    .from(t)
    .where(and(report.selected(t), gte(t.day, new Date(Date.parse(report.today) - DAY).toISOString().slice(0, 10))))
    .orderBy(asc(t.day)))
    latest.set(r.clientId, { score: r.score, parts: r.parts as HealthPartScore[], day: r.day });
  const shown = (score: number | null | undefined) =>
    score === null || score === undefined ? 'Not measured' : String(score);
  report.section(
    'Client health',
    ['Client', 'Health score', 'Security', 'Endpoints', 'Documentation', 'Renewals'],
    report.clients.map((c) => {
      const h = latest.get(c.id);
      return [
        c.name,
        h ? shown(h.score) : 'Not worked out yet',
        ...HEALTH_PARTS.map((part) => shown(h?.parts.find((p) => p.part === part)?.score)),
      ];
    }),
  );
  report.source(
    'Client health',
    'The 0–100 score Atlas keeps for each client from security, endpoints, documentation and renewals, refreshed hourly.',
    [...latest.values()]
      .map((h) => h.day)
      .sort()
      .at(-1) ?? null,
  );
};
