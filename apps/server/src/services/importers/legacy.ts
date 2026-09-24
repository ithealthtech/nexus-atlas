import { createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor, ItemType, RichText } from '@atlas/shared';
import { seal, type KeyProvider } from '../../crypto/keys.js';
import { AssetService } from '../assets.js';
import { ClientService } from '../clients.js';
import { DocumentService } from '../documents.js';
import { LayoutService } from '../layouts.js';
import { contacts } from '../people.js';
import { RelationService } from '../relations.js';
import { Scope } from '../scope.js';
import { HttpError } from '../../errors.js';
import { ImportRun } from './common.js';

type LegacyClient = { id: string; name: string; industry: string; contact: string; email: string };
type LegacyRecord = {
  id: string;
  client_id: string;
  kind: 'asset' | 'document';
  title: string;
  category: string;
  content: string;
  status: string;
  address: string;
  review_date: string;
};
type LegacyUser = {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'technician' | 'client';
  all_clients: number;
  password_hash: string;
  must_change_password: number;
  mfa_secret: string | null;
  disabled: number;
};

/** 0.2 stored documents as plain text with "# " headings; turn that into editor paragraphs and headings. */
export function legacyTextToDoc(text: string): RichText {
  const content = text.split(/\n{2,}/).flatMap((block) => {
    const lines = block.split('\n');
    const out: unknown[] = [];
    let para: string[] = [];
    const flush = () => {
      if (para.length) {
        out.push({
          type: 'paragraph',
          content: para.flatMap((line, i) => [
            ...(i ? [{ type: 'hardBreak' }] : []),
            ...(line ? [{ type: 'text', text: line }] : []),
          ]),
        });
        para = [];
      }
    };
    for (const line of lines) {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        if (heading[2])
          out.push({
            type: 'heading',
            attrs: { level: heading[1]!.length + 1 },
            content: [{ type: 'text', text: heading[2] }],
          });
      } else para.push(line);
    }
    flush();
    return out;
  });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Opens a 0.2 "v1:" MFA secret with the old key file's key. */
