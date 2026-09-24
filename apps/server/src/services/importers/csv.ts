import { eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  contactSchema,
  createClientSchema,
  createPasswordSchema,
  csvImportSchema,
  locationSchema,
  type Actor,
  type CsvImportResult,
} from '@atlas/shared';
import { requireAllClientsEdit } from '../../authz.js';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import { ClientService } from '../clients.js';
import { LayoutService, validateFields } from '../layouts.js';
import { contacts, locations } from '../people.js';
import { Scope } from '../scope.js';
import type { VaultService } from '../vault.js';

const messageOf = (error: unknown) =>
  error instanceof HttpError
    ? error.fields
      ? Object.values(error.fields)[0]!
      : error.message
    : error && typeof error === 'object' && 'issues' in error
      ? `${(error as { issues: { path: PropertyKey[]; message: string }[] }).issues[0]?.path.join('.')}: ${(error as { issues: { message: string }[] }).issues[0]?.message}`
      : 'Unexpected error.';

/**
 * Imports rows the browser has already mapped to Atlas fields. Rows name their client by name; clients are
 * matched by name (case-insensitive), so importing the same sheet twice updates clients rather than duplicating them.
 * With dryRun, every row is validated and nothing is written.
 */
export async function importCsv(
  db: Database,
  actor: Actor,
  input: unknown,
  vault: VaultService,
): Promise<CsvImportResult> {
  const body = csvImportSchema.parse(input);
  const scope = new Scope(db, actor);
  const clientService = new ClientService(db);
  const layouts = new LayoutService(db);
  const assets = new AssetService(layouts);
  const result: CsvImportResult = { created: 0, updated: 0, errors: [] };

  const clientRows = await db
    .select({ id: schema.clients.id, name: schema.clients.name })
    .from(schema.clients)
    .where(eq(schema.clients.orgId, actor.orgId));
  const byName = new Map(clientRows.map((c) => [c.name.trim().toLowerCase(), c.id]));
  const clientFor = (row: Record<string, string>) => {
    const name = (row.client ?? '').trim();
    if (!name) throw new HttpError(400, 'The client column is empty.');
    const id = byName.get(name.toLowerCase());
    if (!id) throw new HttpError(400, `No client named "${name}". Import clients first, or fix the name.`);
    return id;
  };
  const layout = body.target === 'assets' ? await layouts.get(actor, body.layoutId ?? '') : null;
  if (body.target === 'assets' && !layout) throw new HttpError(400, 'Choose the asset layout these rows use.');
  if (body.target === 'clients') requireAllClientsEdit(actor);

  for (const [index, row] of body.rows.entries()) {
    const rowNumber = index + 2; // Spreadsheet row, counting the header.
    try {
      const { client: _client, ...rest } = row;
      switch (body.target) {
        case 'clients': {
          const parsed = createClientSchema.parse({ ...rest, status: rest.status?.toLowerCase() || undefined });
          const existing = byName.get(parsed.name.toLowerCase());
          if (body.dryRun) break;
          if (existing) {
            // Only the columns in the file change; settings the file can't carry (such as requiring a
            // reason to reveal passwords) and empty cells keep their current values.
            const patch = Object.fromEntries(
              (['type', 'status', 'notes'] as const).filter((k) => rest[k]?.trim()).map((k) => [k, parsed[k]]),
            );
            if (Object.keys(patch).length) await clientService.update(actor, existing, patch);
            result.updated++;
          } else {
            const created = await clientService.create(actor, parsed);
            byName.set(parsed.name.toLowerCase(), created.id);
            result.created++;
          }
          break;
        }
        case 'contacts':
        case 'locations': {
          const clientId = clientFor(row);
          const values = { ...rest, primary: /^(true|yes|1)$/i.test(rest.primary ?? '') };
          (body.target === 'contacts' ? contactSchema : locationSchema).parse(values);
          if (body.dryRun) break;
          await (body.target === 'contacts' ? contacts : locations).create(scope, clientId, values);
          result.created++;
          break;
        }
        case 'assets': {
          const clientId = clientFor(row);
          const { name = '', notes = '', status, ...fieldValues } = rest;
          if (!name.trim()) throw new HttpError(400, 'The name column is empty.');
          validateFields(layout!.fields as never, fieldValues);
          if (body.dryRun) break;
          await assets.create(scope, clientId, {
            layoutId: layout!.id,
            name,
            notes,
            ...(status ? { status: status.toLowerCase() } : {}),
            fields: fieldValues,
          });
          result.created++;
          break;
        }
        case 'passwords': {
          const clientId = clientFor(row);
          const values = {
            name: rest.name,
            username: rest.username,
            url: rest.url,
            secret: rest.password,
            notes: rest.notes,
            totp: rest.totp,
          };
          const parsed = createPasswordSchema.parse(values);
          if (body.dryRun) {
            const level = await scope.level(clientId);
            if (level !== 'edit_passwords') throw new HttpError(403, 'You don’t have password access for this client.');
            break;
          }
          await vault.create(scope, clientId, parsed, 'csv import');
          result.created++;
          break;
        }
      }
    } catch (error) {
      result.errors.push({ row: rowNumber, message: messageOf(error) });
      if (result.errors.length >= 200) break;
    }
  }
  if (!body.dryRun && (result.created || result.updated))
    await db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'CSV import',
      detail: `${body.target}: ${result.created} created, ${result.updated} updated, ${result.errors.length} errors`,
      ip: '',
    });
  return result;
}
