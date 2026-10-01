// The ConnectWise platform API client: sign-in, retries, paging, and the device, company and contact reads.
import { createHash } from 'node:crypto';
import { type CwRmmRegion } from '@atlas/shared';
import { HttpError } from '../../errors.js';
import {
  type Json,
  type RmmCompany,
  type RmmContact,
  type RmmDevice,
  type RmmRelation,
  type RmmSite,
  SITE_ID_KEYS,
  DETAIL_CONCURRENCY,
  DETAIL_FIELDS,
  DEVICE_ID_KEYS,
  appsOf,
  deviceObject,
  listOf,
  mapContact,
  mapDevice,
  nextCursorOf,
  pick,
  recordsOf,
  shapeOf,
  signInsOf,
  text,
  withGroupIds,
  withState,
} from './cw-rmm-devices.js';



export const CW_RMM_BASE: Record<CwRmmRegion, string> = {
  na: 'https://openapi.service.itsupport247.net',
  eu: 'https://openapi.service.euplatform.connectwise.com',
  au: 'https://openapi.service.auplatform.connectwise.com',
};
const SCOPES = 'platform.companies.read platform.sites.read platform.devices.read';
/** Running the rotation script needs automation scopes too. Only rotation asks for them, so a key without them still syncs. */
export const ROTATION_SCOPES = `${SCOPES} platform.automation.read platform.automation.create`;
/** Tickets get their own token, so a key without ticket access still syncs devices. */
export const TICKET_SCOPES = 'platform.companies.read platform.tickets.read';
/** Adding ticket notes (the scope names CallBridge uses against the same API). Asked for only when notes are on. */
export const TICKET_NOTE_SCOPES = `${TICKET_SCOPES} platform.tickets.create`;
/** Writing the "Atlas link" custom fields on devices. Asked for only when that option is on. */
export const LINK_SCOPES = `${SCOPES} platform.devices.write`;
const RETRY_MS = 2000;
/** The code on errors that mean the key can't sign in or lacks a permission: no other request shape will help. */
export const ACCESS_DENIED = 'cw_access_denied';
// Five attempts at this length, plus the lead-in and the company prefix, fit an import job message (800 characters).
const ATTEMPT_CHARS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Method = 'GET' | 'POST' | 'PUT';

type DeviceQuery = { kind: 'v2'; resourceType: string; limit: number } | { kind: 'v1'; limit: number };
// The platform API spec takes company, site, or endpoint as the resource type, up to 500 devices a page. The first
// shape that works is kept for the run; the others are older fallbacks, tried only if the spec's are refused.
const DEVICE_QUERIES: DeviceQuery[] = [
  { kind: 'v2', resourceType: 'company', limit: 500 },
  { kind: 'v2', resourceType: 'site', limit: 500 },
  { kind: 'v2', resourceType: 'client', limit: 100 },
  // Every device the key can see, kept to this company by each device's own company ID.
  { kind: 'v2', resourceType: 'partner', limit: 100 },
  { kind: 'v1', limit: 100 },
];

/** ConnectWise's own explanation of an error, trimmed for a job message. */
async function detail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  let message = raw;
  try {
    const body = JSON.parse(raw) as Json;
    message =
      text(body, 'message', 'error_description', 'error.message', 'detail', 'title', 'errors.0.message', 'error') ||
      raw;
  } catch {
    /* not JSON */
  }
  message = message.replace(/\s+/g, ' ').trim().slice(0, 200);
  return message ? ` ConnectWise said: ${message}` : '';
}

