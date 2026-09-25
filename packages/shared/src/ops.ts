// Operations: backups and the system status page.

export interface BackupRunView {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'done' | 'failed';
  fileName: string | null;
  size: number | null;
  rows: number | null;
  files: number | null;
  error: string | null;
  startedByName: string;
  createdAt: string;
  finishedAt: string | null;
}

export type StatusLevel = 'ok' | 'warn' | 'error';

export interface StatusCheck {
  id: string;
  level: StatusLevel;
  title: string;
  detail: string;
}

export interface SystemStatus {
  version: string;
  node: string;
  platform: string;
  startedAt: string;
  publicUrl: string;
  checks: StatusCheck[];
  database: {
    version: string;
    sizeBytes: number;
    migrationsApplied: number;
    migrationsAvailable: number;
  };
  storage: {
    dataDir: string;
    freeBytes: number | null;
    totalBytes: number | null;
    attachments: number;
    attachmentBytes: number;
  };
  backups: {
    enabled: boolean;
    dir: string;
    hour: number;
    keep: number;
    freeBytes: number | null;
    lastSuccessAt: string | null;
    nextAt: string | null;
    runs: BackupRunView[];
  };
  email: { enabled: boolean; host: string };
  keys: { current: string; loaded: number };
  audit: { events: number; lastCheckpointAt: string | null };
  background: { lastRunAt: string | null };
}

// Updates: newer Atlas releases from GitHub, and the server-side updater that installs them.

export interface ReleaseView {
  tag: string;
  version: string;
  name: string;
  notes: string;
  url: string;
  publishedAt: string;
}

export type UpdateState = 'idle' | 'requested' | 'running' | 'succeeded' | 'failed';

export interface UpdateRun {
  state: UpdateState;
  tag: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

export interface UpdateInfo {
  current: string;
  repo: string;
  checkedAt: string | null;
  /** Why the release list couldn't be fetched, if it couldn't. */
  checkError: string | null;
  /** Releases newer than the running version, newest first. */
  available: ReleaseView[];
  /** Whether this server has the updater installed (Linux installs from deploy/linux). */
  canApply: boolean;
  run: UpdateRun;
}
