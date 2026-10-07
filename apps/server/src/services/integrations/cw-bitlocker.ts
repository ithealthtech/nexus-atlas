import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import type { AssetService } from '../assets.js';
import { bitlockerKeysIn, hasBitlockerKey, withoutBitlockerKeys, type FoundKey } from '../bitlocker-keys.js';
import type { ImportRun } from '../importers/common.js';
import { Scope } from '../scope.js';
import type { StoredCwRmm } from '../settings.js';
import type { VaultService } from '../vault.js';
import { ACCESS_DENIED, linkItems, listOf, type CwRmmClient } from './cw-rmm.js';

type Json = Record<string, unknown>;

/** The ref kind for recovery keys already saved to the vault: one per device and key, so a key is saved once. */
const KIND = 'bitlocker';
const LINK_NOTE = 'BitLocker recovery key (ConnectWise RMM)';
const MAX_NOTES = 5;
const CONCURRENCY = 4;

/** A device's custom fields as named text values. ConnectWise names the value differently between versions. */
function customFieldValues(body: unknown): { name: string; value: string }[] {
  return listOf(body).flatMap((f: Json) => {
    const name = String(f.name ?? f.attributeName ?? f.label ?? 'Custom field');
    // Every string the record carries is searched: only one of them is the value, and keys are found by shape.
    const value = Object.entries(f)
      .filter(([k, v]) => typeof v === 'string' && !/^(name|attributeName|label)$/i.test(k))
      .map(([, v]) => v as string)
      .join('\n');
    return value ? [{ name, value }] : [];
  });
}

/**
 * Reads each synced device's custom fields from ConnectWise RMM and saves any BitLocker recovery key it finds to
 * the client's vault, linked to the device's asset. A key is saved once: a device that gets a new key gets a new
 * entry and the old one stays, since the old key may still open an older backup or image. Keys found sitting in an
 * asset's own fields are moved to the vault too. Key values are never written to the job log.
 */
export async function runBitlockerSync(
  db: Database,
  actor: Actor,
  client: CwRmmClient,
  vault: VaultService,
  assets: AssetService,
  run: ImportRun,
  map: StoredCwRmm['map'],
) {
  const r = schema.externalRefs;
  const clientIds = Object.values(map).flatMap((m) => (m.action === 'link' ? [m.clientId] : []));
  if (!clientIds.length) return;
  const scope = new Scope(db, actor);
  const devices = await db
    .select({
      externalId: r.externalId,
      assetId: schema.assets.id,
      name: schema.assets.name,
      clientId: schema.assets.clientId,
      fields: schema.assets.fields,
    })
    .from(r)
    .innerJoin(schema.assets, eq(schema.assets.id, r.entityId))
    .where(
      and(
        eq(r.orgId, actor.orgId),
        eq(r.source, 'cw-rmm'),
        eq(r.kind, 'assets'),
        eq(schema.assets.archived, false),
        inArray(schema.assets.clientId, clientIds),
      ),
    );
  const saved = new Set(
    (
      await db
        .select({ externalId: r.externalId })
        .from(r)
        .where(and(eq(r.orgId, actor.orgId), eq(r.source, 'cw-rmm'), eq(r.kind, KIND)))
    ).map((x) => x.externalId),
  );

  let notes = 0;
  let refused: string | null = null;
  let moved = 0;
  const one = async (d: (typeof devices)[number]) => {
    let found: FoundKey[] = [];
    // Once ConnectWise has refused, it isn't asked again; the asset's own fields are still checked below.
    if (!refused)
      try {
        found = bitlockerKeysIn(
        customFieldValues(
          await client.get(`/api/platform/v2/device/endpoints/${encodeURIComponent(d.externalId)}/custom-fields`),
        ),
      );
    } catch (error) {
      const why = error instanceof HttpError ? error.message : 'could not be read.';
      // A key that can't read custom fields fails the same way for every device.
      if (error instanceof HttpError && error.code === ACCESS_DENIED) refused = why;
      else if (!(error instanceof HttpError && error.status === 404)) {
        run.count(KIND, 'failed');
        if (notes++ < MAX_NOTES) run.note(`BitLocker keys for ${d.name}: ${why}`);
      }
    }
    // Keys typed or imported into the asset's own fields don't belong there in plain text.
    const fields = d.fields as Record<string, unknown>;
    const inAsset = Object.entries(fields).filter(([, v]) => hasBitlockerKey(v)) as [string, string][];
    for (const [key, value] of inAsset)
      for (const k of bitlockerKeysIn([{ name: `asset field ${key}`, value }]))
        if (!found.some((f) => f.key === k.key)) found.push(k);

    let stored = true;
    for (const [i, k] of found.entries()) {
      const externalId = `${d.externalId}:${createHash('sha256').update(k.key).digest('hex').slice(0, 24)}`;
      if (saved.has(externalId)) {
        run.count(KIND, 'skipped');
        continue;
      }
      const name = `${d.name} · ${k.drive || (found.length > 1 ? `key ${i + 1}` : 'BitLocker')}`.slice(0, 200);
      const id = await run.upsert(KIND, externalId, name, async () => {
        const created = await vault.create(
          scope,
          d.clientId,
          {
            kind: 'bitlocker',
            name,
            username: k.keyId,
            secret: k.key,
            notes: `From ConnectWise RMM (${k.field}), ${new Date().toISOString().slice(0, 10)}.`,
          },
          'import',
        );
        return created.id;
      });
      if (!id) {
        stored = false;
        continue;
      }
      saved.add(externalId);
      await linkItems(db, actor.orgId, { type: 'asset', id: d.assetId }, { type: 'password', id }, LINK_NOTE);
    }
    // Only once every key is safely in the vault are the plain-text copies taken out of the asset.
    if (stored && inAsset.length) {
      const current = await assets.get(scope, d.assetId);
      const next: Record<string, unknown> = { ...current.fields };
      for (const [key] of inAsset) {
        const rest = typeof next[key] === 'string' ? withoutBitlockerKeys(next[key] as string) : null;
        if (rest) next[key] = rest;
        else delete next[key];
      }
      await assets.update(
        scope,
        d.assetId,
        { fields: next, version: current.version },
        'BitLocker key moved to the vault',
      );
      moved++;
    }
  };

  // A few at a time: ConnectWise rate-limits bursts.
  const queue = [...devices];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let d = queue.shift(); d; d = queue.shift()) await one(d);
    }),
  );
  if (refused) {
    run.count(KIND, 'failed');
    run.note(`BitLocker keys not read from ConnectWise device custom fields: ${refused}`);
  }
  if (notes > MAX_NOTES) run.note(`BitLocker keys could not be read for ${notes - MAX_NOTES} more devices.`);
  if (moved)
    run.note(
      `Moved BitLocker recovery keys out of ${moved} asset${moved === 1 ? "'s" : "s'"} fields into the vault. Earlier versions of those assets still show them in history.`,
    );
}
