import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { createApiKeySchema, type Actor, type ApiKeyScope, type ApiKeyView } from '@atlas/shared';
import { requireAdmin } from '../authz.js';
import { HttpError } from '../errors.js';
import { actorFor } from '../identity/service.js';
import { isUuid } from './scope.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const PREFIX_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Paths an API key may call (after /api/v1 is mapped to /api). Accounts, people, and settings stay browser-only. */
const API_ROUTES = [
  /^\/api\/clients(\/|$|\?)/,
  /^\/api\/(assets|documents|folders|contacts|locations|layouts|items|search|activity|passwords|expirations)(\/|$|\?)/,
];
const PASSWORD_ROUTE = /^\/api\/(passwords|clients\/[^/]+\/password(s|-folders))(\/|$|\?)/;

export interface KeyPrincipal {
  keyId: string;
  keyName: string;
  scopes: ApiKeyScope[];
  user: typeof schema.users.$inferSelect;
  actor: Actor;
}

/**
 * Scoped REST API keys. A key acts as the administrator who created it, limited by its scopes:
 * "read" for GET, "write" for changes, and "passwords" for anything in the vault.
 */
export class ApiKeyService {
  private readonly hits = new Map<string, { count: number; reset: number }>();

  constructor(
    private readonly db: Database,
    private readonly perMinute = 600,
  ) {}

  private view(row: typeof schema.apiKeys.$inferSelect, userName: string): ApiKeyView {
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes as ApiKeyScope[],
      userName,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: row.lastUsedIp,
      revoked: !!row.revokedAt,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(actor: Actor): Promise<ApiKeyView[]> {
    requireAdmin(actor);
    const rows = await this.db
      .select({ key: schema.apiKeys, userName: schema.users.name })
      .from(schema.apiKeys)
      .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.userId))
      .where(eq(schema.apiKeys.orgId, actor.orgId))
      .orderBy(desc(schema.apiKeys.createdAt));
    return rows.map((r) => this.view(r.key, r.userName));
  }

  async create(actor: Actor, input: unknown, ip: string): Promise<ApiKeyView & { token: string }> {
    requireAdmin(actor);
    const body = createApiKeySchema.parse(input);
    const prefix = Array.from(randomBytes(10), (b) => PREFIX_ALPHABET[b % PREFIX_ALPHABET.length]).join('');
    const token = `atlas_${prefix}_${randomBytes(32).toString('base64url')}`;
    const [row] = await this.db.transaction(async (tx) => {
      const created = await tx
        .insert(schema.apiKeys)
        .values({
          orgId: actor.orgId,
          userId: actor.id,
          name: body.name,
          prefix,
          secretHash: hash(token),
          scopes: [...new Set(body.scopes)],
          expiresAt: body.expiresDays ? new Date(Date.now() + body.expiresDays * 86_400_000) : null,
        })
        .returning();
      await tx.insert(schema.securityEvents).values({
        orgId: actor.orgId,
        userId: actor.id,
        actor: actor.name,
        action: 'API key created',
        detail: `${body.name} · ${body.scopes.join(', ')}`,
        ip,
      });
      return created;
    });
    return { ...this.view(row!, actor.name), token };
  }

  async revoke(actor: Actor, id: string, ip: string) {
    requireAdmin(actor);
    if (!isUuid(id)) throw new HttpError(404, 'API key not found.');
    const [row] = await this.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.orgId, actor.orgId), isNull(schema.apiKeys.revokedAt)))
      .returning();
    if (!row) throw new HttpError(404, 'API key not found.');
    await this.db.insert(schema.securityEvents).values({
      orgId: actor.orgId,
      userId: actor.id,
      actor: actor.name,
      action: 'API key revoked',
      detail: row.name,
      ip,
    });
  }

  /** Resolves a bearer token and checks it may call this method and path. */
  async authenticate(header: string | undefined, method: string, path: string, ip: string): Promise<KeyPrincipal> {
    const token = /^Bearer (atlas_[A-Za-z0-9]{10}_[A-Za-z0-9_-]{43})$/.exec(header ?? '')?.[1];
    if (!token) throw new HttpError(401, 'Send an API key as "Authorization: Bearer atlas_…".', 'api_key');
    const prefix = token.split('_')[1]!;
    const [row] = await this.db
      .select({ key: schema.apiKeys, user: schema.users })
      .from(schema.apiKeys)
      .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.userId))
      .where(eq(schema.apiKeys.prefix, prefix));
    const expected = Buffer.from(row?.key.secretHash ?? hash('none'));
    const matches = row && timingSafeEqual(expected, Buffer.from(hash(token)));
    if (
      !row ||
      !matches ||
      row.key.revokedAt ||
      (row.key.expiresAt && row.key.expiresAt.getTime() < Date.now()) ||
      row.user.disabled
    )
      throw new HttpError(401, 'This API key is not valid. It may have been revoked or expired.', 'api_key');

    const now = Date.now();
    const bucket = this.hits.get(row.key.id);
    if (!bucket || bucket.reset < now) this.hits.set(row.key.id, { count: 1, reset: now + 60_000 });
    else if (++bucket.count > this.perMinute)
      throw new HttpError(429, `Rate limit reached (${this.perMinute} requests a minute). Slow down and retry.`);

    const scopes = row.key.scopes as ApiKeyScope[];
    if (!API_ROUTES.some((r) => r.test(path)))
      throw new HttpError(403, 'This endpoint is not available to API keys.', 'api_scope');
    const needed: ApiKeyScope = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
    if (!scopes.includes(needed)) throw new HttpError(403, `This API key needs the "${needed}" scope.`, 'api_scope');
    if (PASSWORD_ROUTE.test(path) && !scopes.includes('passwords'))
      throw new HttpError(403, 'This API key needs the "passwords" scope.', 'api_scope');

    if (!row.key.lastUsedAt || now - row.key.lastUsedAt.getTime() > 60_000)
      await this.db
        .update(schema.apiKeys)
        .set({ lastUsedAt: new Date(now), lastUsedIp: ip.slice(0, 64) })
        .where(eq(schema.apiKeys.id, row.key.id));
    return { keyId: row.key.id, keyName: row.key.name, scopes, user: row.user, actor: actorFor(row.user) };
  }
}
