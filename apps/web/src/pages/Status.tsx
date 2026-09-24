import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Database,
  Download,
  HardDrive,
  KeyRound,
  Mail,
  Save,
  ScrollText,
} from 'lucide-react';
import type { BackupRunView, StatusCheck, SystemStatus } from '@atlas/shared';
import { Badge, Button, Card, CardHeader, PageHeader, Skeleton, useToast } from '@/components/ui';
import { api, download, type ApiError } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export const formatBytes = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return 'Unknown';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
};

const CHECK_STYLE: Record<StatusCheck['level'], { icon: typeof CheckCircle2; tone: string; label: string }> = {
  ok: { icon: CheckCircle2, tone: 'bg-success-soft text-success', label: 'OK' },
  warn: { icon: CircleAlert, tone: 'bg-warning-soft text-warning', label: 'Needs attention' },
  error: { icon: AlertTriangle, tone: 'bg-danger-soft text-danger', label: 'Problem' },
};

export function Status() {
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api<SystemStatus>('/status'),
    // Follow a running backup until it finishes.
    refetchInterval: (q) => (q.state.data?.backups.runs[0]?.status === 'running' ? 1500 : 60_000),
  });
  const s = status.data;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="System status"
        description="Health of this Atlas installation: backups, storage, email, and security checks."
      />
      {!s ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <div className="space-y-6">
          <Checks checks={s.checks} />
          <Backups status={s} />
          <Card>
            <CardHeader title="Installation" />
            <dl className="grid gap-x-8 gap-y-4 p-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Fact
                icon={Activity}
                label="Atlas version"
                value={s.version}
                hint={`Running since ${formatDateTime(s.startedAt)}`}
              />
              <Fact
                icon={Database}
                label="Database"
                value={`PostgreSQL ${s.database.version.split(' ')[0]}`}
                hint={`${formatBytes(s.database.sizeBytes)} · ${s.database.migrationsApplied} of ${s.database.migrationsAvailable} updates applied`}
              />
              <Fact
                icon={HardDrive}
                label="Attachments"
                value={`${s.storage.attachments} files · ${formatBytes(s.storage.attachmentBytes)}`}
                hint={`${formatBytes(s.storage.freeBytes)} free in ${s.storage.dataDir}`}
              />
              <Fact
                icon={Mail}
                label="Email"
                value={s.email.enabled ? 'On' : 'Off'}
                hint={s.email.enabled ? s.email.host : 'Set it up under Settings → Email.'}
              />
              <Fact
                icon={KeyRound}
                label="Master key"
                value={s.keys.current}
                hint={
                  s.keys.loaded > 1 ? `${s.keys.loaded - 1} older key(s) also loaded` : 'Only the current key is loaded'
                }
              />
              <Fact
                icon={ScrollText}
                label="Security log"
                value={`${s.audit.events} events`}
                hint={
                  s.audit.lastCheckpointAt ? `Checked ${relativeTime(s.audit.lastCheckpointAt)}` : 'Not checked yet'
                }
              />
              <Fact
                icon={Activity}
                label="Background tasks"
                value={s.background.lastRunAt ? relativeTime(s.background.lastRunAt) : 'Not run yet'}
                hint="Alerts, digests, log retention, and cleanup run every 10 minutes."
              />
              <Fact icon={Activity} label="Server" value={s.platform} hint={`Node.js ${s.node} · ${s.publicUrl}`} />
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}

