import { createHmac } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { and, asc, count, eq, gt, sql } from 'drizzle-orm';
import { schema, type Database, type DatabaseHandle } from '@atlas/db';
import type { SiemEvent, SiemSettingsView } from '@atlas/shared';
import { HttpError } from '../errors.js';
import type { SettingsService, SiemConfig } from './settings.js';

const BATCH = 500;
/** Batches per log per pass, so one busy organization can't hold up the loop; the rest goes on the next pass. */
const MAX_BATCHES = 20;
const TIMEOUT_MS = 15_000;
// RFC 5424: facility 13 is "log audit"; severity 4 is warning, 6 informational.
const FACILITY = 13;

/** Delivers a batch of events. Tests replace it; the default speaks HTTPS webhooks and syslog. */
export type SiemSender = (config: SiemConfig, events: SiemEvent[], hostname: string) => Promise<void>;

/** One RFC 5424 syslog line: the event as JSON in the message part. */
export function syslogLine(event: SiemEvent, hostname: string) {
  const severity = /fail|lock|denied|mismatch|erase/i.test(event.action) ? 4 : 6;
  const host = hostname.replace(/[^\x21-\x7e]/g, '').slice(0, 255) || '-';
  return `<${FACILITY * 8 + severity}>1 ${event.time} ${host} msp-atlas - ${event.log} - ${JSON.stringify(event)}`;
}

export const signBody = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

