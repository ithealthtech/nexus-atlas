import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import { teamsSettingsSchema, type TeamsSettings, type TeamsSettingsView } from '@atlas/shared';
import { open, seal, type KeyProvider } from '../../crypto/keys.js';
import { HttpError } from '../../errors.js';

export interface TeamsConnection {
  oid: string;
  name: string;
  connectedAt: string;
  refreshSealed: string;
}
export interface StoredTeams extends TeamsSettings {
  generation: string;
  ownerId: string;
  secretSealed: string | null;
  connection: TeamsConnection | null;
}
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const aad = (orgId: string, field: string) => `org|${orgId}|teams|${field}`;

export class TeamsSettingsStore {
  constructor(
    readonly db: Database,
    private readonly keys: KeyProvider,
  ) {}

  async load(orgId: string, tx: Database | Tx = this.db): Promise<StoredTeams | null> {
    const [row] = await tx
      .select({ value: sql<StoredTeams | null>`${schema.orgs.settings}->'teams'` })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId));
    return row?.value ?? null;
  }
  private async put(orgId: string, saved: StoredTeams, tx: Database | Tx = this.db) {
    await tx
      .update(schema.orgs)
      .set({ settings: sql`${schema.orgs.settings} || jsonb_build_object('teams', ${JSON.stringify(saved)}::jsonb)` })
      .where(eq(schema.orgs.id, orgId));
  }
  async view(orgId: string): Promise<TeamsSettingsView> {
    const saved = await this.load(orgId);
    const settings = teamsSettingsSchema.parse(saved ?? {});
    return {
      ...settings,
      hasClientSecret: !!saved?.secretSealed,
      connection: saved?.connection ? { name: saved.connection.name, connectedAt: saved.connection.connectedAt } : null,
    };
  }
  secret(orgId: string, saved: StoredTeams) {
    if (!saved.secretSealed) throw new HttpError(409, 'Save the Teams application secret first.');
    return open(this.keys, saved.secretSealed, aad(orgId, 'secret'));
  }
  async save(orgId: string, ownerId: string, input: unknown) {
    const { clientSecret, ...body } = teamsSettingsSchema.parse(input);
    await this.db.transaction(async (tx) => {
      await tx.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).for('update');
      const current = await this.load(orgId, tx);
      const changed = current?.appId !== body.appId || current?.tenantId !== body.tenantId;
      const secretSealed =
        clientSecret === undefined
          ? changed
            ? null
            : (current?.secretSealed ?? null)
          : clientSecret === ''
            ? null
            : seal(this.keys, clientSecret, aad(orgId, 'secret'));
      if (body.enabled && !secretSealed)
        throw new HttpError(400, 'Enter the application secret before enabling Teams.');
      await this.put(
        orgId,
        {
          ...body,
          reminderDays: [...new Set(body.reminderDays)].sort((a, b) => b - a),
          ownerId,
          generation: randomUUID(),
          secretSealed,
          connection: changed || clientSecret !== undefined ? null : (current?.connection ?? null),
        },
        tx,
      );
    });
    return this.view(orgId);
  }
  async connect(orgId: string, expected: string, connection: Omit<TeamsConnection, 'refreshSealed'>, refresh: string) {
    await this.db.transaction(async (tx) => {
      await tx.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).for('update');
      const saved = await this.load(orgId, tx);
      if (!saved || saved.generation !== expected)
        throw new HttpError(409, 'The Teams configuration changed. Connect again.');
      await this.put(
        orgId,
        {
          ...saved,
          generation: randomUUID(),
          connection: {
            ...connection,
            refreshSealed: seal(this.keys, refresh, aad(orgId, 'refresh')),
          },
        },
        tx,
      );
    });
  }
  async disconnect(orgId: string) {
    await this.db.transaction(async (tx) => {
      await tx.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).for('update');
      const saved = await this.load(orgId, tx);
      if (saved) await this.put(orgId, { ...saved, enabled: false, connection: null, generation: randomUUID() }, tx);
    });
  }
  /** The row lock also serializes refresh-token rotation between Atlas processes. */
  async delegatedToken(orgId: string, fetcher: typeof fetch): Promise<string> {
    return this.db.transaction(async (tx) => {
      await tx.select({ id: schema.orgs.id }).from(schema.orgs).where(eq(schema.orgs.id, orgId)).for('update');
      const saved = await this.load(orgId, tx);
      if (!saved?.enabled || !saved.connection)
        throw new HttpError(409, 'Connect a Microsoft account in Teams settings.');
      let res: Response;
      try {
        res = await fetcher(`https://login.microsoftonline.com/${saved.tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: saved.appId!,
            client_secret: this.secret(orgId, saved),
            refresh_token: open(this.keys, saved.connection.refreshSealed, aad(orgId, 'refresh')),
            scope: 'https://graph.microsoft.com/.default',
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new HttpError(502, 'Microsoft sign-in could not be reached.');
      }
      if (res.status === 429) throw new HttpError(429, 'Microsoft is busy. Try again shortly.');
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string };
      if (!res.ok || typeof body.access_token !== 'string' || !body.access_token)
        throw new HttpError(409, 'Microsoft refused Teams access. Reconnect the account.');
      if (typeof body.refresh_token === 'string' && body.refresh_token)
        await this.put(
          orgId,
          {
            ...saved,
            connection: {
              ...saved.connection,
              refreshSealed: seal(this.keys, body.refresh_token, aad(orgId, 'refresh')),
            },
          },
          tx,
        );
      return body.access_token;
    });
  }
  async rewrap(orgId: string): Promise<number> {
    const saved = await this.load(orgId);
    if (!saved) return 0;
    let count = 0;
    const rewrap = (value: string | null, field: string) => {
      if (!value) return null;
      count++;
      return seal(this.keys, open(this.keys, value, aad(orgId, field)), aad(orgId, field));
    };
    await this.put(orgId, {
      ...saved,
      secretSealed: rewrap(saved.secretSealed, 'secret'),
      connection: saved.connection
        ? { ...saved.connection, refreshSealed: rewrap(saved.connection.refreshSealed, 'refresh')! }
        : null,
    });
    return count;
  }
}