function openLegacySecret(sealed: string, key: Buffer): string | null {
  try {
    const [v, iv, tag, body] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || !body) return null;
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Migrates an Atlas 0.2 SQLite database into this organization: users (password hashes carry over; MFA carries
 * over when the old key file is given, otherwise those people set it up again), clients with their contact,
 * records as assets and documents, and links. Revisions and activity history stay in the old file.
 */
export async function migrateLegacy(
  db: Database,
  actor: Actor,
  keys: KeyProvider,
  options: { file: string; legacyKey?: Buffer; workspace?: string },
): Promise<ImportRun> {
  const legacy = new DatabaseSync(options.file, { readOnly: true });
  let workspace: string;
  try {
    workspace = chooseWorkspace(legacy, options.workspace);
  } catch (error) {
    legacy.close();
    throw error;
  }
  const run = await ImportRun.start(db, actor, 'legacy');
  try {
    const scope = new Scope(db, actor);
    const clientService = new ClientService(db);
    const layouts = new LayoutService(db);
    const assets = new AssetService(layouts);
    const documents = new DocumentService();
    const relations = new RelationService();
    // 0.2 assets were devices and services; they become Configurations, with the address as the IP field.
    const configLayout = (await layouts.list(actor)).find((l) => l.key === 'configuration');
    if (!configLayout) throw new Error('The built-in Configurations layout is missing. Finish Atlas setup first.');

    const clientIds = new Map<string, string>();
    for (const c of legacy
      .prepare('SELECT * FROM clients WHERE msp_id = ? ORDER BY name')
      .all(workspace) as LegacyClient[]) {
      const body = { name: c.name, type: 'Customer', notes: c.industry ? `Industry: ${c.industry}` : '' };
      const id = await run.upsert(
        'clients',
        c.id,
        c.name,
        async () => (await clientService.create(actor, body)).id,
        async (existing) => void (await clientService.update(actor, existing, body)),
      );
      if (!id) continue;
      clientIds.set(c.id, id);
      if (c.contact)
        await run.upsert(
          'contacts',
          c.id,
          c.contact,
          async () => (await contacts.create(scope, id, { name: c.contact, email: c.email || '', primary: true })).id,
        );
    }

    const itemIds = new Map<string, { type: ItemType; id: string }>();
    for (const r of legacy.prepare('SELECT * FROM records ORDER BY title').all() as LegacyRecord[]) {
      const clientId = clientIds.get(r.client_id);
      if (!clientId) continue;
      if (r.kind === 'asset') {
        const notes = [r.category && `Category: ${r.category}`, r.content].filter(Boolean).join('\n\n');
        const fields = r.address ? { ip_address: r.address } : {};
        const body = { layoutId: configLayout.id, name: r.title, notes, fields, status: 'active' };
        const id = await run.upsert(
          'assets',
          r.id,
          r.title,
          async () =>
            (
              await assets
                .create(scope, clientId, body)
                .catch(() =>
                  assets.create(scope, clientId, { ...body, fields: {}, notes: `${notes}\n\nAddress: ${r.address}` }),
                )
            ).id,
        );
        if (id) itemIds.set(r.id, { type: 'asset', id });
      } else {
        const status = r.status === 'Needs review' ? 'needs_review' : r.status === 'Draft' ? 'draft' : 'current';
        const body = {
          title: r.title,
          content: legacyTextToDoc(r.content),
          status,
          reviewDate: /^\d{4}-\d{2}-\d{2}$/.test(r.review_date) ? r.review_date : null,
          clientId,
        };
        const id = await run.upsert('documents', r.id, r.title, async () => (await documents.create(scope, body)).id);
        if (id) itemIds.set(r.id, { type: 'document', id });
      }
    }

    for (const rel of legacy.prepare('SELECT * FROM relationships').all() as {
      source_id: string;
      target_id: string;
    }[]) {
      const a = itemIds.get(rel.source_id);
      const b = itemIds.get(rel.target_id);
      if (!a || !b) continue;
      await run.upsert(
        'links',
        `${rel.source_id}:${rel.target_id}`,
        `${rel.source_id} → ${rel.target_id}`,
        async () => {
          await relations.add(scope, a.type, a.id, { type: b.type, id: b.id }).catch((error) => {
            // A link already made in the other direction is fine.
            if (!(error && typeof error === 'object' && 'status' in error && error.status === 409)) throw error;
          });
          return a.id;
        },
      );
    }

    const hasUsers = hasTable(legacy, 'users');
    if (hasUsers) {
      const grants = legacy.prepare('SELECT user_id, client_id FROM user_clients').all() as {
        user_id: string;
        client_id: string;
      }[];
      for (const u of legacy
        .prepare('SELECT * FROM users WHERE msp_id = ? ORDER BY created_at')
        .all(workspace) as LegacyUser[]) {
        const email = u.email.trim().toLowerCase();
        const [existing] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email));
        if (existing) {
          run.count('users', 'skipped');
          run.note(`user ${email}: an account with this email already exists.`);
          continue;
        }
        const role = u.role === 'admin' ? 'admin' : u.role === 'technician' ? 'technician' : 'client_viewer';
        const secret = u.mfa_secret && options.legacyKey ? openLegacySecret(u.mfa_secret, options.legacyKey) : null;
        if (u.mfa_secret && !secret) run.note(`user ${email}: sets up two-step verification again at next sign-in.`);
        await run.upsert('users', u.id, email, async () => {
          const [created] = await db
            .insert(schema.users)
            .values({
              orgId: actor.orgId,
              email,
              name: u.name,
              role,
              allClients:
                role === 'technician' && u.all_clients
                  ? 'edit_passwords'
                  : role === 'admin'
                    ? 'edit_passwords'
                    : 'none',
              passwordHash: u.password_hash,
              mustChangePassword: !!u.must_change_password,
              disabled: !!u.disabled,
            })
            .returning({ id: schema.users.id });
          const id = created!.id;
          if (secret)
            await db
              .update(schema.users)
              .set({ mfaSecret: seal(keys, secret, `user|${id}|mfa`) })
              .where(eq(schema.users.id, id));
          const own = grants.filter((g) => g.user_id === u.id && clientIds.has(g.client_id));
          if (role !== 'admin' && own.length)
            await db.insert(schema.clientAccess).values(
              own.map((g) => ({
                userId: id,
                clientId: clientIds.get(g.client_id)!,
                level: role === 'technician' ? 'edit_passwords' : 'read',
              })),
            );
          return id;
        });
      }
    }
    const revisions = (legacy.prepare('SELECT COUNT(*) AS n FROM revisions').get() as { n: number }).n;
    if (revisions) run.note(`${revisions} older revisions stay in the 0.2 file; each record starts at version 1 here.`);
    await run.flush('done');
    return run;
  } catch (error) {
    run.note(error instanceof Error ? error.message : 'The migration stopped unexpectedly.');
    await run.flush('failed');
    throw error;
  } finally {
    legacy.close();
  }
}

const hasTable = (legacy: DatabaseSync, name: string) =>
  !!legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * 0.2 kept every workspace (msp_id) in one file. Only one is migrated per run: the one named, or the only one
 * with user accounts (or, without accounts, the only one with clients). Anything else must be named explicitly.
 */
function chooseWorkspace(legacy: DatabaseSync, requested?: string): string {
  const counts = new Map<string, { clients: number; users: number }>();
  const tally = (table: 'clients' | 'users', key: 'clients' | 'users') => {
    for (const row of legacy.prepare(`SELECT msp_id AS id, COUNT(*) AS n FROM ${table} GROUP BY msp_id`).all() as {
      id: string;
      n: number;
    }[]) {
      const entry = counts.get(row.id) ?? { clients: 0, users: 0 };
      entry[key] = row.n;
      counts.set(row.id, entry);
    }
  };
  tally('clients', 'clients');
  if (hasTable(legacy, 'users')) tally('users', 'users');
  const list = () => [...counts].map(([id, c]) => `${id} (${c.clients} clients, ${c.users} users)`).join(', ');
  if (requested) {
    if (!counts.has(requested))
      throw new HttpError(400, `No workspace "${requested}" in this file. It has: ${list()}.`);
    return requested;
  }
  const withUsers = [...counts].filter(([, c]) => c.users > 0).map(([id]) => id);
  const candidates = withUsers.length ? withUsers : [...counts].filter(([, c]) => c.clients > 0).map(([id]) => id);
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) throw new HttpError(400, 'This file has no clients or accounts to migrate.');
  throw new HttpError(400, `This file has several workspaces; choose one with --workspace: ${list()}.`);
}
