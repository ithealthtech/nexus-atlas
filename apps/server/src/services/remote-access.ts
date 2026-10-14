import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ACCESS_MODES,
  remoteAccessRequestSchema,
  type AccessMode,
  type AccessRun,
  type RemoteAccessView,
  type ServiceRun,
  type UpdateRun,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { ageOf, pendingRequest, readJson, writeRequest } from './helper-inbox.js';

// Changing the address can install a tunnel agent, so it may take a few minutes.
const REQUEST_STALE_MS = 2 * 60 * 1000;
const RUNNING_STALE_MS = 15 * 60 * 1000;

const IDLE: AccessRun = { state: 'idle', requestedBy: null, requestedAt: null, finishedAt: null, message: null };

/** Reads access.conf, which atlas-access writes as KEY=value lines. Read as data, never run. */
export function parseAccessConf(text: string) {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  const mode = ACCESS_MODES.includes(values.MODE as AccessMode) ? (values.MODE as AccessMode) : null;
  return {
    mode,
    trusted: (values.TRUSTED ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    funnel: values.FUNNEL === 'yes',
  };
}

/**
 * How people reach Atlas, and changing it. Atlas can't change it itself: the settings and the web proxy belong to
 * root. It writes a request for the server's root helper, which checks every field and runs atlas-access
 * (deploy/linux/atlas-access.sh), the same script the installer uses.
 */
export class RemoteAccess {
  constructor(
    private readonly options: {
      /** The folder shared with the root helper. Without it this server has no helper. */
      dir?: string;
      /** Where the installer keeps Atlas's settings (default /etc/msp-atlas). */
      confDir?: string;
      publicUrl: string;
      /** The helper does one thing at a time. */
      updates: { run(): Promise<UpdateRun> };
      services: { run(): Promise<ServiceRun> };
      now?: () => number;
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private get confDir() {
    return this.options.confDir ?? '/etc/msp-atlas';
  }

  get canAct() {
    return Boolean(this.options.dir);
  }

  /** The last change, or the one in progress. */
  async run(): Promise<AccessRun> {
    const dir = this.options.dir;
    if (!dir) return IDLE;
    const status = await readJson(join(dir, 'access.json'));
    const waiting = await pendingRequest(dir);
    const request = waiting?.kind === 'access' ? waiting : null;
    const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : null);
    const runningAge = ageOf(status?.updatedAt, this.now()) ?? ageOf(status?.requestedAt, this.now());
    const staleRunning = status?.state === 'running' && runningAge !== null && runningAge > RUNNING_STALE_MS;
    if (request && !(status?.state === 'running' && !staleRunning)) {
      const run: AccessRun = {
        ...IDLE,
        state: 'requested',
        requestedBy: text(request.requestedBy),
        requestedAt: text(request.requestedAt),
      };
      if ((ageOf(request.requestedAt, this.now()) ?? Infinity) > REQUEST_STALE_MS)
        return {
          ...run,
          state: 'failed',
          message:
            "The server's helper didn't pick this up. On the server, run: sudo systemctl restart msp-atlas-updater.path",
        };
      return run;
    }
    const states = ['running', 'succeeded', 'failed'] as const;
    if (status && states.includes(status.state as (typeof states)[number])) {
      const run: AccessRun = {
        state: status.state as AccessRun['state'],
        requestedBy: text(status.requestedBy),
        requestedAt: text(status.requestedAt),
        finishedAt: text(status.finishedAt),
        message: text(status.message),
      };
      if (staleRunning) return { ...run, state: 'failed', message: 'That stopped without finishing.' };
      return run;
    }
    return IDLE;
  }

  async view(): Promise<RemoteAccessView> {
    const run = await this.run();
    if (!this.canAct)
      return {
        canAct: false,
        mode: null,
        publicUrl: this.options.publicUrl,
        trusted: [],
        funnel: false,
        hasTunnelToken: false,
        run,
      };
    let saved: ReturnType<typeof parseAccessConf> = { mode: null, trusted: [], funnel: false };
    try {
      saved = parseAccessConf(await readFile(join(this.confDir, 'access.conf'), 'utf8'));
    } catch {
      // No saved choice: the installer's own setup, which is direct.
    }
    const hasTunnelToken = await access(join(this.confDir, 'cloudflared.env')).then(
      () => true,
      () => false,
    );
    return {
      canAct: true,
      mode: saved.mode ?? 'direct',
      publicUrl: this.options.publicUrl,
      trusted: saved.trusted,
      funnel: saved.funnel,
      hasTunnelToken,
      run,
    };
  }

  /** Checks the choice and asks the helper to apply it. */
  async request(body: unknown, requestedBy: string): Promise<AccessRun> {
    const dir = this.options.dir;
    if (!dir)
      throw new HttpError(
        409,
        "This server has no helper to do that. Set PUBLIC_URL and TRUST_PROXY in Atlas's settings instead.",
      );
    const parsed = remoteAccessRequestSchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Check the settings.');
    const choice = parsed.data;
    if (choice.mode === 'cloudflare' && !choice.cloudflareToken && !(await this.view()).hasTunnelToken)
      throw new HttpError(400, "Paste the tunnel's token from the Cloudflare dashboard.");
    const [update, service, run] = await Promise.all([
      this.options.updates.run(),
      this.options.services.run(),
      this.run(),
    ]);
    for (const busy of [update, service, run])
      if (busy.state === 'requested' || busy.state === 'running')
        throw new HttpError(409, 'The server is already doing something. Wait for it to finish.');
    const requestedAt = new Date(this.now()).toISOString();
    await writeRequest(dir, {
      kind: 'access',
      mode: choice.mode,
      ...(choice.mode !== 'tailscale' && { publicUrl: choice.publicUrl }),
      ...(choice.mode === 'proxy' && { trusted: choice.trusted!.join(',') }),
      ...(choice.mode === 'tailscale' && { funnel: Boolean(choice.funnel) }),
      ...(choice.mode === 'cloudflare' && choice.cloudflareToken && { cloudflareToken: choice.cloudflareToken }),
      ...(choice.mode === 'tailscale' && choice.tailscaleAuthKey && { tailscaleAuthKey: choice.tailscaleAuthKey }),
      requestedBy,
      requestedAt,
    });
    return { ...IDLE, state: 'requested', requestedBy, requestedAt };
  }
}
