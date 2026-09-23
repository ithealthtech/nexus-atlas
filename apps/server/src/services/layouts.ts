import { isIP } from 'node:net';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  ROLE_INFO,
  layoutSchema,
  updateLayoutSchema,
  type Actor,
  type LayoutField,
  type LayoutView,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { BUILT_IN_LAYOUTS, withDefaults } from './layout-defaults.js';
import { isUuid } from './scope.js';

type LayoutRow = typeof schema.assetLayouts.$inferSelect;

/** Adds any missing built-in layouts for an organization (safe to run repeatedly). */
export async function ensureDefaultLayouts(db: Database, orgId: string) {
  await db
    .insert(schema.assetLayouts)
    .values(
      BUILT_IN_LAYOUTS.map((l, i) => ({
        orgId,
        key: l.key,
        name: l.name,
        icon: l.icon,
        description: l.description,
        fields: l.fields.map(withDefaults),
        builtIn: true,
        position: i,
      })),
    )
    .onConflictDoNothing();
}

const view = (row: LayoutRow, assetCount: number): LayoutView => ({
  id: row.id,
  key: row.key,
  name: row.name,
  icon: row.icon,
  description: row.description,
  fields: row.fields as LayoutField[],
  builtIn: row.builtIn,
  archived: row.archived,
  assetCount,
});

export class LayoutService {
  constructor(private readonly db: Database) {}

  async list(actor: Actor): Promise<LayoutView[]> {
    const rows = await this.db
      .select({ layout: schema.assetLayouts, assets: count(schema.assets.id) })
      .from(schema.assetLayouts)
      .leftJoin(
        schema.assets,
        and(eq(schema.assets.layoutId, schema.assetLayouts.id), eq(schema.assets.archived, false)),
      )
      .where(eq(schema.assetLayouts.orgId, actor.orgId))
      .groupBy(schema.assetLayouts.id)
      .orderBy(asc(schema.assetLayouts.position), asc(schema.assetLayouts.name));
    return rows.map((r) => view(r.layout, Number(r.assets)));
  }

  async get(actor: Actor, id: string): Promise<LayoutRow> {
    const [row] = isUuid(id)
      ? await this.db
          .select()
          .from(schema.assetLayouts)
          .where(and(eq(schema.assetLayouts.id, id), eq(schema.assetLayouts.orgId, actor.orgId)))
      : [];
    if (!row) throw new HttpError(404, 'Asset layout not found.');
    return row;
  }

  private requireAdmin(actor: Actor) {
    if (!ROLE_INFO[actor.role].admin) throw new HttpError(403, 'Only administrators can change asset layouts.');
  }

  async create(actor: Actor, input: unknown): Promise<LayoutView> {
    this.requireAdmin(actor);
    const body = layoutSchema.parse(input);
    const key = `${
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 30) || 'layout'
    }_${Date.now().toString(36)}`;
    const [{ max }] = (
      await this.db.execute(
        sql`select coalesce(max(position), 0)::int as max from asset_layouts where org_id = ${actor.orgId}`,
      )
    ).rows as [{ max: number }];
    const [row] = await this.db
      .insert(schema.assetLayouts)
      .values({
        orgId: actor.orgId,
        key,
        name: body.name,
        icon: body.icon,
        description: body.description,
        fields: body.fields,
        position: max + 1,
      })
      .returning();
    return view(row!, 0);
  }

  async update(actor: Actor, id: string, input: unknown): Promise<LayoutView> {
    this.requireAdmin(actor);
    const current = await this.get(actor, id);
    const body = updateLayoutSchema.parse(input);
    if (body.fields) layoutSchema.parse({ name: body.name ?? current.name, fields: body.fields });
    const [row] = await this.db
      .update(schema.assetLayouts)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.assetLayouts.id, id))
      .returning();
    const [counted] = await this.db
      .select({ value: count() })
      .from(schema.assets)
      .where(and(eq(schema.assets.layoutId, id), eq(schema.assets.archived, false)));
    return view(row!, Number(counted?.value ?? 0));
  }
}

const IP_OR_CIDR = (value: string) => {
  const [address, prefix, ...rest] = value.split('/');
  if (rest.length || !address) return false;
  const family = isIP(address);
  if (!family) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d{1,3}$/.test(prefix) && bits >= 0 && bits <= (family === 4 ? 32 : 128);
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks asset field values against the layout and returns a cleaned copy containing only the layout's fields. */
export function validateFields(fields: LayoutField[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = input[field.key];
    const empty =
      raw === undefined ||
      raw === null ||
      raw === '' ||
      (Array.isArray(raw) && raw.length === 0) ||
      (field.type === 'checkbox' && raw === false);
    if (empty) {
      if (field.required) errors[`fields.${field.key}`] = `${field.label} is required.`;
      continue;
    }
    const bad = (message: string) => {
      errors[`fields.${field.key}`] = message;
    };
    const text = typeof raw === 'string' ? raw.trim() : '';
    switch (field.type) {
      case 'text':
      case 'phone':
        if (typeof raw !== 'string' || text.length > (field.type === 'phone' ? 40 : 500))
          bad(`${field.label} is too long.`);
        else out[field.key] = text;
        break;
      case 'textarea':
        if (typeof raw !== 'string' || raw.length > 10000) bad(`${field.label} is too long.`);
        else out[field.key] = raw;
        break;
      case 'number': {
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' && text !== '' ? Number(text) : NaN;
        if (!Number.isFinite(n)) bad(`${field.label} must be a number.`);
        else out[field.key] = n;
        break;
      }
      case 'date':
        if (typeof raw !== 'string' || !DATE.test(text) || !new Date(text).toISOString().startsWith(text))
          bad(`${field.label} must be a valid date.`);
        else out[field.key] = text;
        break;
      case 'select':
        if (typeof raw !== 'string' || !field.options.includes(raw)) bad(`Choose a listed option for ${field.label}.`);
        else out[field.key] = raw;
        break;
      case 'multiselect':
        if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !field.options.includes(v)))
          bad(`Choose listed options for ${field.label}.`);
        else out[field.key] = [...new Set(raw)];
        break;
      case 'checkbox':
        if (raw !== true) bad(`${field.label} must be yes or no.`);
        else out[field.key] = true;
        break;
      case 'url':
        try {
          const url = new URL(text);
          if (!['http:', 'https:'].includes(url.protocol) || text.length > 2000) throw new Error();
          out[field.key] = text;
        } catch {
          bad(`${field.label} must be an http or https address.`);
        }
        break;
      case 'email':
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || text.length > 254)
          bad(`${field.label} must be an email address.`);
        else out[field.key] = text.toLowerCase();
        break;
      case 'ip':
        if (!IP_OR_CIDR(text)) bad(`${field.label} must be an IP address or subnet, such as 10.0.0.1 or 10.0.0.0/24.`);
        else out[field.key] = text;
        break;
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0]!, 'validation', errors);
  return out;
}