function Checks({ checks }: { checks: StatusCheck[] }) {
  const worst = checks.find((c) => c.level !== 'ok');
  return (
    <Card>
      <CardHeader
        title={worst ? 'Some things need attention' : 'Everything looks good'}
        description="Checked each time this page loads."
      />
      <ul className="divide-y divide-border">
        {checks.map((c) => {
          const { icon: Icon, tone, label } = CHECK_STYLE[c.level];
          return (
            <li key={c.id} className="flex items-start gap-3 px-5 py-3.5 text-sm">
              <span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg', tone)}>
                <Icon className="size-4" aria-label={label} />
              </span>
              <div className="min-w-0">
                <p className="font-semibold">{c.title}</p>
                <p className="mt-0.5 text-text-2">{c.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

const RUN_TONE: Record<BackupRunView['status'], 'success' | 'danger' | 'info'> = {
  done: 'success',
  failed: 'danger',
  running: 'info',
};
const RUN_LABEL: Record<BackupRunView['status'], string> = { done: 'Done', failed: 'Failed', running: 'Running' };

function Backups({ status }: { status: SystemStatus }) {
  const toast = useToast();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { backups } = status;
  const running = backups.runs[0]?.status === 'running';
  const start = async () => {
    setBusy(true);
    try {
      await api('/backups', { method: 'POST', body: {} });
      toast('Backup started. This page updates when it finishes.');
      await client.invalidateQueries({ queryKey: ['status'] });
    } catch (error) {
      toast((error as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Backups"
        description={
          backups.enabled
            ? `Encrypted with the master key. Daily after ${String(backups.hour).padStart(2, '0')}:00, keeping the newest ${backups.keep}.`
            : 'Automatic backups are off (ATLAS_BACKUP_ENABLED=false).'
        }
        actions={
          <Button onClick={() => void start()} loading={busy} disabled={running}>
            <Save /> {running ? 'Backing up…' : 'Back up now'}
          </Button>
        }
      />
      <dl className="grid gap-x-8 gap-y-4 border-b border-border p-5 text-sm sm:grid-cols-3">
        <Fact
          icon={CheckCircle2}
          label="Last good backup"
          value={backups.lastSuccessAt ? relativeTime(backups.lastSuccessAt) : 'None yet'}
          hint={backups.lastSuccessAt ? formatDateTime(backups.lastSuccessAt) : undefined}
        />
        <Fact
          icon={Activity}
          label="Next scheduled"
          value={backups.nextAt ? formatDateTime(backups.nextAt) : 'Not scheduled'}
        />
        <Fact
          icon={HardDrive}
          label="Backup folder"
          value={formatBytes(backups.freeBytes) + ' free'}
          hint={backups.dir}
        />
      </dl>
      {!backups.runs.length ? (
        <p className="px-5 py-4 text-sm text-muted">No backups yet.</p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Backup history</caption>
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Started</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">By</th>
                <th className="px-3 py-2.5 font-medium">Size</th>
                <th className="px-5 py-2.5 font-medium">
                  <span className="sr-only">Download</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {backups.runs.map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-2.5 whitespace-nowrap">{formatDateTime(r.createdAt)}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Badge>
                    {r.error && <p className="mt-1 text-xs text-danger">{r.error}</p>}
                  </td>
                  <td className="px-3 py-2.5 text-text-2">{r.startedByName}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap text-text-2">
                    {r.status === 'done' ? `${formatBytes(r.size)} · ${r.rows} rows · ${r.files} files` : '—'}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    {r.status === 'done' && r.fileName && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Download backup from ${formatDateTime(r.createdAt)}`}
                        onClick={() =>
                          void download(`/backups/${r.id}/download`, r.fileName!).catch((error: ApiError) =>
                            toast(error.message, 'error'),
                          )
                        }
                      >
                        <Download /> Download
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-border px-5 py-3 text-xs text-muted">
        Restoring needs the master key the backup was made with. Keep a copy of the key somewhere other than the
        backups. To restore, stop Atlas and run <code>npm run restore -w @atlas/server -- &lt;file&gt;</code>; see the
        deployment guide.
      </p>
    </Card>
  );
}

function Fact({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted">
        <Icon className="size-3.5" aria-hidden /> {label}
      </dt>
      <dd className="mt-1 font-semibold break-words">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs break-words text-muted">{hint}</dd>}
    </div>
  );
}
