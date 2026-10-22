import { and, eq, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  bitdefenderHealth,
  bitdefenderSyncOptionsSchema,
  type Actor,
  type BitdefenderClientView,
  type BitdefenderEndpointView,
  type BitdefenderHealth,
  type BitdefenderLicence,
  type LayoutField,
} from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import type { ImportRun } from '../importers/common.js';
import { LayoutService } from '../layouts.js';
import { Scope } from '../scope.js';
import type { StoredBitdefender } from '../settings.js';
import { deviceLayout, fitFields } from './cw-rmm.js';

type Json = Record<string, unknown>;
type Connection = Pick<StoredBitdefender, 'accessUrl' | 'auth'> & { apiKey: string };

/** GravityZone allows 10 requests a second per key; Atlas stays under it. */
const MIN_GAP_MS = 125;
const MAX_RETRIES = 3;
const PER_PAGE = 1000;
const MAX_PAGES = 20;

// Bitdefender's text is someone else's: control characters are dropped and the length capped.
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max = 300) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const bool = (v: unknown) => (typeof v === 'boolean' ? v : null);
const listOf = (v: unknown): Json[] =>
  (Array.isArray(v) ? v : Array.isArray((v as Json | null)?.items) ? ((v as Json).items as unknown[]) : []).filter(
    (x): x is Json => !!x && typeof x === 'object',
  );