/** Talks to the ConnectWise Asio platform API with an OAuth client-credentials token. */
export class CwRmmClient {
  /** What the last device list looked like, for a job note when a company comes back empty. */
  lastDeviceList = '';
  /** Field names of one real device (summary and details), for a single job note per sync. */
  lastDeviceFields = '';
  /** Whether the tenant takes a field list on device details; false after it refuses one. */
  private detailFields = true;
  // One client (and so one token) per set of credentials, shared by every request and sync: signing in for
  // each page load gets the key locked.
  private static shared = new WeakMap<typeof fetch, Map<string, CwRmmClient>>();
  static for(
    region: CwRmmRegion,
    clientId: string,
    clientSecret: string,
    fetcher: typeof fetch = fetch,
    scopes: string = SCOPES,
  ) {
    const key = [region, clientId, createHash('sha256').update(clientSecret).digest('hex'), scopes].join('|');
    let clients = CwRmmClient.shared.get(fetcher);
    if (!clients) CwRmmClient.shared.set(fetcher, (clients = new Map()));
    let client = clients.get(key);
    if (!client) clients.set(key, (client = new CwRmmClient(region, clientId, clientSecret, fetcher, scopes)));
    return client;
  }

  private token: { value: string; expires: number } | null = null;
  private readonly base: string;

  constructor(
    region: CwRmmRegion,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly scopes: string = SCOPES,
  ) {
    this.base = CW_RMM_BASE[region];
  }

  /** Concurrent callers share one sign-in: ConnectWise locks a key (423) that asks for many tokens at once. */
  private pending: Promise<string> | null = null;
  /** The device-list request this tenant accepted, once one has worked. */
  private deviceQuery: DeviceQuery | null = null;

