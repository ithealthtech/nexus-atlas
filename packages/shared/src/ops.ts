import { z } from 'zod';

// Operations: backups and the system status page, and erasing all data.

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

// ---------- erase all data (owner only) ----------
export interface EraseStatus {
  pending: {
    requestedAt: string;
    requestedByName: string;
    /** When the owner can confirm; before then it can only be cancelled. */
    confirmableAt: string;
    expiresAt: string;
    confirmable: boolean;
  } | null;
}
export const eraseRequestSchema = z.object({
  password: z.string().min(1, 'Enter your password.').max(1024),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'),
  /** The organization's name, typed exactly. */
  confirmName: z.string().max(200),
});
export const eraseConfirmSchema = z.object({ confirmName: z.string().max(200) });

// ---------- password health ----------
export const PASSWORD_ISSUES = ['breached', 'weak', 'reused', 'overdue', 'expired', 'old'] as const;
export type PasswordIssue = (typeof PASSWORD_ISSUES)[number];
export const PASSWORD_ISSUE_LABELS: Record<PasswordIssue, string> = {
  breached: 'Found in a data breach',
  weak: 'Weak',
  reused: 'Reused',
  overdue: 'Rotation overdue',
  expired: 'Account expired',
  old: 'Not changed in over a year',
};
export interface PasswordHealthItem {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  category: string;
  issues: PasswordIssue[];
}
export interface PasswordHealthReport {
  /** Percent of passwords with no issue, 0–100; null when there are none. */
  score: number | null;
  total: number;
  counts: Record<PasswordIssue, number>;
  clients: { id: string; name: string; total: number; withIssues: number; score: number | null }[];
  /** Only passwords with at least one issue, worst first. */
  items: PasswordHealthItem[];
  breach: { enabled: boolean; checked: number; unchecked: number; lastRunAt: string | null };
}
export const passwordHealthSettingsSchema = z.object({ breachChecks: z.boolean().default(true) });
export type PasswordHealthSettings = z.infer<typeof passwordHealthSettingsSchema>;

// ---------- request log (verbose logging) ----------
export const requestLogSettingsSchema = z.object({
  /** Record every outbound integration call and every request to Atlas's own API. Off by default. */
  enabled: z.boolean().default(false),
  /** Record requests to Atlas's own API as well as outbound calls. */
  incoming: z.boolean().default(true),
  /** Entries older than this are deleted. */
  retentionDays: z.number().int().min(1).max(90).default(7),
});
export type RequestLogSettings = z.infer<typeof requestLogSettingsSchema>;
export const REQUEST_LOG_DIRECTIONS = ['outbound', 'inbound'] as const;
export type RequestLogDirection = (typeof REQUEST_LOG_DIRECTIONS)[number];
export const REQUEST_LOG_OUTCOMES = ['ok', 'error'] as const;
export interface RequestLogEntry {
  id: number;
  at: string;
  direction: RequestLogDirection;
  /** The integration (ConnectWise, Hudu, Microsoft, …) for outbound calls; "Atlas" for incoming requests. */
  service: string;
  method: string;
  url: string;
  /** 0 when the request failed before any response (a network error or timeout). */
  status: number;
  durationMs: number;
  /** Who made an incoming request, or the network error of an outbound one. */
  actor: string;
  error: string;
}
export interface RequestLogDetail extends RequestLogEntry {
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
}
export interface RequestLogPage {
  settings: RequestLogSettings;
  entries: RequestLogEntry[];
  /** Services seen in the log, for the filter. */
  services: string[];
  /** Passed back as `before` for the next (older) page; null on the last page. */
  nextBefore: number | null;
}
