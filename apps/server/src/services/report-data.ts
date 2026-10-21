import { eq } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { ReportDefinition, ReportKind, ReportSnapshot } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { requireClient } from '../authz.js';
import type { SettingsService } from './settings.js';
import type { Scope } from './scope.js';
import { MAX_REPORT_ROWS, ReportContext, type Collector, type SecuritySources } from './reports/context.js';
import { assets } from './reports/assets.js';
import { documentation } from './reports/documentation.js';
import { domains } from './reports/domains.js';
import { endpoints } from './reports/endpoints.js';
import { executive } from './reports/executive.js';
import { licenses } from './reports/licenses.js';
import { renewals } from './reports/renewals.js';
import { security } from './reports/security.js';
import { service } from './reports/service.js';
import { software } from './reports/software.js';

export { MAX_REPORT_ROWS, type SecuritySources };

/**
 * What each report type collects, one module each in `reports/`. Typed over every `ReportKind`, so a new report
 * type doesn't compile until it has a collector.
 */
const COLLECTORS: Record<ReportKind, Collector> = {
  executive,
  security,
  service,
  assets,
  licenses,
  renewals,
  domains,
  documentation,
  endpoints,
  software,
};

/** Export explicit metadata only: never include vault secrets, document content, or arbitrary custom fields. */
export async function collectReport(
  scope: Scope,
  definition: ReportDefinition,
  settings: SettingsService,
  fetcher?: typeof fetch,
  security?: SecuritySources,
): Promise<ReportSnapshot> {
  const clients = [];
  for (const id of definition.clientIds) {
    const { client } = await requireClient(scope.db, scope.actor, id, 'read');
    clients.push({ id: client.id, name: client.name });
  }
  clients.sort((a, b) => a.name.localeCompare(b.name));
  const [org] = await scope.db
    .select({ name: schema.orgs.name })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, scope.actor.orgId));
  const report = new ReportContext(scope, definition, clients, org!.name, settings, fetcher, security);
  await COLLECTORS[definition.kind](report);
  const snapshot = report.snapshot;
  if (
    snapshot.sections.reduce((n, s) => n + s.rows.length, 0) > MAX_REPORT_ROWS ||
    Buffer.byteLength(JSON.stringify(snapshot)) > 8 * 1024 * 1024
  )
    throw new HttpError(422, 'This report is too large. Choose fewer clients.');
  return snapshot;
}
