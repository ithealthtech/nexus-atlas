import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The inbox Atlas shares with the server's root helper (deploy/linux/atlas-updater.sh). Atlas can write only
 * here, one request at a time, as inbox/request.json; the helper takes it out, checks every field itself, and
 * writes what happened to a file beside the inbox that Atlas can only read. An update and a service action use
 * the same inbox, so each has to know when the other's request is waiting.
 */
export async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The request waiting in the inbox, if the helper hasn't taken it yet. */
export const pendingRequest = (dir: string) => readJson(join(dir, 'inbox', 'request.json'));

/** Whether a request names a service action rather than an update. */
export const isServiceRequest = (request: Record<string, unknown> | null) => request?.kind === 'service';

/** Whether a request is an update. Updates came first, so theirs is the one request with no kind. */
export const isUpdateRequest = (request: Record<string, unknown> | null) =>
  Boolean(request) && request!.kind === undefined;

/** How long ago a time in a request or result was, or null when it isn't a time. */
export function ageOf(value: unknown, now: number): number | null {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isNaN(at) ? null : now - at;
}

/** Writes a request beside its final name and renames it into place, so the helper never reads half a file. */
export async function writeRequest(dir: string, body: Record<string, unknown>) {
  const inbox = join(dir, 'inbox');
  await mkdir(inbox, { recursive: true });
  const tmp = join(inbox, `.request-${process.pid}.json`);
  await writeFile(tmp, JSON.stringify(body), { mode: 0o640 });
  await rename(tmp, join(inbox, 'request.json'));
}