const timeOf = (v: unknown): Date | null => {
  const ms = typeof v === 'string' && v ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v}Z`) : NaN;
  return Number.isFinite(ms) && ms > Date.UTC(2000, 0, 1) && ms < Date.now() + 86_400_000 ? new Date(ms) : null;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A GravityZone JSON-RPC error, with its code (such as -32001 for a refused key). */
export class BitdefenderError extends HttpError {
  constructor(
    message: string,
    readonly rpcCode: number | null,
    status = 502,
  ) {
    super(status, message);
  }
}

const REFUSED =
  'Bitdefender refused the API key. Check the key is active and has the Network and Companies APIs turned on (GravityZone → My account → API keys).';

/**
 * Bitdefender GravityZone's public API: JSON-RPC 2.0 over HTTPS, one address per API (network, companies…). Personal
 * API keys sign in with HTTP Basic (the key as the user name), service API keys with the X-API-Key header.
 */
export class BitdefenderClient {
  private last = 0;

  constructor(
    private readonly connection: Connection,
    private readonly fetcher: typeof fetch = fetch,
    private readonly gapMs = MIN_GAP_MS,
  ) {}

  static for(connection: Connection, fetcher?: typeof fetch) {
    return new BitdefenderClient(connection, fetcher);
  }

  /**
   * Which way the key signs in, found by trying HTTP Basic and then the service-key header. Throws a plain-language
   * error when neither works.
   */
  static async detectAuth(
    accessUrl: string,
    apiKey: string,
    fetcher?: typeof fetch,
    gapMs?: number,
  ): Promise<{ auth: Connection['auth']; companies: { id: string; name: string }[] }> {
    let refused: unknown;
    for (const auth of ['basic', 'header'] as const) {
      try {
        const companies = await new BitdefenderClient({ accessUrl, apiKey, auth }, fetcher, gapMs).companies();
        return { auth, companies };
      } catch (error) {
        if (!(error instanceof BitdefenderError) || error.rpcCode !== -32001) throw error;
        refused = error;
      }
    }
    throw refused;
  }

  private headers(): Record<string, string> {
    return this.connection.auth === 'header'
      ? { 'x-api-key': this.connection.apiKey }
      : { authorization: `Basic ${Buffer.from(`${this.connection.apiKey}:`).toString('base64')}` };
  }

  /** One JSON-RPC call, spaced out under GravityZone's rate limit and retried when it asks Atlas to wait. */
  async call(api: string, method: string, params: Json = {}, version = 'v1.0'): Promise<unknown> {
    const url = `${this.connection.accessUrl}/${version}/jsonrpc/${api}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.headers() },
          body: JSON.stringify({ jsonrpc: '2.0', method, params, id: `atlas-${Date.now()}` }),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new BitdefenderError(`Bitdefender GravityZone couldn't be reached at ${this.connection.accessUrl}.`, null);
      }
      const body = (await response.json().catch(() => null)) as { result?: unknown; error?: Json } | null;
      const code = typeof body?.error?.code === 'number' ? body.error.code : null;
      if ((response.status === 429 || code === -32003) && attempt < MAX_RETRIES) {
        const after = Number(response.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * (attempt + 1), 30_000));
        continue;
      }
      if (response.status === 401 || response.status === 403 || code === -32001)
        throw new BitdefenderError(REFUSED, -32001, 400);
      if (body?.error) {
        const detail = clean((body.error.data as Json | undefined)?.details ?? body.error.message, 300);
        throw new BitdefenderError(`Bitdefender: ${detail || 'the request failed'} (${method}).`, code);
      }
      if (!response.ok || !body)
        throw new BitdefenderError(`Bitdefender answered ${response.status} to ${method}.`, null);
      return body.result;
    }
  }

  /**
   * The companies the key can see: a partner's customer companies, or a single company's own. An account with no
   * customers (or a key without the partner methods) is treated as its own one company.
   */
  async companies(): Promise<{ id: string; name: string }[]> {
    let list: Json[] = [];
    try {
      list = listOf(await this.call('network', 'getCompaniesList'));
    } catch (error) {
      if (!(error instanceof BitdefenderError) || ![-32601, -32602, -32002].includes(error.rpcCode ?? 0)) throw error;
    }
    if (!list.length) {
      const own = (await this.call('companies', 'getCompanyDetails')) as Json | null;
      if (own?.id) list = [own];
    }
    return list
      .map((c) => ({ id: clean(c.id, 100), name: clean(c.name, 200) || 'Unnamed company' }))
      .filter((c) => c.id);
  }

  /** Every managed endpoint under a company, in all its groups. */
  async endpoints(companyId: string): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = (await this.call(
        'network',
        'getEndpointsList',
        {
          parentId: companyId,
          isManaged: true,
          page,
          perPage: PER_PAGE,
          filters: { depth: { allItemsRecursively: true } },
          options: { returnProductOutdated: true },
        },
        'v1.1',
      )) as Json | null;
      const items = listOf(result);
      out.push(...items);
      const pages = Number(result?.pagesCount);
      if (!items.length || result?.hasMoreRecords === false || (Number.isFinite(pages) && page >= pages)) break;
    }
    return out;
  }

  async details(endpointId: string): Promise<Json> {
    return ((await this.call('network', 'getManagedEndpointDetails', { endpointId })) ?? {}) as Json;
  }
}

const LICENCE: Record<number, BitdefenderLicence> = { 0: 'pending', 1: 'active', 2: 'expired', 6: 'none' };

