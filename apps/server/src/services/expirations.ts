import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { ExpirationItem, LayoutField } from '@atlas/shared';
import type { Scope } from './scope.js';
import type { VaultService } from './vault.js';

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (date: string) =>
  Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / DAY);
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);

/**
 * Everything with a date coming up: asset fields marked "expires" (domains, certificates, licences, warranties),
 * password rotations, and document reviews. Only items the actor can see are included.
 */
export class ExpirationService {
  constructor(private readonly vault: VaultService) {}

  async list(scope: Scope, withinDays = 90): Promise<ExpirationItem[]> {
    const cutoff = new Date(Date.now() + withinDays * DAY).toISOString().slice(0, 10);
    const clientIds = await scope.readableClientIds();
    const items: ExpirationItem[] = [];

    // Only layouts with a date field marked "expires" matter, and the database compares those dates directly, so
    // the thousands of assets without one (or with a date far off) are never loaded.
    const expiring = clientIds.length
      ? (
          await scope.db
            .select({ id: schema.assetLayouts.id, fields: schema.assetLayouts.fields })
            .from(schema.assetLayouts)
            .where(eq(schema.assetLayouts.orgId, scope.actor.orgId))
        ).flatMap((l) =>
          (l.fields as LayoutField[])
            .filter((f) => f.expires && f.type === 'date')
            .map(
              (f) =>
                sql`(${schema.assets.layoutId} = ${l.id} and ${schema.assets.fields} ->> ${f.key} between '0000-01-01' and ${cutoff})`,
            ),
        )
      : [];
    if (expiring.length) {
      const rows = await scope.db
        .select({
          id: schema.assets.id,
          name: schema.assets.name,
          fields: schema.assets.fields,
          layoutName: schema.assetLayouts.name,
          layoutFields: schema.assetLayouts.fields,
          clientId: schema.assets.clientId,
          clientName: schema.clients.name,
        })
        .from(schema.assets)
        .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
        .innerJoin(schema.clients, eq(schema.clients.id, schema.assets.clientId))
        .where(
          and(
            eq(schema.assets.orgId, scope.actor.orgId),
            eq(schema.assets.archived, false),
            inArray(schema.assets.clientId, clientIds),
            or(...expiring),
          ),
        );
      for (const row of rows) {
        const values = (row.fields ?? {}) as Record<string, unknown>;
        for (const field of row.layoutFields as LayoutField[]) {
          if (!field.expires || field.type !== 'date') continue;
          const date = values[field.key];
          if (!isDate(date) || date > cutoff) continue;
          items.push({
            kind: 'asset',
            id: row.id,
            title: row.name,
            label: `${row.layoutName} · ${field.label}`,
            clientId: row.clientId,
            clientName: row.clientName,
            date,
            daysLeft: daysUntil(date),
          });
        }
      }
    }

    // Passwords: VaultService applies vault access and restriction lists.
    if (clientIds.length)
      for (const p of await this.vault.rotationDue(scope, withinDays))
        items.push({
          kind: 'password',
          id: p.id,
          title: p.name,
          label: 'Password rotation',
          clientId: p.clientId,
          clientName: p.clientName,
          date: p.rotationDue!,
          daysLeft: daysUntil(p.rotationDue!),
        });

    const docScope = [
      ...(clientIds.length ? [inArray(schema.documents.clientId, clientIds)] : []),
      ...(scope.canReadGlobal ? [isNull(schema.documents.clientId)] : []),
    ];
    if (docScope.length) {
      const docs = await scope.db
        .select({
          id: schema.documents.id,
          title: schema.documents.title,
          reviewDate: schema.documents.reviewDate,
          clientId: schema.documents.clientId,
          clientName: schema.clients.name,
        })
        .from(schema.documents)
        .leftJoin(schema.clients, eq(schema.clients.id, schema.documents.clientId))
        .where(
          and(
            eq(schema.documents.orgId, scope.actor.orgId),
            eq(schema.documents.archived, false),
            isNotNull(schema.documents.reviewDate),
            or(...docScope),
          ),
        );
      for (const d of docs)
        if (d.reviewDate && d.reviewDate <= cutoff)
          items.push({
            kind: 'document',
            id: d.id,
            title: d.title,
            label: 'Document review',
            clientId: d.clientId,
            clientName: d.clientName,
            date: d.reviewDate,
            daysLeft: daysUntil(d.reviewDate),
          });
    }

    return items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  }
}
