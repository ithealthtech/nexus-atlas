import { and, desc, eq, ilike, lt, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  REQUEST_LOG_DIRECTIONS,
  REQUEST_LOG_OUTCOMES,
  requestLogSettingsSchema,
  type RequestLogDetail,
  type RequestLogDirection,
  type RequestLogEntry,
  type RequestLogPage,
  type RequestLogSettings,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { SettingsService } from './settings.js';

/**
 * Verbose request logging: every outbound call Atlas makes (ConnectWise, Hudu, Microsoft, GitHub, …) and every
 * request to its own API, with headers and bodies, while an administrator has it turned on. Secrets are redacted
 * before anything is stored, and entries past the retention period are deleted.
 */

const MAX_BODY = 64 * 1024;
const MAX_ROWS = 100_000;
const PAGE = 100;
const REDACTED = '[redacted]';
const WRAPPED = Symbol('atlas.requestLog');

// Header, query, and body field names whose values are never stored.
const SECRET_NAME =
  /pass(word|wd|phrase)?|secret|token|api[-_]?key|apikey|^key$|^code$|authori[sz]ation|cookie|session|csrf|credential|otp|mfa|recovery|sealed|signature|private|code[-_]?verifier|assertion|^pin$/i;
// A secret carried as a value next to a label (Hudu asset fields: { label: 'Admin password', value: '…' }).
const LABEL_KEYS = ['label', 'name', 'key', 'field', 'title'];
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

// Incoming requests whose bodies carry vault secrets or sign-in material: only the method, path, and status are kept.
const PRIVATE_PATHS = [
  '/api/passwords',
  '/api/vault',
  '/api/sends',
  '/api/shares',
  '/api/session',
  '/api/passkey',
  '/api/setup',
  '/api/password-reset',
  '/api/account',
  '/api/native',
  '/api/device',
  '/api/rotation/agent',
  '/api/api-keys',
  '/api/emergency-access',
  '/api/users',
  '/api/import',
  '/api/export',
  '/api/attachments',
  '/api/org/erase',
];

export const isSecretName = (name: string) => SECRET_NAME.test(name);

function scrubText(text: string) {
  return text.replace(BEARER, `$1 ${REDACTED}`).replace(JWT, REDACTED);
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const labelled = LABEL_KEYS.some((k) => typeof obj[k] === 'string' && isSecretName(obj[k] as string));
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [
        k,
        (isSecretName(k) || (labelled && k === 'value')) && v !== null && v !== '' ? REDACTED : redactValue(v),
      ]),
    );
  }
  return typeof value === 'string' ? scrubText(value) : value;
}

/** A request or response body with secrets removed, cut to a readable size. */
export function redactBody(text: string, contentType = ''): string {
  if (!text) return '';
  let out: string;
  const trimmed = text.trimStart();
  if (/json/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      out = JSON.stringify(redactValue(JSON.parse(text)), null, 2);
    } catch {
      out = scrubText(text);
    }
  } else if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.%-]+=[^\s&]*(&[\w.%-]+=[^\s&]*)*$/.test(text)) {
    const params = new URLSearchParams(text);
    for (const k of [...params.keys()]) if (isSecretName(k)) params.set(k, REDACTED);
    out = scrubText(params.toString().replace(/%5Bredacted%5D/gi, REDACTED));
  } else out = scrubText(text);
  return out.length > MAX_BODY ? `${out.slice(0, MAX_BODY)}\n… cut at ${MAX_BODY / 1024} KB` : out;
}

/** A URL with its credentials and secret query values removed. */
export function redactUrl(raw: string): string {
  let url: URL;
  const relative = raw.startsWith('/');
  try {
    url = new URL(raw, 'http://atlas.invalid');
  } catch {
    return scrubText(raw);
  }
  if (url.username) url.username = REDACTED;
  if (url.password) url.password = REDACTED;
  for (const k of [...url.searchParams.keys()]) if (isSecretName(k)) url.searchParams.set(k, REDACTED);
  const out = (relative ? `${url.pathname}${url.search}` : url.toString()).replace(/%5Bredacted%5D/gi, REDACTED);
  try {
    return scrubText(decodeURI(out));
  } catch {
    return scrubText(out);
  }
}

export function redactHeaders(headers: Headers | Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: [string, unknown][] =
    headers instanceof Headers ? [...headers.entries()] : Object.entries(headers as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    out[k.toLowerCase()] = isSecretName(k) ? REDACTED : scrubText(value);
  }
  return out;
}