/** An endpoint as Atlas stores it, from its list entry and (when they could be read) its details. */
export function endpointRow(item: Json, details: Json | null) {
  const d = details ?? {};
  const agent = (d.agent ?? {}) as Json;
  const malware = (d.malwareStatus ?? {}) as Json;
  const policy = ((d.policy ?? item.policy) ?? {}) as Json;
  const risk = (d.riskScore ?? {}) as Json;
  const state = Number(d.state);
  const score = parseInt(String(risk.value ?? ''), 10);
  const macs = (Array.isArray(item.macs) ? item.macs : [])
    .map((m) => clean(m, 40))
    .filter(Boolean)
    .slice(0, 20);
  return {
    name: clean(d.name ?? item.name, 200) || clean(item.fqdn, 200) || 'Unnamed endpoint',
    fqdn: clean(item.fqdn, 255),
    os: clean(d.operatingSystem ?? item.operatingSystemVersion, 200),
    ip: clean(d.ip ?? item.ip, 100),
    macs,
    online: state === 1 ? true : state === 2 || state === 3 ? false : null,
    lastSeenAt: timeOf(d.lastSeen),
    infected: malware.infected === true,
    detection: malware.detection === true,
    signaturesOutdated: bool(agent.signatureOutdated),
    productOutdated: bool(agent.productOutdated ?? item.productOutdated),
    licence: LICENCE[Number(agent.licensed)] ?? ('unknown' as BitdefenderLicence),
    policyName: clean(policy.name, 200),
    policyApplied: bool(policy.applied),
    isolated: (d.isIsolated ?? item.isIsolated) === true,
    riskScore: Number.isFinite(score) ? Math.min(Math.max(score, 0), 100) : null,
    riskImpact: clean(risk.impact, 20),
    modules: Object.entries((d.modules ?? {}) as Json)
      .filter(([, on]) => on === true)
      .map(([name]) => clean(name, 60))
      .sort(),
    productVersion: clean(agent.productVersion, 60),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const MAC = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^[0-9a-f]{12}$/i;
const macKey = (s: string) => (MAC.test(s.trim()) ? s.trim().toLowerCase().replace(/[^0-9a-f]/g, '') : '');

/** A client's assets by name (and short host name) and by any MAC address in their fields. */
async function assetIndex(db: Database, orgId: string, clientId: string) {
  const rows = await db
    .select({ id: schema.assets.id, name: schema.assets.name, fields: schema.assets.fields })
    .from(schema.assets)
    .where(
      and(eq(schema.assets.orgId, orgId), eq(schema.assets.clientId, clientId), eq(schema.assets.archived, false)),
    );
  const byName = new Map<string, string>();
  const byMac = new Map<string, string>();
  for (const a of rows) {
    for (const key of [norm(a.name), norm(a.name.split('.')[0] ?? '')]) if (key && !byName.has(key)) byName.set(key, a.id);
    for (const value of Object.values((a.fields ?? {}) as Json))
      for (const part of typeof value === 'string' ? value.split(/[\s,;]+/) : []) {
        const mac = macKey(part);
        if (mac && !byMac.has(mac)) byMac.set(mac, a.id);
      }
  }
  const live = new Set(rows.map((a) => a.id));
  return {
    /** Whether an asset is still this client's and not archived. */
    has: (id: string | null): id is string => !!id && live.has(id),
    match(row: { name: string; fqdn: string; macs: string[] }) {
      for (const key of [norm(row.name), norm(row.fqdn.split('.')[0] ?? '')]) {
        const id = key && byName.get(key);
        if (id) return id;
      }
      for (const m of row.macs) {
        const id = byMac.get(macKey(m));
        if (id) return id;
      }
      return null;
    },
    add(id: string, name: string) {
      live.add(id);
      byName.set(norm(name), id);
    },
  };
}

/**
 * Reads every managed endpoint of each linked company into bitdefender_endpoints, matched to the client's assets by
 * name or MAC address. Read-only for GravityZone. A company that can't be read keeps its last rows; endpoints gone
 * from GravityZone, and companies no longer linked, are removed.
 */
export async function runBitdefenderSync(
  db: Database,
  actor: Actor,
  client: BitdefenderClient,
  run: ImportRun,
  saved: Pick<StoredBitdefender, 'map' | 'options'>,
): Promise<void> {
  const options = bitdefenderSyncOptionsSchema.parse(saved.options ?? {});
  const scope = new Scope(db, actor);
  const t = schema.bitdefenderEndpoints;
  const links = Object.entries(saved.map).flatMap(([companyId, m]) =>
    m.action === 'link' ? [{ companyId, clientId: m.clientId }] : [],
  );
  if (!links.length) run.note('No GravityZone company is linked to a client yet, so nothing was read.');
  const names = new Map((await client.companies()).map((c) => [c.id, c.name]));
  const layouts = new LayoutService(db);
  const assets = new AssetService(layouts);
  let layout: { id: string; fields: LayoutField[] } | null = null;

  for (const { companyId, clientId } of links) {
    const company = names.get(companyId);
    if (!company) {
      run.note(`A linked GravityZone company (${companyId}) is no longer visible to the API key; its endpoints were kept.`);
      continue;
    }
    let clientName: string;
    try {
      await scope.require(clientId, 'read', 'Client');
      const [row] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, clientId));
      clientName = row!.name;
    } catch {
      run.note(`${company}: its Atlas client no longer exists. Link the company again.`);
      continue;
    }
    let items: Json[];
    try {
      items = await client.endpoints(companyId);
    } catch (error) {
      run.note(`${company}: endpoints could not be read. ${error instanceof HttpError ? error.message : ''}`.trim());
      continue;
    }
    const index = await assetIndex(db, actor.orgId, clientId);
    const seen: string[] = [];
    const tally: Record<BitdefenderHealth, number> = { infected: 0, attention: 0, protected: 0 };
    let matched = 0;
    let added = 0;
    let unread = 0;
    for (const item of items) {
      const endpointId = clean(item.id, 100);
      if (!endpointId) continue;
      let details: Json | null = null;
      try {
        details = await client.details(endpointId);
      } catch (error) {
        if (error instanceof BitdefenderError && error.rpcCode === -32001) throw error;
        unread++;
      }
      const row = endpointRow(item, details);
      // An asset an earlier sync added for this endpoint, if it's still there; otherwise one with its name or MAC.
      const earlier = await run.ref('assets', endpointId);
      let assetId = index.has(earlier) ? earlier : index.match(row);
      if (!assetId && options.createAssets) {
        layout ??= await (async () => {
          const { id } = await deviceLayout(db, actor.orgId, null, actor);
          return { id, fields: (await layouts.get(actor, id)).fields as LayoutField[] };
        })();
        const created = await assets.create(scope, clientId, {
          layoutId: layout.id,
          name: row.name,
          fields: fitFields(layout.fields, {
            hostname: row.fqdn || row.name,
            ip_address: row.ip,
            mac_address: row.macs[0] ?? '',
            operating_system: row.os,
          }),
          notes: 'Added by the Bitdefender GravityZone sync.',
        });
        await run.remember('assets', endpointId, created.id);
        index.add(created.id, row.name);
        assetId = created.id;
        added++;
      }
      if (assetId) matched++;
      const { fqdn: _fqdn, ...values } = row;
      const [existing] = await db
        .select({ id: t.endpointId })
        .from(t)
        .where(and(eq(t.orgId, actor.orgId), eq(t.endpointId, endpointId)));
      await db
        .insert(t)
        .values({ orgId: actor.orgId, endpointId, companyId, clientId, assetId, ...values })
        .onConflictDoUpdate({
          target: [t.orgId, t.endpointId],
          set: { companyId, clientId, assetId, ...values, updatedAt: new Date() },
        });
      run.count('endpoints', existing ? 'updated' : 'created');
      seen.push(endpointId);
      tally[bitdefenderHealth({ ...values, lastSeenAt: values.lastSeenAt?.toISOString() ?? null }).health]++;
    }
    // Endpoints this company no longer lists are gone from GravityZone.
    await db
      .delete(t)
      .where(
        and(
          eq(t.orgId, actor.orgId),
          eq(t.companyId, companyId),
          ...(seen.length ? [notInArray(t.endpointId, seen)] : []),
        ),
      );
    run.note(
      `${clientName}: ${items.length} endpoint${items.length === 1 ? '' : 's'} (${tally.infected} infected, ${tally.attention} needing attention), ${matched} matched to assets${added ? `, ${added} added as assets` : ''}.${unread ? ` ${unread} endpoint${unread === 1 ? "'s" : "s'"} details couldn't be read, so only their basic facts were saved.` : ''}`,
    );
  }
  // Companies unlinked (or skipped) since the last sync take their endpoints with them.
  const linked = links.map((l) => l.companyId);
  await db
    .delete(t)
    .where(and(eq(t.orgId, actor.orgId), ...(linked.length ? [notInArray(t.companyId, linked)] : [])));
}

