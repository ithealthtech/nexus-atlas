import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema } from '@atlas/db';
import type { PasswordHealthReport, ReportDefinition, ReportSnapshot, RotationTargetView } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import type { Scope } from '../scope.js';
import type { SettingsService } from '../settings.js';

export const MAX_REPORT_ROWS = 10_000;
export const DAY = 86_400_000;
export const iso = (value: Date | null) => value?.toISOString() ?? '';
/** A real calendar date written as YYYY-MM-DD. */
export const dateValue = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
/** RMM's online flag as the reports show it; unknown is never counted as healthy. */
export const onlineText = (online: boolean | null) => (online === null ? 'Unknown' : online ? 'Online' : 'Offline');
/** The newest of some timestamps, or null when there are none. */
export const newest = (values: (Date | null)[]) => values.map(iso).filter(Boolean).sort().at(-1) ?? null;
/** Refuses a source list longer than a report may hold. */
export function capped<T>(rows: T[], advice = 'Choose fewer clients (maximum 10,000 source rows per type).'): T[] {
  if (rows.length > MAX_REPORT_ROWS) throw new HttpError(422, `This report is too large. ${advice}`);
  return rows;
}

/** Where the security posture report reads passwords and rotation, with each service's own access rules. */
export interface SecuritySources {
  /** Only what this person may see in the vault (vault access and restricted items apply). */
  passwordHealth(scope: Scope): Promise<PasswordHealthReport>;
  /** Administrators only; anyone else gets an error and the report leaves rotation out. */
  rotationTargets(scope: Scope): Promise<RotationTargetView[]>;
}

/**
 * One report being collected: who asked, for which clients, and the snapshot being filled in. Report types share
 * the common source data (assets, documents, subscriptions, devices) through the loaders below, which run at most
 * once per report and note their source the first time.
 */
export class ReportContext {
  readonly db: Scope['db'];
  readonly actor: Scope['actor'];
  readonly names: Map<string, string>;
  readonly generatedAt: string;
  /** Today's date (UTC), YYYY-MM-DD. */
  readonly today: string;
  /** The end of the report's window (`withinDays` from today), YYYY-MM-DD. */
  readonly cutoff: string;
  readonly snapshot: ReportSnapshot;
  private readonly loaded = new Map<string, Promise<unknown>>();

  constructor(
    readonly scope: Scope,
    readonly definition: ReportDefinition,
    readonly clients: { id: string; name: string }[],
    organization: string,
    readonly settings: SettingsService,
    readonly fetcher?: typeof fetch,
    readonly security?: SecuritySources,
  ) {
    this.db = scope.db;
    this.actor = scope.actor;
    this.names = new Map(clients.map((c) => [c.id, c.name]));
    this.generatedAt = new Date().toISOString();
    this.today = this.generatedAt.slice(0, 10);
    this.cutoff = new Date(Date.parse(this.today) + definition.withinDays * DAY).toISOString().slice(0, 10);
    this.snapshot = {
      schemaVersion: 1,
      organization,
      definition,
      generatedAt: this.generatedAt,
      generatedBy: this.actor.name,
      clients,
      sources: [],
      warnings: [],
      sections: [],
    };
  }

