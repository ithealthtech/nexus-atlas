import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { HttpError } from '../../errors.js';
import type { ImportRun } from '../importers/common.js';
import type { StoredCwRmm } from '../settings.js';
import { ACCESS_DENIED, listOf, text, type CwRmmClient } from './cw-rmm.js';

type Json = Record<string, unknown>;
type Entity = 'endpoint' | 'client';

/** The ConnectWise custom field Atlas writes its links into, on devices and on companies. */
export const LINK_FIELD = 'Atlas link';
/** External refs of this source record which link was last written for each device and company. */
export const LINK_SOURCE = 'cw-link';
const DEFINITIONS = '/api/platform/v1/custom-field/definitions';
// The spec names entity types both ways: "endpoint"/"client" on definitions, "device"/"company" in its query.
const ENTITY_NAMES: Record<Entity, RegExp> = { endpoint: /^(endpoint|device)$/i, client: /^(client|company)$/i };
const MAX_NOTES = 5;

/** The Atlas page for a device's asset or a company's client. */
export function atlasUrl(publicUrl: string, entity: Entity, atlasId: string) {
  return `${publicUrl.replace(/\/+$/, '')}/${entity === 'endpoint' ? 'assets' : 'clients'}/${atlasId}`;
}

/**
 * Writes Atlas links into the "Atlas link" custom field, making the field once when ConnectWise has none. Devices
 * and companies may use separate clients, as their write permissions differ.
 */
export class CwLinkWriter {
  private readonly fields = new Map<Entity, Promise<string>>();
  private readonly clients: Record<Entity, CwRmmClient>;

  constructor(devices: CwRmmClient, companies: CwRmmClient = devices) {
    this.clients = { endpoint: devices, client: companies };
  }

  /** The ID of the "Atlas link" field for devices or companies. */
  field(entity: Entity): Promise<string> {
    let id = this.fields.get(entity);
    if (!id) {
      id = this.findOrCreate(entity);
      // A failure is tried again next time rather than remembered.
      id.catch(() => this.fields.delete(entity));
      this.fields.set(entity, id);
    }
    return id;
  }

  private async findOrCreate(entity: Entity) {
    const client = this.clients[entity];
    const existing = listOf(await client.get(DEFINITIONS)).find(
      (d) => ENTITY_NAMES[entity].test(text(d, 'entityType')) && text(d, 'name').toLowerCase() === LINK_FIELD.toLowerCase(),
    );
    if (existing && text(existing, 'id')) return text(existing, 'id');
    const created = await client.post(DEFINITIONS, {
      entityType: entity,
      name: LINK_FIELD,
      description: 'Opens this in Nexus Atlas, for its documentation and passwords.',
      attributeType: 'string',
      isEditable: false,
      helpText: 'Written by Nexus Atlas on each sync.',
    });
    const id = text((created ?? {}) as Json, 'id');
    if (!id) throw new HttpError(502, `ConnectWise didn't return the new "${LINK_FIELD}" custom field.`);
    return id;
  }

  async write(entity: Entity, id: string, url: string) {
    const attributeId = await this.field(entity);
    const path =
      entity === 'endpoint'
        ? `/api/platform/v2/device/endpoints/${encodeURIComponent(id)}/custom-fields`
        : `/api/platform/v1/company/companies/${encodeURIComponent(id)}/custom-fields`;
    await this.clients[entity].put(path, [{ entityId: id, attributeId, value: url }]);
  }
}

/** The ref kind for links under this address, so a changed PUBLIC_URL writes every link again. */
const kindFor = (entity: Entity, publicUrl: string) =>
  `${entity}:${createHash('sha256').update(publicUrl).digest('hex').slice(0, 12)}`;

/** Forgets which links were written, so turning the option back on writes them all again. */
export async function clearLinkRefs(db: Database, orgId: string) {
  await db
    .delete(schema.externalRefs)
    .where(and(eq(schema.externalRefs.orgId, orgId), eq(schema.externalRefs.source, LINK_SOURCE)));
}

/**
 * Writes the Atlas address of each linked company's client, and of each synced device's asset, into ConnectWise.
 * Only links that are new or changed since the last write are sent.
 */
export async function runLinkWriteBack(
  db: Database,
  orgId: string,
  writer: CwLinkWriter,
  run: ImportRun,
  map: StoredCwRmm['map'],
  publicUrl: string,
) {
  const r = schema.externalRefs;
  const linked = Object.entries(map).flatMap(([companyId, m]) =>
    m.action === 'link' ? [[companyId, m.clientId] as const] : [],
  );
  if (!linked.length) return;
  const devices = await db
    .select({ externalId: r.externalId, assetId: schema.assets.id })
    .from(r)
    .innerJoin(schema.assets, eq(schema.assets.id, r.entityId))
    .where(
      and(
        eq(r.orgId, orgId),
        eq(r.source, 'cw-rmm'),
        eq(r.kind, 'assets'),
        eq(schema.assets.archived, false),
        inArray(
          schema.assets.clientId,
          linked.map(([, clientId]) => clientId),
        ),
      ),
    );
  const kinds = { client: kindFor('client', publicUrl), endpoint: kindFor('endpoint', publicUrl) };
  // Links written under an earlier address are stale.
  await db
    .delete(r)
    .where(and(eq(r.orgId, orgId), eq(r.source, LINK_SOURCE), notInArray(r.kind, Object.values(kinds))));
  const written = new Map(
    (
      await db
        .select({ kind: r.kind, externalId: r.externalId, entityId: r.entityId })
        .from(r)
        .where(and(eq(r.orgId, orgId), eq(r.source, LINK_SOURCE)))
    ).map((w) => [`${w.kind}|${w.externalId}`, w.entityId]),
  );
  const targets: [Entity, string, string][] = [
    ...linked.map(([companyId, clientId]) => ['client', companyId, clientId] as [Entity, string, string]),
    ...devices.map((d) => ['endpoint', d.externalId, d.assetId] as [Entity, string, string]),
  ];
  let notes = 0;
  // Device and company fields may need different permissions, so a refusal stops only that kind.
  const denied = new Set<Entity>();
  for (const [entity, id, atlasId] of targets) {
    const kind = kinds[entity];
    if (denied.has(entity)) {
      run.count('atlasLinks', 'failed');
      continue;
    }
    if (written.get(`${kind}|${id}`) === atlasId) {
      run.count('atlasLinks', 'skipped');
      continue;
    }
    try {
      await writer.write(entity, id, atlasUrl(publicUrl, entity, atlasId));
    } catch (error) {
      run.count('atlasLinks', 'failed');
      const what = entity === 'endpoint' ? 'device' : 'company';
      const why = error instanceof HttpError ? error.message : 'could not be written.';
      // The key can't write these fields at all: every other write of them would fail the same way.
      if (error instanceof HttpError && error.code === ACCESS_DENIED) {
        denied.add(entity);
        run.note(`Atlas links not written to ConnectWise ${what}s: ${why}`);
        continue;
      }
      if (notes++ < MAX_NOTES) run.note(`Atlas link for ${what} ${id}: ${why}`);
      continue;
    }
    run.count('atlasLinks', written.has(`${kind}|${id}`) ? 'updated' : 'created');
    await db
      .insert(r)
      .values({ orgId, source: LINK_SOURCE, kind, externalId: id, entityId: atlasId })
      .onConflictDoUpdate({ target: [r.orgId, r.source, r.kind, r.externalId], set: { entityId: atlasId } });
  }
  if (notes > MAX_NOTES) run.note(`${notes - MAX_NOTES} more Atlas links could not be written.`);
}
