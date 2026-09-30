import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { HttpError } from '../../errors.js';
import type { ImportRun } from '../importers/common.js';
import type { StoredCwRmm } from '../settings.js';
import { ACCESS_DENIED, listOf, text, type CwRmmClient } from './cw-rmm.js';

type Entity = 'endpoint' | 'client';

/** The ConnectWise device custom field Atlas writes its links into. */
export const LINK_FIELD = 'Atlas link';
/** External refs of this source record which link was last written for each device. */
export const LINK_SOURCE = 'cw-link';
/** The code of the error when ConnectWise has no "Atlas link" device field yet. */
const NO_FIELD = 'NO_LINK_FIELD';
const MAX_NOTES = 5;

/** The Atlas page for a device's asset or a company's client. */
export function atlasUrl(publicUrl: string, entity: Entity, atlasId: string) {
  return `${publicUrl.replace(/\/+$/, '')}/${entity === 'endpoint' ? 'assets' : 'clients'}/${atlasId}`;
}

const fieldsPath = (endpointId: string) =>
  `/api/platform/v2/device/endpoints/${encodeURIComponent(endpointId)}/custom-fields`;

/**
 * Writes Atlas links into the devices' "Atlas link" custom field, through the v2 platform API only. v2 can't make a
 * field, so the field is found by name among a device's custom fields; companies have no v2 custom field API.
 */
export class CwLinkWriter {
  private field: Promise<string> | null = null;

  constructor(private readonly client: CwRmmClient) {}

  /** The ID of the "Atlas link" device field, read from a device's custom fields (defaults included). */
  private fieldId(endpointId: string): Promise<string> {
    if (!this.field) {
      this.field = this.find(endpointId);
      // A failure is tried again next time rather than remembered.
      this.field.catch(() => (this.field = null));
    }
    return this.field;
  }

  private async find(endpointId: string) {
    const values = listOf(await this.client.get(`${fieldsPath(endpointId)}?withDefaults=true`));
    const found = values.find((v) => text(v, 'name').toLowerCase() === LINK_FIELD.toLowerCase());
    const id = found ? text(found, 'attributeId', 'attributeID') : '';
    if (!id)
      throw new HttpError(
        404,
        `ConnectWise has no device custom field named "${LINK_FIELD}". Add a text custom field with that name for devices in ConnectWise; Atlas fills it on the next sync.`,
        NO_FIELD,
      );
    return id;
  }

  async write(endpointId: string, url: string) {
    const attributeId = await this.fieldId(endpointId);
    await this.client.put(fieldsPath(endpointId), [{ entityId: endpointId, attributeId, value: url }]);
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
 * Writes the Atlas address of each synced device's asset into ConnectWise. Only links that are new or changed since
 * the last write are sent.
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
  const kinds = { endpoint: kindFor('endpoint', publicUrl) };
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
  const kind = kinds.endpoint;
  let notes = 0;
  for (const d of devices) {
    const [id, atlasId] = [d.externalId, d.assetId];
    if (written.get(`${kind}|${id}`) === atlasId) {
      run.count('atlasLinks', 'skipped');
      continue;
    }
    try {
      await writer.write(id, atlasUrl(publicUrl, 'endpoint', atlasId));
    } catch (error) {
      const why = error instanceof HttpError ? error.message : 'could not be written.';
      // No field, or a key that can't write fields: every other device would fail the same way.
      if (error instanceof HttpError && (error.code === ACCESS_DENIED || error.code === NO_FIELD)) {
        run.count('atlasLinks', 'failed');
        run.note(`Atlas links not written to ConnectWise devices: ${why}`);
        return;
      }
      run.count('atlasLinks', 'failed');
      if (notes++ < MAX_NOTES) run.note(`Atlas link for device ${id}: ${why}`);
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
