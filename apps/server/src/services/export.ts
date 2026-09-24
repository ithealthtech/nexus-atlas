import { Readable } from 'node:stream';
import { and, eq, inArray, or } from 'drizzle-orm';
import { zipSync, strToU8 } from 'fflate';
import { schema, type Database } from '@atlas/db';
import type { Actor, ItemType } from '@atlas/shared';
import { requireClient } from '../authz.js';
import { AssetService } from './assets.js';
import { DocumentService } from './documents.js';
import { canSee, loadItem } from './items.js';
import { LayoutService } from './layouts.js';
import { contacts, locations } from './people.js';
import { Scope } from './scope.js';
import type { FileStorage } from './storage.js';
import type { VaultService } from './vault.js';
import { cleanRichText } from './richtext.js';

const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const safeName = (s: string) =>
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in zip entry names
  s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120) || 'untitled';

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * One client's documentation as a zip: client.json (everything, including relations), documents as Markdown-ish
 * text for reading without Atlas, and attachments. Decrypted passwords are included only when asked for,
 * by an administrator who has just confirmed their password (checked by the route).
 */
export async function exportClient(
  db: Database,
  actor: Actor,
  clientId: string,
  options: { passwords: boolean; ip: string; storage: FileStorage; vault: VaultService },
): Promise<{ filename: string; data: Uint8Array }> {
  const { client } = await requireClient(db, actor, clientId, 'read');
  const scope = new Scope(db, actor);
  const layouts = new LayoutService(db);
  const assets = new AssetService(layouts);
  const documents = new DocumentService();
  const [contactList, locationList, activeAssets, archivedAssets, docList, archivedDocs, passwordList] =
    await Promise.all([
      contacts.list(scope, clientId),
      locations.list(scope, clientId),
      assets.list(scope, { clientId }),
      assets.list(scope, { clientId, archived: true }),
      documents.list(scope, { clientId }),
      documents.list(scope, { clientId, archived: true }),
      (await scope.level(clientId)) === 'edit_passwords'
        ? options.vault.list(scope, { clientId })
        : Promise.resolve([]),
    ]);
  const fullDocs = await Promise.all([...docList, ...archivedDocs].map((d) => documents.get(scope, d.id)));
  const secrets = options.passwords ? await options.vault.exportSecrets(scope, clientId, options.ip) : [];
  const secretById = new Map(secrets.map((s) => [s.id, s]));
  const itemIds = [
    ...contactList,
    ...locationList,
    ...activeAssets,
    ...archivedAssets,
    ...fullDocs,
    ...passwordList,
  ].map((x) => x.id);
  // Links are stored in a fixed order, so this client's item can be either end. The other end can be outside the
  // client (a global knowledge-base article) or something this person can't open; it's kept only when they can.
  const itemSet = new Set(itemIds);
  const linked = itemIds.length
    ? await db
        .select()
        .from(schema.relations)
        .where(
          and(
            eq(schema.relations.orgId, actor.orgId),
            or(inArray(schema.relations.aId, itemIds), inArray(schema.relations.bId, itemIds)),
          ),
        )
    : [];
  const endpoint = async (type: string, id: string) => {
    if (itemSet.has(id)) return { type, id };
    const item = await loadItem(db, actor.orgId, type as ItemType, id);
    if (!item || !(await canSee(scope, { type: item.type, id, clientId: item.clientId }))) return null;
    return { type, id, title: item.title, external: true };
  };
  const relations = [];
  for (const r of linked) {
    const [a, b] = [await endpoint(r.aType, r.aId), await endpoint(r.bType, r.bId)];
    if (a && b) relations.push({ a, b, note: r.note });
  }
  const files = await db.select().from(schema.attachments).where(eq(schema.attachments.clientId, clientId));

  const entries: Record<string, Uint8Array> = {};
  const exportedAt = new Date().toISOString();
  const data = {
    format: 'msp-atlas-export',
    version: 1,
    exportedAt,
    exportedBy: actor.name,
    client: { id: client.id, name: client.name, type: client.type, status: client.status, notes: client.notes },
    contacts: contactList,
    locations: locationList,
    assets: [...activeAssets, ...archivedAssets],
    documents: fullDocs,
    passwords: passwordList.map((p) => ({
      ...p,
      ...(options.passwords
        ? {
            secret: secretById.get(p.id)?.secret ?? '',
            notesText: secretById.get(p.id)?.notes ?? '',
            totpKey: secretById.get(p.id)?.totp ?? '',
          }
        : {}),
    })),
    relations,
    attachments: files.map((f) => ({
      id: f.id,
      item: { type: f.entityType, id: f.entityId },
      filename: f.filename,
      contentType: f.contentType,
      size: f.size,
      sha256: f.sha256,
      path: `attachments/${f.id}-${safeName(f.filename)}`,
    })),
  };
  entries['client.json'] = strToU8(JSON.stringify(data, null, 2));
  for (const d of fullDocs)
    entries[`documents/${safeName(d.title)}-${d.id.slice(0, 8)}.txt`] = strToU8(
      `${d.title}\n${'='.repeat(Math.min(d.title.length, 80))}\n\n${cleanRichText(d.content).text}\n`,
    );
  let total = 0;
  for (const f of files) {
    if (total + f.size > MAX_ATTACHMENT_BYTES) continue;
    try {
      entries[`attachments/${f.id}-${safeName(f.filename)}`] = await readAll(await options.storage.get(f.storageKey));
      total += f.size;
    } catch {
      /* A missing file is listed in client.json but left out of the zip. */
    }
  }
  entries['README.txt'] = strToU8(
    `MSP Atlas export of ${client.name}\nExported ${exportedAt} by ${actor.name}.\n\n` +
      (options.passwords
        ? 'WARNING: this file contains decrypted passwords. Store it encrypted and delete it when done.\n'
        : 'Passwords are listed without their secrets.\n'),
  );
  await db.insert(schema.securityEvents).values({
    orgId: actor.orgId,
    userId: actor.id,
    actor: actor.name,
    action: options.passwords ? 'Client exported with passwords' : 'Client exported',
    detail: client.name,
    ip: options.ip,
  });
  const date = exportedAt.slice(0, 10);
  return {
    filename: `atlas-${safeName(client.name).replace(/\s+/g, '-')}-${date}.zip`,
    data: zipSync(entries, { level: 6 }),
  };
}