  source(name: string, detail: string, updatedAt: string | null = this.generatedAt) {
    this.snapshot.sources.push({ name, detail, updatedAt });
  }
  warn(message: string) {
    this.snapshot.warnings.push(message);
  }
  section(title: string, columns: string[], rows: string[][]) {
    this.snapshot.sections.push({ title, columns, rows });
  }
  /** The client's name, for a row that belongs to one of the report's clients. */
  client(id: string | null) {
    return this.names.get(id!)!;
  }
  /** Rows of a table with orgId and clientId in this organization and the report's clients. */
  selected(table: { orgId: AnyPgColumn; clientId: AnyPgColumn }) {
    return and(eq(table.orgId, this.actor.orgId), inArray(table.clientId, this.definition.clientIds));
  }

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!this.loaded.has(key)) this.loaded.set(key, load());
    return this.loaded.get(key) as Promise<T>;
  }

  /** Current, non-archived assets with their layout. */
  assets() {
    return this.once('assets', async () => {
      const rows = capped(
        await this.db
          .select({
            clientId: schema.assets.clientId,
            name: schema.assets.name,
            status: schema.assets.status,
            updatedAt: schema.assets.updatedAt,
            fields: schema.assets.fields,
            layoutKey: schema.assetLayouts.key,
            layoutName: schema.assetLayouts.name,
            layoutFields: schema.assetLayouts.fields,
          })
          .from(schema.assets)
          .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
          .where(and(this.selected(schema.assets), eq(schema.assets.archived, false)))
          .orderBy(asc(schema.assets.name))
          .limit(MAX_REPORT_ROWS + 1),
      );
      this.source(
        'Atlas assets',
        this.definition.kind === 'assets' && this.definition.assetFields?.length
          ? 'Current non-archived asset records, with only the fields chosen for this report. Long text is never included.'
          : 'Current non-archived asset records. Custom field contents are excluded except configured expiration dates.',
      );
      return rows;
    });
  }

  /** Current, non-archived documentation metadata; never article bodies. */
  documents() {
    return this.once('documents', async () => {
      const rows = capped(
        await this.db
          .select({
            clientId: schema.documents.clientId,
            title: schema.documents.title,
            status: schema.documents.status,
            reviewDate: schema.documents.reviewDate,
            updatedAt: schema.documents.updatedAt,
          })
          .from(schema.documents)
          .where(
            and(
              eq(schema.documents.orgId, this.actor.orgId),
              inArray(schema.documents.clientId, this.definition.clientIds),
              eq(schema.documents.archived, false),
            ),
          )
          .orderBy(asc(schema.documents.title))
          .limit(MAX_REPORT_ROWS + 1),
      );
      this.source('Atlas documentation', 'Current non-archived article metadata. Article bodies are excluded.');
      return rows;
    });
  }

  /** Manually tracked subscriptions. */
  licenses() {
    return this.once('licenses', async () => {
      const rows = capped(
        await this.db
          .select({
            clientId: schema.licenses.clientId,
            name: schema.licenses.name,
            status: schema.licenses.status,
            seats: schema.licenses.seats,
            assignments: schema.licenses.assignments,
            unitCostCents: schema.licenses.unitCostCents,
            currency: schema.licenses.currency,
            billingCycle: schema.licenses.billingCycle,
            renewalDate: schema.licenses.renewalDate,
            autoRenew: schema.licenses.autoRenew,
          })
          .from(schema.licenses)
          .where(this.selected(schema.licenses))
          .orderBy(asc(schema.licenses.name))
          .limit(MAX_REPORT_ROWS + 1),
      );
      this.source(
        'Atlas subscriptions',
        'Manual tracking records. Costs are per billing period and currency; they are not Microsoft reseller billing.',
      );
      return rows;
    });
  }

  /** Each RMM device's last stored health, with a source per client and a notice for missing or stale data. */
  endpoints() {
    return this.once('endpoints', async () => {
      const rows = capped(
        await this.db
          .select({
            clientId: schema.rmmDeviceStatus.clientId,
            assetId: schema.rmmDeviceStatus.assetId,
            name: schema.assets.name,
            kind: schema.rmmDeviceStatus.kind,
            online: schema.rmmDeviceStatus.online,
            lastSeenAt: schema.rmmDeviceStatus.lastSeenAt,
            protection: schema.rmmDeviceStatus.protection,
            updatedAt: schema.rmmDeviceStatus.updatedAt,
          })
          .from(schema.rmmDeviceStatus)
          .innerJoin(schema.assets, eq(schema.assets.id, schema.rmmDeviceStatus.assetId))
          .where(
            and(
              eq(schema.rmmDeviceStatus.orgId, this.actor.orgId),
              inArray(schema.rmmDeviceStatus.clientId, this.definition.clientIds),
              eq(schema.assets.orgId, this.actor.orgId),
              eq(schema.assets.archived, false),
            ),
          )
          .orderBy(asc(schema.assets.name))
          .limit(MAX_REPORT_ROWS + 1),
      );
      for (const c of this.clients) {
        const mine = rows.filter((e) => e.clientId === c.id);
        const last = newest(mine.map((r) => r.updatedAt));
        this.source(`RMM: ${c.name}`, 'Last stored device health. Unknown status is not counted as healthy.', last);
        if (!last) this.warn(`${c.name}: no RMM device health data is available.`);
        else {
          const stale = mine.filter((row) => Date.parse(this.generatedAt) - row.updatedAt.getTime() > DAY).length;
          if (stale) this.warn(`${c.name}: ${stale} RMM device records are more than 24 hours old.`);
        }
      }
      return rows;
    });
  }
}

export type Collector = (report: ReportContext) => Promise<void>;