type Row = typeof schema.bitdefenderEndpoints.$inferSelect;
const RANK: Record<BitdefenderHealth, number> = { infected: 0, attention: 1, protected: 2 };

function view(row: Row, assetName: string | null, now: number): BitdefenderEndpointView {
  const facts = {
    infected: row.infected,
    detection: row.detection,
    signaturesOutdated: row.signaturesOutdated,
    productOutdated: row.productOutdated,
    licence: row.licence as BitdefenderLicence,
    policyApplied: row.policyApplied,
    isolated: row.isolated,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  };
  return {
    id: row.endpointId,
    name: row.name,
    assetId: row.assetId,
    assetName,
    os: row.os,
    ip: row.ip,
    online: row.online,
    riskScore: row.riskScore,
    riskImpact: row.riskImpact,
    modules: row.modules,
    productVersion: row.productVersion,
    policyName: row.policyName,
    ...facts,
    ...bitdefenderHealth(facts, now),
    syncedAt: row.updatedAt.toISOString(),
  };
}

/** A client's endpoints, most serious first, and the RMM devices Bitdefender doesn't know about. */
export async function clientEndpoints(
  db: Database,
  orgId: string,
  clientId: string,
  linked: boolean,
  now = Date.now(),
): Promise<BitdefenderClientView> {
  const t = schema.bitdefenderEndpoints;
  const rows = await db
    .select({ row: t, assetName: schema.assets.name })
    .from(t)
    .leftJoin(schema.assets, eq(schema.assets.id, t.assetId))
    .where(and(eq(t.orgId, orgId), eq(t.clientId, clientId)));
  const endpoints = rows
    .map((r) => view(r.row, r.assetName, now))
    .sort((a, b) => RANK[a.health] - RANK[b.health] || a.name.localeCompare(b.name));
  const counts: Record<BitdefenderHealth, number> = { infected: 0, attention: 0, protected: 0 };
  for (const e of endpoints) counts[e.health]++;
  const covered = new Set(endpoints.map((e) => e.assetId).filter((id): id is string => !!id));
  const s = schema.rmmDeviceStatus;
  const devices = linked
    ? await db
        .select({ assetId: s.assetId, name: schema.assets.name })
        .from(s)
        .innerJoin(schema.assets, eq(schema.assets.id, s.assetId))
        .where(and(eq(s.orgId, orgId), eq(s.clientId, clientId), eq(schema.assets.archived, false)))
    : [];
  return {
    linked,
    syncedAt: endpoints.reduce<string | null>((max, e) => (!max || e.syncedAt > max ? e.syncedAt : max), null),
    counts,
    endpoints,
    missing: devices
      .filter((d) => !covered.has(d.assetId))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200),
  };
}

/** The Bitdefender endpoint matched to an asset, if any. */
export async function assetEndpoint(db: Database, orgId: string, assetId: string, now = Date.now()) {
  const t = schema.bitdefenderEndpoints;
  const [row] = await db
    .select({ row: t, assetName: schema.assets.name })
    .from(t)
    .leftJoin(schema.assets, eq(schema.assets.id, t.assetId))
    .where(and(eq(t.orgId, orgId), eq(t.assetId, assetId)))
    .limit(1);
  return row ? view(row.row, row.assetName, now) : null;
}

/** Removes every synced endpoint, when GravityZone is disconnected. */
export async function clearEndpoints(db: Database, orgId: string) {
  await db.delete(schema.bitdefenderEndpoints).where(eq(schema.bitdefenderEndpoints.orgId, orgId));
}
