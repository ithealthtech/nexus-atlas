import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import { standing } from '../trackers.js';
import { DAY, MAX_REPORT_ROWS, capped, dateValue, iso, newest, type Collector } from './context.js';

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const STATUS = { expired: 'Expired', soon: 'Expiring soon', active: 'Active', unknown: 'No expiry date' } as const;

/** Domains and SSL certificates, by expiry, with the trackers' latest automatic check of each. */
export const domains: Collector = async (report) => {
  // The Domains and SSL certificates layouts, read the way the trackers read them.
  const layouts = await report.db
    .select({ id: schema.assetLayouts.id, key: schema.assetLayouts.key })
    .from(schema.assetLayouts)
    .where(
      and(
        eq(schema.assetLayouts.orgId, report.actor.orgId),
        inArray(schema.assetLayouts.key, ['domain', 'ssl_certificate']),
      ),
    );
  const isDomain = new Set(layouts.filter((l) => l.key === 'domain').map((l) => l.id));
  const records = layouts.length
    ? capped(
        await report.db
          .select({
            id: schema.assets.id,
            layoutId: schema.assets.layoutId,
            clientId: schema.assets.clientId,
            name: schema.assets.name,
            fields: schema.assets.fields,
          })
          .from(schema.assets)
          .where(
            and(
              report.selected(schema.assets),
              eq(schema.assets.archived, false),
              inArray(
                schema.assets.layoutId,
                layouts.map((l) => l.id),
              ),
            ),
          )
          .orderBy(asc(schema.assets.name))
          .limit(MAX_REPORT_ROWS + 1),
      )
    : [];
  const checks = await report.db
    .select({
      assetId: schema.trackerChecks.assetId,
      kind: schema.trackerChecks.kind,
      checkedAt: schema.trackerChecks.checkedAt,
      ok: schema.trackerChecks.ok,
      detail: schema.trackerChecks.detail,
    })
    .from(schema.trackerChecks)
    .where(report.selected(schema.trackerChecks));
  const checkOf = new Map(checks.map((c) => [`${c.assetId}:${c.kind}`, c]));
  const start = Date.parse(`${report.today}T00:00:00Z`);
  const items = records.map((r) => {
    const domain = isDomain.has(r.layoutId);
    const fields = (r.fields ?? {}) as Record<string, unknown>;
    const expires = dateValue(fields.expires) ? fields.expires : null;
    // "Expiring soon" follows the report's own lookahead rather than the trackers' 30 days.
    const state = standing(expires, report.today, report.definition.withinDays);
    const check = checkOf.get(`${r.id}:${domain ? 'domain' : 'ssl'}`);
    const day = check ? iso(check.checkedAt).slice(0, 10) : '';
    return {
      ...r,
      domain,
      fields,
      expires,
      state,
      daysLeft: expires ? String(Math.round((Date.parse(`${expires}T00:00:00Z`) - start) / DAY)) : '',
      check: !check
        ? 'Not checked yet'
        : check.ok
          ? `OK ${day}`
          : `Failed ${day}${check.detail ? `: ${check.detail}` : ''}`,
      checkedAt: check?.checkedAt ?? null,
    };
  });
  report.source(
    'Atlas domain and SSL trackers',
    'Expiry dates from Domains and SSL certificates records, with the latest automatic registration or certificate check.',
    newest(items.map((i) => i.checkedAt)),
  );
  const unchecked = items.filter((i) => !i.checkedAt).length;
  if (unchecked)
    report.warn(
      `${unchecked} domain or certificate records have not been checked automatically yet. Their dates are as entered.`,
    );
  const domainItems = items.filter((i) => i.domain);
  const certificates = items.filter((i) => !i.domain);
  const count = (list: typeof items, clientId: string, state?: string) =>
    String(list.filter((i) => i.clientId === clientId && (!state || i.state === state)).length);
  report.section(
    'Summary',
    [
      'Client',
      'Domains',
      'Expired domains',
      'Expiring domains',
      'Certificates',
      'Expired certificates',
      'Expiring certificates',
      'Failed checks',
    ],
    report.clients.map((c) => [
      c.name,
      count(domainItems, c.id),
      count(domainItems, c.id, 'expired'),
      count(domainItems, c.id, 'soon'),
      count(certificates, c.id),
      count(certificates, c.id, 'expired'),
      count(certificates, c.id, 'soon'),
      String(items.filter((i) => i.clientId === c.id && i.check.startsWith('Failed')).length),
    ]),
  );
  // Soonest first; records without a date last.
  const bySoonest = (a: (typeof items)[number], b: (typeof items)[number]) =>
    (a.expires ?? '9999').localeCompare(b.expires ?? '9999') ||
    report.client(a.clientId).localeCompare(report.client(b.clientId)) ||
    a.name.localeCompare(b.name);
  report.section(
    'Domains',
    ['Client', 'Domain', 'Registrar', 'DNS host', 'Expires', 'Days left', 'Auto-renew', 'Status', 'Last check'],
    domainItems
      .sort(bySoonest)
      .map((i) => [
        report.client(i.clientId),
        i.name,
        text(i.fields.registrar),
        text(i.fields.dns_host),
        i.expires ?? 'Not recorded',
        i.daysLeft,
        i.fields.auto_renew === true ? 'Yes' : 'No',
        STATUS[i.state],
        i.check,
      ]),
  );
  report.section(
    'SSL certificates',
    ['Client', 'Certificate', 'Common name', 'Issuer', 'Installed on', 'Expires', 'Days left', 'Status', 'Last check'],
    certificates
      .sort(bySoonest)
      .map((i) => [
        report.client(i.clientId),
        i.name,
        text(i.fields.common_name),
        text(i.fields.issuer),
        text(i.fields.installed_on),
        i.expires ?? 'Not recorded',
        i.daysLeft,
        STATUS[i.state],
        i.check,
      ]),
  );
};
