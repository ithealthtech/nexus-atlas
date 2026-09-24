import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReleaseView, UpdateInfo, UpdateRun } from '@atlas/shared';
import { HttpError } from '../errors.js';

const TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const CACHE_MS = 60 * 60 * 1000;

/** Compares two x.y.z versions (a leading "v" is ignored). */
export function compareVersions(a: string, b: string) {
  const pa = TAG.exec(a);
  const pb = TAG.exec(b);
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  return 0;
}

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

const IDLE: UpdateRun = {
  state: 'idle',
  tag: null,
  requestedBy: null,
  requestedAt: null,
  finishedAt: null,
  message: null,
};

/**
 * Checks GitHub for newer releases and hands update requests to the root updater
 * (deploy/linux/atlas-updater.sh). Atlas itself never installs anything: it only writes
 * inbox/request.json, and the updater re-validates the tag before using it.
 */
export class UpdateService {
  private cache: { at: number; releases: ReleaseView[]; error: string | null } | null = null;

  constructor(
    private readonly options: {
      repo: string;
      current: string;
      dir?: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private async releases(force = false) {
    if (!force && this.cache && this.now() - this.cache.at < CACHE_MS) return this.cache;
    const doFetch = this.options.fetch ?? fetch;
    try {
      const res = await doFetch(`https://api.github.com/repos/${this.options.repo}/releases?per_page=20`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'msp-atlas-updater' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
      const list = (await res.json()) as GitHubRelease[];
      const releases = (Array.isArray(list) ? list : [])
        .filter((r) => !r.draft && !r.prerelease && typeof r.tag_name === 'string' && TAG.test(r.tag_name))
        .map((r) => ({
          tag: r.tag_name as string,
          version: (r.tag_name as string).replace(/^v/, ''),
          name: typeof r.name === 'string' && r.name ? r.name : (r.tag_name as string),
          notes: typeof r.body === 'string' ? r.body.slice(0, 20_000) : '',
          url: typeof r.html_url === 'string' ? r.html_url : '',
          publishedAt: typeof r.published_at === 'string' ? r.published_at : '',
        }))
        .sort((a, b) => compareVersions(b.tag, a.tag));
      this.cache = { at: this.now(), releases, error: null };
    } catch (error) {
      // Keep showing the last good list, but say the check failed.
      this.cache = {
        at: this.now(),
        releases: this.cache?.releases ?? [],
        error: `Couldn't check for updates: ${(error as Error).message}`,
      };
    }
    return this.cache;
  }

  async run(): Promise<UpdateRun> {
    const dir = this.options.dir;
    if (!dir) return IDLE;
    const status = await readJson(join(dir, 'status.json'));
    const request = await readJson(join(dir, 'inbox', 'request.json'));
    const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : null);
    const states = ['running', 'succeeded', 'failed'] as const;
    // A pending request that the updater hasn't picked up yet.
    if (request && !(status && status.state === 'running')) {
      return {
        ...IDLE,
        state: 'requested',
        tag: text(request.tag),
        requestedBy: text(request.requestedBy),
        requestedAt: text(request.requestedAt),
      };
    }
    if (status && states.includes(status.state as (typeof states)[number])) {
      return {
        state: status.state as UpdateRun['state'],
        tag: text(status.tag),
        requestedBy: text(status.requestedBy),
        requestedAt: text(status.requestedAt),
        finishedAt: text(status.finishedAt),
        message: text(status.message),
      };
    }
    return IDLE;
  }

  async info(force = false): Promise<UpdateInfo> {
    const { releases, error, at } = await this.releases(force);
    return {
      current: this.options.current,
      repo: this.options.repo,
      checkedAt: new Date(at).toISOString(),
      checkError: error,
      available: releases.filter((r) => compareVersions(r.tag, this.options.current) > 0),
      canApply: Boolean(this.options.dir),
      run: await this.run(),
    };
  }

  /** Asks the updater to install `tag`. Only a published release newer than this one is accepted. */
  async request(tag: string, requestedBy: string): Promise<UpdateRun> {
    const dir = this.options.dir;
    if (!dir)
      throw new HttpError(409, 'This server has no updater. Install the new release with your deployment method.');
    const run = await this.run();
    if (run.state === 'requested' || run.state === 'running')
      throw new HttpError(409, 'An update is already in progress.');
    const { releases } = await this.releases(true);
    const release = releases.find((r) => r.tag === tag);
    if (!release || compareVersions(release.tag, this.options.current) <= 0)
      throw new HttpError(400, 'Choose a published release newer than this version.');
    const body = { tag: release.tag, requestedBy, requestedAt: new Date(this.now()).toISOString() };
    // Atlas can write only to inbox/; status.json is the updater's, in a folder Atlas can only read.
    const inbox = join(dir, 'inbox');
    await mkdir(inbox, { recursive: true });
    const tmp = join(inbox, `.request-${process.pid}.json`);
    await writeFile(tmp, JSON.stringify(body), { mode: 0o640 });
    await rename(tmp, join(inbox, 'request.json'));
    return { ...IDLE, state: 'requested', tag: body.tag, requestedBy, requestedAt: body.requestedAt };
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
