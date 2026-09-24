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