/** The integration an outbound call belongs to, by host name. */
export function serviceOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'Other';
  }
  if (/connectwise|myconnectwise|itsupport247|asio/.test(host)) return 'ConnectWise';
  if (/hudu/.test(host)) return 'Hudu';
  if (/microsoft|office|live\.com|windows\.net/.test(host)) return 'Microsoft';
  if (/pwnedpasswords|haveibeenpwned/.test(host)) return 'Have I Been Pwned';
  if (/github/.test(host)) return 'GitHub';
  if (/rdap|iana/.test(host)) return 'Domain lookup';
  return host || 'Other';
}

export const isPrivatePath = (path: string) =>
  PRIVATE_PATHS.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`));

const isText = (contentType: string | null) =>
  !contentType || /json|text|xml|x-www-form-urlencoded|javascript|problem/i.test(contentType);

export interface NewRequestLogEntry {
  direction: RequestLogDirection;
  service: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  actor?: string;
  error?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

export interface RequestLogQuery {
  direction?: string;
  service?: string;
  method?: string;
  outcome?: string;
  q?: string;
  before?: string;
}

export class RequestLogService {
  private orgId: string | null = null;
  private config: RequestLogSettings = requestLogSettingsSchema.parse({});
  private queue: (typeof schema.requestLog.$inferInsert)[] = [];
  private flushing: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  /** Reads the saved setting (v1 runs one organization per installation). */
  async load() {
    const [org] = await this.db.select({ id: schema.orgs.id }).from(schema.orgs).limit(1);
    if (!org) return;
    this.orgId = org.id;
    this.config = await this.settings.requestLog(org.id);
  }

  get recording() {
    return !!this.orgId && this.config.enabled;
  }

  get recordingIncoming() {
    return this.recording && this.config.incoming;
  }

  async saveSettings(orgId: string, input: unknown): Promise<RequestLogSettings> {
    const saved = await this.settings.saveRequestLog(orgId, input);
    this.orgId = orgId;
    this.config = saved;
    return saved;
  }

  record(entry: NewRequestLogEntry) {
    if (!this.recording) return;
    if (this.queue.length >= 1000) return; // The database is behind; drop rather than hold memory.
    this.queue.push({
      orgId: this.orgId!,
      direction: entry.direction,
      service: entry.service.slice(0, 100),
      method: entry.method.toUpperCase().slice(0, 16),
      url: entry.url.slice(0, 4000),
      status: entry.status,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      actor: (entry.actor ?? '').slice(0, 200),
      error: (entry.error ?? '').slice(0, 1000),
      requestHeaders: entry.requestHeaders ?? {},
      requestBody: entry.requestBody ?? '',
      responseHeaders: entry.responseHeaders ?? {},
      responseBody: entry.responseBody ?? '',
    });
    this.flushTimer ??= setTimeout(() => void this.flush(), 500);
  }

  /** Writes queued entries. Logging never fails the request it describes, so errors are dropped. */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    while (this.flushing) await this.flushing;
    if (!this.queue.length) return;
    const batch = this.queue.splice(0);
    this.flushing = this.db
      .insert(schema.requestLog)
      .values(batch)
      .then(
        () => undefined,
        () => undefined,
      );
    await this.flushing;
    this.flushing = null;
  }

  /** Wraps a fetch so each call is recorded while logging is on. */
  wrap(inner: typeof fetch): typeof fetch {
    if ((inner as unknown as Record<symbol, boolean>)[WRAPPED]) return inner;
    const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!this.recording) return inner(input, init);
      const started = performance.now();
      const request = input instanceof Request ? input : null;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? request?.method ?? 'GET';
      const requestHeaders = redactHeaders(new Headers(init?.headers ?? request?.headers));
      const body = init?.body;
      const contentType = requestHeaders['content-type'] ?? '';
      const requestBody =
        typeof body === 'string'
          ? redactBody(body, contentType)
          : body instanceof URLSearchParams
            ? redactBody(body.toString(), 'application/x-www-form-urlencoded')
            : body
              ? '[binary or streamed body not recorded]'
              : '';
      const base = {
        direction: 'outbound' as const,
        service: serviceOf(url),
        method,
        url: redactUrl(url),
        requestHeaders,
        requestBody,
      };
      let res: Response;
      try {
        res = await inner(input, init);
      } catch (error) {
        this.record({
          ...base,
          status: 0,
          durationMs: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      const durationMs = performance.now() - started;
      try {
        const responseHeaders = redactHeaders(res.headers);
        const type = res.headers?.get?.('content-type') ?? null;
        const length = Number(res.headers?.get?.('content-length') ?? 0);
        const entry = { ...base, status: res.status, durationMs, responseHeaders };
        if (typeof res.clone !== 'function' || !isText(type) || length > 2 * 1024 * 1024)
          this.record({ ...entry, responseBody: res.body ? '[binary or large body not recorded]' : '' });
        else
          void res
            .clone()
            .text()
            .then(
              (text) => this.record({ ...entry, responseBody: redactBody(text, type ?? '') }),
              () => this.record(entry),
            );
      } catch {
        // Never let logging break the call.
      }
      return res;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    return wrapped as typeof fetch;
  }

  async list(orgId: string, query: RequestLogQuery): Promise<RequestLogPage> {
    const where: SQL[] = [eq(schema.requestLog.orgId, orgId)];
    if (query.direction && (REQUEST_LOG_DIRECTIONS as readonly string[]).includes(query.direction))
      where.push(eq(schema.requestLog.direction, query.direction));
    if (query.service) where.push(eq(schema.requestLog.service, query.service.slice(0, 100)));
    if (query.method) where.push(eq(schema.requestLog.method, query.method.toUpperCase().slice(0, 16)));
    if (query.outcome && (REQUEST_LOG_OUTCOMES as readonly string[]).includes(query.outcome))
      where.push(
        query.outcome === 'error'
          ? sql`(${schema.requestLog.status} = 0 or ${schema.requestLog.status} >= 400)`
          : sql`(${schema.requestLog.status} > 0 and ${schema.requestLog.status} < 400)`,
      );
    const q = query.q?.trim().slice(0, 200);
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(
        or(
          ilike(schema.requestLog.url, like),
          ilike(schema.requestLog.error, like),
          ilike(schema.requestLog.actor, like),
          ilike(schema.requestLog.requestBody, like),
          ilike(schema.requestLog.responseBody, like),
          sql`${schema.requestLog.status}::text = ${q}`,
        )!,
      );
    }
    const before = Number(query.before);
    if (Number.isSafeInteger(before) && before > 0) where.push(lt(schema.requestLog.id, before));
    const t = schema.requestLog;
    const rows = await this.db
      .select({
        id: t.id,
        at: t.createdAt,
        direction: t.direction,
        service: t.service,
        method: t.method,
        url: t.url,
        status: t.status,
        durationMs: t.durationMs,
        actor: t.actor,
        error: t.error,
      })
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.id))
      .limit(PAGE + 1);
    const services = await this.db
      .selectDistinct({ service: t.service })
      .from(t)
      .where(eq(t.orgId, orgId))
      .orderBy(t.service);
    const page = rows.slice(0, PAGE);
    return {
      settings: await this.settings.requestLog(orgId),
      entries: page.map((r) => ({ ...r, at: r.at.toISOString(), direction: r.direction as RequestLogDirection })),
      services: services.map((s) => s.service),
      nextBefore: rows.length > PAGE ? page[page.length - 1]!.id : null,
    };
  }

  async detail(orgId: string, id: string): Promise<RequestLogDetail> {
    const n = Number(id);
    if (!Number.isSafeInteger(n)) throw new HttpError(404, 'Log entry not found.');
    const [r] = await this.db
      .select()
      .from(schema.requestLog)
      .where(and(eq(schema.requestLog.orgId, orgId), eq(schema.requestLog.id, n)));
    if (!r) throw new HttpError(404, 'Log entry not found.');
    const entry: RequestLogEntry = {
      id: r.id,
      at: r.createdAt.toISOString(),
      direction: r.direction as RequestLogDirection,
      service: r.service,
      method: r.method,
      url: r.url,
      status: r.status,
      durationMs: r.durationMs,
      actor: r.actor,
      error: r.error,
    };
    return {
      ...entry,
      requestHeaders: r.requestHeaders as Record<string, string>,
      requestBody: r.requestBody,
      responseHeaders: r.responseHeaders as Record<string, string>,
      responseBody: r.responseBody,
    };
  }

  async clear(orgId: string) {
    await this.flush();
    await this.db.delete(schema.requestLog).where(eq(schema.requestLog.orgId, orgId));
  }

  /** Deletes entries past the retention period, and the oldest beyond the row cap. */
  async prune() {
    if (!this.orgId) return;
    const cutoff = new Date(Date.now() - this.config.retentionDays * 86_400_000);
    await this.db
      .delete(schema.requestLog)
      .where(and(eq(schema.requestLog.orgId, this.orgId), lt(schema.requestLog.createdAt, cutoff)));
    await this.db.execute(
      sql`delete from request_log where id <= (select id from request_log order by id desc offset ${MAX_ROWS} limit 1)`,
    );
  }

  start() {
    const run = () => void this.prune().catch(() => undefined);
    run();
    this.pruneTimer = setInterval(run, 3600_000);
    this.pruneTimer.unref();
  }

  async stop() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    await this.flush();
  }
}