async function sendWebhook(config: SiemConfig, events: SiemEvent[], fetcher: typeof fetch) {
  const body = JSON.stringify({ events });
  const response = await fetcher(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'MSP-Atlas',
      ...(config.secret ? { 'X-Atlas-Signature': signBody(config.secret, body) } : {}),
    },
    body,
    // A redirect could carry the log somewhere the administrator didn't choose.
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The webhook answered ${response.status} ${response.statusText}`.trim());
}

function sendSyslog(config: SiemConfig, lines: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (config.transport === 'udp') {
      const socket = dgram.createSocket(net.isIPv6(config.host) ? 'udp6' : 'udp4');
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('The syslog server did not respond in time.'));
      }, TIMEOUT_MS);
      let left = lines.length;
      const done = (error?: Error | null) => {
        if (error) {
          clearTimeout(timer);
          socket.close();
          return reject(error);
        }
        if (--left === 0) {
          clearTimeout(timer);
          socket.close();
          resolve();
        }
      };
      if (!left) return done();
      for (const line of lines) socket.send(Buffer.from(line), config.port, config.host, done);
      return;
    }
    // TCP and TLS use octet-counting framing (RFC 6587), so a message may contain newlines.
    const payload = lines.map((line) => `${Buffer.byteLength(line)} ${line}`).join('');
    const socket =
      config.transport === 'tls'
        ? tls.connect({
            host: config.host,
            port: config.port,
            servername: net.isIP(config.host) ? undefined : config.host,
            minVersion: 'TLSv1.2',
          })
        : net.connect({ host: config.host, port: config.port });
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('The syslog server did not respond in time.')));
    socket.once('error', reject);
    socket.once(config.transport === 'tls' ? 'secureConnect' : 'connect', () => socket.end(payload, () => resolve()));
  });
}

export const defaultSender =
  (fetcher: typeof fetch = fetch): SiemSender =>
  async (config, events, hostname) => {
    if (config.method === 'webhook') return sendWebhook(config, events, fetcher);
    return sendSyslog(
      config,
      events.map((e) => syslogLine(e, hostname)),
    );
  };

/**
 * Streams the security log and the vault access log to a SIEM, by HTTPS webhook (JSON, optionally signed) or syslog
 * (RFC 5424 over TLS, TCP, or UDP). Each log keeps a cursor, the last row delivered: a failed send is retried from there
 * on the next pass, so nothing is skipped, and a row may be sent twice only if the SIEM took it but the answer was lost.
 */
export class SiemForwarder {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: Database,
    /** For the lock, which must be taken and released on one connection. */
    private readonly pool: DatabaseHandle['pool'],
    private readonly settings: SettingsService,
    private readonly hostname: string,
    private readonly sender: SiemSender = defaultSender(),
  ) {}

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      // A lock of its own, so two servers don't both send, without waiting on the notifier's work. A session lock
      // belongs to one connection, so this one is held for the whole pass and released on it.
      const lock = await this.pool.connect();
      try {
        const { rows } = await lock.query<{ ok: boolean }>('select pg_try_advisory_lock(727279) as ok');
        if (!rows[0]?.ok) return;
        try {
          for (const org of await this.db.select({ id: schema.orgs.id }).from(schema.orgs))
            await this.forward(org.id).catch(() => undefined);
        } finally {
          await lock.query('select pg_advisory_unlock(727279)').catch(() => undefined);
        }
      } finally {
        lock.release();
      }
    } finally {
      this.running = false;
    }
  }

  /** The newest row of each log, where streaming starts when it is turned on. */
  async newest(orgId: string) {
    const [security] = await this.db
      .select({ id: sql<number>`coalesce(max(${schema.securityEvents.id}), 0)` })
      .from(schema.securityEvents)
      .where(eq(schema.securityEvents.orgId, orgId));
    const [vault] = await this.db
      .select({ id: sql<number>`coalesce(max(${schema.vaultAudit.id}), 0)` })
      .from(schema.vaultAudit)
      .where(eq(schema.vaultAudit.orgId, orgId));
    return { security: Number(security?.id ?? 0), vault: Number(vault?.id ?? 0) };
  }

  private async organization(orgId: string) {
    const [org] = await this.db.select({ name: schema.orgs.name }).from(schema.orgs).where(eq(schema.orgs.id, orgId));
    return org?.name ?? '';
  }

  private async rows(orgId: string, log: 'security' | 'vault', after: number, organization: string) {
    if (log === 'security') {
      const e = schema.securityEvents;
      const rows = await this.db
        .select()
        .from(e)
        .where(and(eq(e.orgId, orgId), gt(e.id, after)))
        .orderBy(asc(e.id))
        .limit(BATCH);
      return rows.map((r): SiemEvent => ({
        source: 'msp-atlas',
        log,
        id: String(r.id),
        time: r.createdAt.toISOString(),
        organization,
        actor: r.actor,
        action: r.action,
        detail: r.detail,
        ip: r.ip,
      }));
    }
    const a = schema.vaultAudit;
    const rows = await this.db
      .select({ a, client: schema.clients.name })
      .from(a)
      .leftJoin(schema.clients, eq(schema.clients.id, a.clientId))
      .where(and(eq(a.orgId, orgId), gt(a.id, after)))
      .orderBy(asc(a.id))
      .limit(BATCH);
    return rows.map(({ a: r, client }): SiemEvent => ({
      source: 'msp-atlas',
      log,
      id: String(r.id),
      time: r.createdAt.toISOString(),
      organization,
      actor: r.actorName,
      action: r.action,
      detail: '',
      ip: r.ip,
      client,
      password: r.passwordName,
      reason: r.reason,
    }));
  }

  /** Sends everything new since the last delivery. Stops at the first failure, which is recorded for the settings page. */
  async forward(orgId: string): Promise<{ sent: number; error: string | null }> {
    const config = await this.settings.siemConfig(orgId);
    if (!config?.enabled) return { sent: 0, error: null };
    const organization = await this.organization(orgId);
    let sent = 0;
    for (const log of ['security', 'vault'] as const) {
      if (!config[log]) continue;
      let cursor = config.cursor[log];
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const events = await this.rows(orgId, log, cursor, organization);
        if (!events.length) break;
        try {
          await this.sender(config, events, this.hostname);
        } catch (error) {
          const message = `Sending the ${log} log failed: ${(error as Error).message}`.slice(0, 300);
          await this.settings.patchSiem(orgId, { lastError: message });
          return { sent, error: message };
        }
        cursor = Number(events.at(-1)!.id);
        sent += events.length;
        await this.settings.patchSiem(orgId, {
          cursor: { ...config.cursor, [log]: cursor },
          lastSentAt: new Date().toISOString(),
          lastError: null,
        });
        if (events.length < BATCH) break;
      }
    }
    return { sent, error: null };
  }

  /** Sends one test event with the saved settings, whether or not streaming is on. It moves no cursor. */
  async test(orgId: string, actorName: string) {
    const config = await this.settings.siemConfig(orgId);
    if (!config || (config.method === 'webhook' ? !config.url : !config.host))
      throw new HttpError(409, 'Save where to send the logs first.');
    const event: SiemEvent = {
      source: 'msp-atlas',
      log: 'security',
      id: '0',
      time: new Date().toISOString(),
      organization: await this.organization(orgId),
      actor: actorName,
      action: 'SIEM test event',
      detail: 'Sent from Settings → Vault policies to check the connection.',
      ip: '',
    };
    try {
      await this.sender(config, [event], this.hostname);
    } catch (error) {
      throw new HttpError(502, `The test event was not delivered: ${(error as Error).message}`.slice(0, 400));
    }
  }

  async view(orgId: string): Promise<SiemSettingsView> {
    const stored = await this.settings.siem(orgId);
    const s = stored ?? {
      enabled: false,
      method: 'webhook' as const,
      url: '',
      secretSealed: null,
      host: '',
      port: 6514,
      transport: 'tls' as const,
      security: true,
      vault: true,
      cursor: { security: 0, vault: 0 },
      lastSentAt: null,
      lastError: null,
    };
    let pending = 0;
    if (s.enabled) {
      if (s.security) {
        const [row] = await this.db
          .select({ n: count() })
          .from(schema.securityEvents)
          .where(and(eq(schema.securityEvents.orgId, orgId), gt(schema.securityEvents.id, s.cursor.security)));
        pending += Number(row?.n ?? 0);
      }
      if (s.vault) {
        const [row] = await this.db
          .select({ n: count() })
          .from(schema.vaultAudit)
          .where(and(eq(schema.vaultAudit.orgId, orgId), gt(schema.vaultAudit.id, s.cursor.vault)));
        pending += Number(row?.n ?? 0);
      }
    }
    return {
      enabled: s.enabled,
      method: s.method,
      url: s.url,
      hasSecret: !!s.secretSealed,
      host: s.host,
      port: s.port,
      transport: s.transport,
      security: s.security,
      vault: s.vault,
      lastSentAt: s.lastSentAt,
      lastError: s.lastError,
      pending,
    };
  }
}