  private bearer(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return Promise.resolve(this.token.value);
    this.pending ??= this.signIn().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Sends a request, waiting and retrying (up to 3 times) when ConnectWise says to slow down. */
  private async send(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await request();
      } catch {
        throw new HttpError(502, 'ConnectWise RMM could not be reached. Check the region and this server’s internet access.');
      }
      if (![423, 429, 503].includes(res.status) || attempt >= 3) return res;
      const after = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : RETRY_MS * 2 ** attempt);
    }
  }

  private async signIn(): Promise<string> {
    const res = await this.send(() =>
      this.fetcher(`${this.base}/v1/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: this.scopes,
        }),
        signal: AbortSignal.timeout(20_000),
      }),
    );
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new HttpError(
        400,
        `ConnectWise RMM rejected the client ID or secret, or the key is missing a scope.${await detail(res)}`,
        ACCESS_DENIED,
      );
    if (res.status === 423)
      throw new HttpError(
        502,
        'ConnectWise RMM has temporarily locked this API key after too many sign-ins. Wait a few minutes, then sync again.',
        ACCESS_DENIED,
      );
    if (!res.ok) throw new HttpError(502, `ConnectWise RMM returned ${res.status} when signing in.${await detail(res)}`);
    const body = (await res.json()) as Json;
    const value = text(body, 'access_token', 'accessToken');
    if (!value) throw new HttpError(502, 'ConnectWise RMM did not return an access token.');
    const seconds = Number(pick(body, 'expires_in', 'expiresIn')) || 3600;
    this.token = { value, expires: Date.now() + seconds * 1000 };
    return value;
  }

  /** A GET for another part of the platform API (tickets), with the same sign-in, retries, and errors. */
  get(path: string): Promise<unknown> {
    return this.call('GET', path);
  }

  /** A write to the platform API. Only the opt-in write-back options use these. */
  post(path: string, body: unknown): Promise<unknown> {
    return this.call('POST', path, body);
  }

  put(path: string, body: unknown): Promise<unknown> {
    return this.call('PUT', path, body);
  }

  /** One page of another part of the platform API (patching, backup, security), with the next page's cursor. */
  page(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ body: unknown; nextCursor: number | null }> {
    return this.request(method, path, body);
  }

  private async call(method: Method, path: string, body?: unknown): Promise<unknown> {
    return (await this.request(method, path, body)).body;
  }

  /** A call's body, with the next page's cursor when ConnectWise gives one in its Link header. */
  private async request(
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<{ body: unknown; nextCursor: number | null }> {
    const token = await this.bearer();
    const res = await this.send(() =>
      this.fetcher(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      }),
    );
    const where = path.split('?')[0];
    if (res.status === 401 || res.status === 403)
      throw new HttpError(
        400,
        `ConnectWise RMM refused ${where}. Check the key's scopes in API Access.${await detail(res)}`,
        ACCESS_DENIED,
      );
    if (!res.ok)
      throw new HttpError(
        res.status === 400 || res.status === 404 ? res.status : 502,
        `ConnectWise RMM returned ${res.status} for ${where}.${await detail(res)}`,
      );
    let parsed: unknown;
    if (method === 'GET') parsed = await res.json();
    else {
      // A write can answer with no body (204), or one that isn't JSON; either way it worked.
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        parsed = null;
      }
    }
    return { body: parsed, nextCursor: nextCursorOf(res.headers.get('link')) };
  }

  /**
   * Runs a script from the ConnectWise RMM script library on one device, now, with these parameters. Returns the
   * task ID ConnectWise gives back ('' when it gives none).
   *
   * The platform API spec schedules a script with POST /v2/automation/endpoints/schedule-tasks: the script as the
   * template, the endpoint IDs as targets, and the parameters as one JSON string. The spec doesn't list the schedule
   * values; RunNow is ConnectWise's tasking name for "run once, now". ConnectWise's own answer is passed on whole
   * when it refuses.
   */
  async runScript(input: {
    companyId: string;
    endpointId: string;
    scriptId: string;
    name: string;
    parameters: Record<string, string>;
  }): Promise<string> {
    const body = await this.call('POST', '/api/platform/v2/automation/endpoints/schedule-tasks', {
      templateID: input.scriptId,
      templateType: 'script',
      name: input.name.slice(0, 100),
      description: input.name.slice(0, 100),
      parameters: JSON.stringify(input.parameters),
      targets: [input.endpointId],
      targetType: 'MANAGED_ENDPOINT',
      schedule: { regularity: 'RunNow' },
    });
    return text((body ?? {}) as Json, 'taskId', 'taskID', 'id', 'data.taskId');
  }

  async companies(): Promise<RmmCompany[]> {
    return listOf(await this.call('GET', '/api/platform/v1/company/companies'))
      .map((c) => ({ id: text(c, 'id', 'companyId', 'clientId'), name: text(c, 'name', 'companyName', 'friendlyName') }))
      .filter((c) => c.id && c.name);
  }

  async sites(companyId: string): Promise<RmmSite[]> {
    return listOf(await this.call('GET', `/api/platform/v1/company/companies/${encodeURIComponent(companyId)}/sites`))
      .map((s) => ({
        id: text(s, 'id', 'siteId'),
        companyId,
        name: text(s, 'name', 'siteName', 'friendlyName') || 'Site',
        address: [text(s, 'address.line1', 'address.addressLine1', 'addressLine1', 'address1'), text(s, 'address.line2', 'addressLine2', 'address2')]
          .filter(Boolean)
          .join(', '),
        city: text(s, 'address.city', 'city'),
        region: text(s, 'address.state', 'address.region', 'state', 'region'),
        postalCode: text(s, 'address.postalCode', 'address.zip', 'postalCode', 'zip', 'zipCode'),
        country: text(s, 'address.country', 'country', 'countryName'),
      }))
      .filter((s) => s.id);
  }

  /**
   * The company's contacts: its primary contact (from the company record, as the spec gives it), plus any others
   * the contact list returns for this company. The spec documents only creating contacts, so the list is a bonus:
   * when ConnectWise refuses it, the primary contact is still synced.
   */
  async contacts(companyId: string): Promise<RmmContact[]> {
    const company = (await this.call('GET', `/api/platform/v1/company/companies/${encodeURIComponent(companyId)}`)) as Json;
    const primary = mapContact((pick(company ?? {}, 'primaryContact', 'data.primaryContact') ?? {}) as Json, true);
    const out = new Map<string, RmmContact>(primary ? [[primary.id, primary]] : []);
    let listed: Json[] = [];
    try {
      listed = listOf(await this.call('GET', `/api/platform/v1/contact/contacts?companyId=${encodeURIComponent(companyId)}`));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
    }
    for (const c of listed) {
      // Only contacts that say they belong to this company: a list that ignored the filter mustn't mix clients.
      if (text(c, 'company.id', 'companyId', 'company.companyId') !== companyId) continue;
      const mapped = mapContact(c, primary?.id === text(c, 'id', 'contactId'));
      if (mapped) out.set(mapped.id, mapped);
    }
    return [...out.values()];
  }

  /** Every device for the company, page by page, using the first request shape the tenant accepts. */
  async devices(companyId: string, siteIds: string[] = [], opts: { inventory?: boolean } = {}): Promise<RmmDevice[]> {
    const shapes = this.deviceQuery ? [this.deviceQuery] : DEVICE_QUERIES;
    const tried: string[] = [];
    for (const shape of shapes) {
      if (shape.kind === 'v2' && shape.resourceType === 'site' && !siteIds.length) continue;
      try {
        const listed = await this.devicePages(companyId, siteIds, shape);
        this.deviceQuery = shape;
        const devices = await this.withDetails(companyId, siteIds, listed);
        // Neither the list nor the details say whether the agent is online, when it last checked in, or how its
        // protection is doing; the heartbeat and system state APIs do.
        const [beats, states] = await Promise.all([
          this.endpointStates(companyId, 'heartbeat'),
          this.endpointStates(companyId, 'systemstate'),
        ]);
        const synced = devices.map((d) => withState(d, beats.get(d.id), states.get(d.id)));
        if (!opts.inventory) return synced;
        // One request at a time, like the rest: ConnectWise rate-limits bursts.
        const apps = await this.perEndpoint(companyId, 'applications', 'applications');
        const users = await this.perEndpoint(companyId, 'users', 'users');
        return synced.map((d) => ({
          ...d,
          ...(apps ? { software: appsOf(apps.get(d.id) ?? []) } : {}),
          // With neither API answering, who signs in is unknown rather than nobody.
          ...(users || states.size ? { signIns: signInsOf(users?.get(d.id) ?? [], states.get(d.id)) } : {}),
        }));
      } catch (error) {
        // Only a rejected request is worth trying another shape for.
        if (!(error instanceof HttpError && error.status === 400)) throw error;
        const said = /ConnectWise said: (.*)$/.exec(error.message)?.[1] ?? error.message;
        // Each attempt gets its own share of the job message, so a long answer can't hide a later one.
        const short = said.length > ATTEMPT_CHARS ? `${said.slice(0, ATTEMPT_CHARS - 1)}…` : said;
        tried.push(`${shape.kind === 'v2' ? `v2 by ${shape.resourceType}` : 'v1 list'}: ${short}`);
      }
    }
    // Every shape's answer, so one message shows whether it's the request or the key's permissions.
    throw new HttpError(
      400,
      `ConnectWise RMM wouldn't list devices. Check the API key has the Devices read permission. Tried ${tried.join('; ')}`,
    );
  }

  /**
   * A bulk per-endpoint list (installed applications, or user accounts) for the company, by endpoint ID, following
   * the Link header page by page. Null when ConnectWise won't say, so what an earlier sync saved is kept.
   */
  private async perEndpoint(
    companyId: string,
    api: 'applications' | 'users',
    listKey: string,
  ): Promise<Map<string, Json[]> | null> {
    const out = new Map<string, Json[]>();
    try {
      for (let cursor: number | null = 0, pages = 0; cursor !== null && pages < 200; pages++) {
        const { body, nextCursor } = await this.request(
          'POST',
          `/api/platform/v2/device/endpoints/${api}?limit=500&cursor=${cursor}`,
          { resourceType: 'company', resources: [companyId] },
        );
        for (const e of listOf(body)) {
          const id = text(e, 'endpointID', 'endpointId', 'EndpointID');
          const list = pick(e, listKey);
          if (id && Array.isArray(list)) out.set(id, [...(out.get(id) ?? []), ...(list as Json[])]);
        }
        cursor = nextCursor !== null && nextCursor > cursor ? nextCursor : null;
      }
    } catch (error) {
      // No permission, not supported, or "not found": unknown, so what an earlier sync saved stays. (A company with
      // no devices has nothing to save either way.)
      if (error instanceof HttpError) return null;
      throw error;
    }
    return out;
  }

  /** Devices related to this one (a VM's host, a host's VMs); empty when ConnectWise has none or won't say. */
  async relations(companyId: string, siteId: string, endpointId: string): Promise<RmmRelation[]> {
    const body = await this.call(
      'GET',
      `/api/platform/v2/device/companies/${encodeURIComponent(companyId)}/sites/${encodeURIComponent(siteId)}/endpoints/${encodeURIComponent(endpointId)}/relations`,
    );
    const related = pick((body ?? {}) as Json, 'relations');
    return (Array.isArray(related) ? (related as Json[]) : [])
      .map((r) => ({
        endpointId: text(r, 'endpointID', 'endpointId'),
        role: text(r, 'relationshipType.source'),
        relatedRole: text(r, 'relationshipType.target'),
      }))
      .filter((r) => r.endpointId && r.endpointId !== endpointId);
  }

  /** Each of the company's endpoints' record from a bulk state API, by endpoint ID; empty when ConnectWise won't say. */
  private async endpointStates(companyId: string, api: 'heartbeat' | 'systemstate'): Promise<Map<string, Json>> {
    const out = new Map<string, Json>();
    let body: unknown;
    try {
      body = await this.call(
        'GET',
        `/api/platform/v2/device/endpoints/${api}?resourceType=companies&resources=${encodeURIComponent(companyId)}`,
      );
    } catch (error) {
      // These are extra: without them the devices still sync, with the values unknown.
      if (error instanceof HttpError) return out;
      throw error;
    }
    const records = pick((body ?? {}) as Json, 'successfulRecords');
    for (const record of Array.isArray(records) ? (records as Json[]) : []) {
      const endpoints = pick(record, 'endpoints');
      for (const e of Array.isArray(endpoints) ? (endpoints as Json[]) : []) {
        const id = text(e, 'EndpointID', 'endpointID', 'endpointId');
        if (id) out.set(id, e);
      }
    }
    return out;
  }

  /**
   * The list gives a short summary per device; the details (hostname, OS, network, hardware) come from each
   * device's own endpoint, fetched a few at a time. A device whose details can't be read keeps its summary.
   */
  private async withDetails(companyId: string, siteIds: string[], listed: { id: string; raw: Json }[]) {
    const out: RmmDevice[] = [];
    // The list doesn't say which site a device is in. The details endpoint needs one, so the company's sites
    // are tried in turn, busiest first (by devices found so far), stopping at the one that knows the device.
    const hits = new Map<string, number>();
    let next = 0;
    const worker = async () => {
      while (next < listed.length) {
        const { id, raw } = listed[next++]!;
        const listedSite = text(raw, ...SITE_ID_KEYS);
        const candidates = listedSite
          ? [listedSite]
          : [...siteIds].sort((a, b) => (hits.get(b) ?? 0) - (hits.get(a) ?? 0));
        let siteId = listedSite; // Kept even when the details can't be read.
        let detail: Json = {};
        let detailNote = candidates.length ? '' : 'no site to look it up in';
        for (const site of candidates) {
          try {
            const path = `/api/platform/v2/device/companies/${encodeURIComponent(companyId)}/sites/${encodeURIComponent(site)}/endpoints/${encodeURIComponent(id)}`;
            const body = await this.detailsOf(path);
            detail = deviceObject(body, id);
            siteId = text(detail, ...SITE_ID_KEYS) || site;
            hits.set(site, (hits.get(site) ?? 0) + 1);
            detailNote = '';
            break;
          } catch (error) {
            if (!(error instanceof HttpError)) throw error;
            detailNote = error.message.replace(/^ConnectWise RMM /, '').slice(0, 120);
            // Not in this site: try the next. Anything else won't change from site to site.
            if (error.status !== 404) break;
          }
        }
        // Field names only (never values), once per client, so the mapping can be checked against a real device.
        this.lastDeviceFields ||= `summary fields ${shapeOf(raw)}; details ${detailNote || `fields ${shapeOf(detail)}`}`;
        out.push(mapDevice(id, companyId, siteId, { ...raw, ...detail }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, listed.length) }, worker));
    return out;
  }

  /**
   * A device's details. Without a field list ConnectWise returns only the minimal fields (metadata, os and system),
   * so the hardware and protection sections are asked for by name; a tenant that refuses the list gets the default.
   */
  private async detailsOf(path: string) {
    if (this.detailFields) {
      try {
        return await this.call('GET', `${path}?field=${DETAIL_FIELDS}`);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 400)) throw error;
        this.detailFields = false;
      }
    }
    return this.call('GET', path);
  }

  private async devicePages(companyId: string, siteIds: string[], shape: DeviceQuery) {
    const out: { id: string; raw: Json }[] = [];
    // Only lists that aren't already limited to the company need filtering; a device's own company ID may use
    // a different numbering than the company list, so trusting it elsewhere could drop every device.
    const filter = shape.kind === 'v1' || shape.resourceType === 'partner';
    const via = shape.kind === 'v2' ? `v2 by ${shape.resourceType}` : 'v1 list';
    let seen = 0;
    let otherCompany = 0;
    let noId: Json | undefined;
    this.lastDeviceList = `${via}: no response`;
    for (let cursor = 0, pages = 0; pages < 500; pages++) {
      const query = `limit=${shape.limit}&cursor=${cursor}`;
      let body: unknown;
      let linked: number | null;
      try {
        ({ body, nextCursor: linked } =
          shape.kind === 'v2'
            ? await this.request('POST', `/api/platform/v2/device/categories/all/endpoints?${query}`, {
                resourceType: shape.resourceType,
                resources:
                  shape.resourceType === 'site' ? siteIds : shape.resourceType === 'partner' ? [] : [companyId],
              })
            : await this.request(
                'GET',
                `/api/platform/v1/device/endpoints?${query}&clientId=${encodeURIComponent(companyId)}`,
              ));
      } catch (error) {
        // ConnectWise answers "resource not found" (404) for a company with no devices, or past the last page. A
        // request it can't read gets 400, so a 404 still means the request itself was accepted.
        if (error instanceof HttpError && error.status === 404) {
          if (!pages) this.lastDeviceList = `${via}: resource not found`;
          break;
        }
        throw error;
      }
      const page = recordsOf(withGroupIds(body));
      seen += page.length;
      for (const d of page) {
        const id = text(d, ...DEVICE_ID_KEYS);
        if (!id) {
          noId ??= d;
          continue;
        }
        const owner = text(d, 'companyId', 'clientId', 'company.id', 'client.id');
        if (filter && owner && owner !== companyId) {
          otherCompany++;
          continue;
        }
        out.push({ id, raw: d });
      }
      if (!pages)
        this.lastDeviceList = `${via}: response fields ${shapeOf(body)}; ${page.length} records on the first page`;
      // The spec gives the next page in the Link header; without one, a short page is the last.
      const next = linked ?? Number(pick((body ?? {}) as Json, 'nextCursor', 'pageInfo.nextCursor', 'next'));
      if (linked === null && page.length < shape.limit) break;
      if (!page.length) break;
      cursor = Number.isFinite(next) && next > cursor ? next : cursor + page.length;
    }
    if (seen && !out.length)
      this.lastDeviceList +=
        `; ${otherCompany} belonged to another company, ${seen - otherCompany} had no device ID` +
        (noId ? `; a record without one has fields ${shapeOf(noId)}` : '');
    return out;
  }
}
