import { execFile } from 'node:child_process';
import { uptime } from 'node:os';
import { join } from 'node:path';
import {
  SERVICE_ACTIONS,
  type ServiceAction,
  type ServiceRun,
  type SystemServiceId,
  type SystemServiceState,
  type SystemServiceView,
  type SystemServicesView,
  type UpdateRun,
} from '@atlas/shared';
import { HttpError } from '../errors.js';
import { ageOf, isServiceRequest, pendingRequest, readJson, writeRequest } from './helper-inbox.js';

// The helper starts within seconds and its actions take a minute at most.
const REQUEST_STALE_MS = 2 * 60 * 1000;
const RUNNING_STALE_MS = 10 * 60 * 1000;
// systemd stops starting a unit that is started too often (five times in ten seconds unless the unit says
// otherwise), and takes the watcher that starts it down too. Spacing requests keeps well clear of that.
export const SERVICE_COOLDOWN_MS = 5000;

/** What `systemctl show` says about one unit, or null when it couldn't be asked. */
export type ShowUnit = (unit: string) => Promise<Record<string, string> | null>;

// The units the Linux installer sets up. The names are fixed here; nothing from a request reaches systemctl.
const UNITS: { id: SystemServiceId; name: string; unit: string; restart: ServiceAction | null }[] = [
  { id: 'atlas', name: 'Atlas', unit: 'msp-atlas.service', restart: 'restart-atlas' },
  { id: 'proxy', name: 'Web proxy', unit: 'caddy.service', restart: 'restart-proxy' },
  { id: 'database', name: 'Database', unit: 'postgresql.service', restart: 'restart-database' },
  { id: 'updater', name: 'Updater', unit: 'msp-atlas-updater.path', restart: null },
];
const PROPERTIES = 'LoadState,ActiveState,SubState,ActiveEnterTimestampMonotonic';

/**
 * Asks systemd about a unit. Reading a unit's state needs no privileges, and works from inside the restrictions
 * msp-atlas.service runs under.
 */
export const systemctlShow: ShowUnit = (unit) =>
  new Promise((resolve) => {
    execFile(
      'systemctl',
      ['show', unit, '--no-pager', `--property=${PROPERTIES}`],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const shown: Record<string, string> = {};
        for (const line of String(stdout).split('\n')) {
          const at = line.indexOf('=');
          if (at > 0) shown[line.slice(0, at)] = line.slice(at + 1).trim();
        }
        resolve(shown);
      },
    );
  });

function stateOf(shown: Record<string, string> | null): SystemServiceState {
  if (!shown) return 'unknown';
  if (shown.LoadState === 'not-found') return 'missing';
  switch (shown.ActiveState) {
    case 'active':
      return 'running';
    case 'activating':
    case 'reloading':
      return 'starting';
    case 'failed':
      return 'failed';
    case 'inactive':
    case 'deactivating':
      return 'stopped';
    default:
      return 'unknown';
  }
}

const IDLE: ServiceRun = {
  state: 'idle',
  action: null,
  requestedBy: null,
  requestedAt: null,
  finishedAt: null,
  message: null,
};
const isAction = (value: unknown): value is ServiceAction => SERVICE_ACTIONS.includes(value as ServiceAction);

/**
 * The services Atlas runs on (the application, its web proxy, its database, and the updater), and the few things
 * an administrator may do to them: restart one, or repair the installation. Atlas can't do any of it itself. It
 * reads their state from systemd, and writes a request naming one action for the server's root helper, which
 * carries out only the actions it knows (deploy/linux/atlas-updater.sh) and says how each went.
 */
export class SystemServices {
  constructor(
    private readonly options: {
      /** The folder shared with the root helper. Without it this server has no helper, and nothing can be done. */
      dir?: string;
      /** The update in progress, if any: the helper does one thing at a time. */
      updates: { run(): Promise<UpdateRun> };
      show?: ShowUnit;
      now?: () => number;
      /** Seconds since the server started. */
      uptime?: () => number;
    },
  ) {}

  private now() {
    return (this.options.now ?? Date.now)();
  }

  get canAct() {
    return Boolean(this.options.dir);
  }

  /** Each service's state. Empty where there is no helper: those installs aren't run by systemd units we know. */
  async services(): Promise<SystemServiceView[]> {
    if (!this.canAct) return [];
    const show = this.options.show ?? systemctlShow;
    const sinceBoot = (this.options.uptime ?? uptime)() * 1000;
    return Promise.all(
      UNITS.map(async ({ id, name, unit, restart }) => {
        const shown = await show(unit);
        const state = stateOf(shown);
        // systemd counts the start time in microseconds since the server started.
        const started = Number(shown?.ActiveEnterTimestampMonotonic);
        const since =
          state === 'running' && started > 0 && started / 1000 <= sinceBoot
            ? new Date(this.now() - (sinceBoot - started / 1000)).toISOString()
            : null;
        return { id, name, unit, state, since, restart };
      }),
    );
  }

  /** The last action, or the one in progress. */
  async run(): Promise<ServiceRun> {
    const dir = this.options.dir;
    if (!dir) return IDLE;
    const status = await readJson(join(dir, 'service.json'));
    const waiting = await pendingRequest(dir);
    const request = isServiceRequest(waiting) ? waiting : null;
    const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : null);
    const action = (v: unknown) => (isAction(v) ? v : null);
    // The helper refreshes updatedAt as it goes, so a "running" this old was left by a run that was killed.
    const runningAge = ageOf(status?.updatedAt, this.now()) ?? ageOf(status?.requestedAt, this.now());
    const staleRunning = status?.state === 'running' && runningAge !== null && runningAge > RUNNING_STALE_MS;
    if (request && !(status?.state === 'running' && !staleRunning)) {
      const run: ServiceRun = {
        ...IDLE,
        state: 'requested',
        action: action(request.action),
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
      const run: ServiceRun = {
        state: status.state as ServiceRun['state'],
        action: action(status.action),
        requestedBy: text(status.requestedBy),
        requestedAt: text(status.requestedAt),
        finishedAt: text(status.finishedAt),
        message: text(status.message),
      };
      if (staleRunning)
        return { ...run, state: 'failed', message: 'That stopped without finishing. Check the services below.' };
      return run;
    }
    return IDLE;
  }

  async overview(databaseReachable: boolean): Promise<SystemServicesView> {
    const [services, run] = await Promise.all([this.services(), this.run()]);
    return { canAct: this.canAct, databaseReachable, services, run };
  }

  /** Asks the helper to carry out one of the actions it knows. */
  async request(action: unknown, requestedBy: string): Promise<ServiceRun> {
    const dir = this.options.dir;
    if (!dir)
      throw new HttpError(
        409,
        'This server has no helper to do that. Restart the service with your deployment method.',
      );
    if (!isAction(action)) throw new HttpError(400, 'Choose what to do.');
    const update = await this.options.updates.run();
    if (update.state === 'requested' || update.state === 'running')
      throw new HttpError(409, 'An update is in progress. Wait for it to finish.');
    const run = await this.run();
    if (run.state === 'requested' || run.state === 'running')
      throw new HttpError(409, 'The server is already doing something. Wait for it to finish.');
    const since = ageOf(run.requestedAt, this.now());
    if (since !== null && since >= 0 && since < SERVICE_COOLDOWN_MS)
      throw new HttpError(409, 'The server has just done something. Give it a few seconds, then try again.');
    const body = { kind: 'service', action, requestedBy, requestedAt: new Date(this.now()).toISOString() };
    await writeRequest(dir, body);
    return { ...IDLE, state: 'requested', action, requestedBy, requestedAt: body.requestedAt };
  }
}
