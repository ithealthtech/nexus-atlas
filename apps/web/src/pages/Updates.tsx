import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpCircle, CheckCircle2, ExternalLink, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ReleaseView, UpdateInfo, UpdateRun } from '@atlas/shared';
import { Badge, Button, Card, CardHeader, PageHeader, Skeleton, useToast } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';

const RUN_TEXT: Record<UpdateRun['state'], string> = {
  idle: '',
  requested: 'Waiting for the server updater to start…',
  running: 'Installing. Atlas restarts when it finishes, and this page reconnects.',
  succeeded: 'Update installed.',
  failed: 'The update failed. Atlas kept running the previous version.',
};

export function Updates() {
  const client = useQueryClient();
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: () => api<UpdateInfo>('/updates'),
    // Follow an update while it runs; Atlas restarts partway, so failed requests just retry.
    refetchInterval: (q) => (['requested', 'running'].includes(q.state.data?.run.state ?? '') ? 3000 : false),
    retry: true,
  });
  const u = updates.data;
  const check = async () => {
    setChecking(true);
    try {
      client.setQueryData(['updates'], await api<UpdateInfo>('/updates/check', { method: 'POST', body: {} }));
    } catch (error) {
      toast((error as ApiError).message, 'error');
    } finally {
      setChecking(false);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Updates"
        description="New Atlas releases from GitHub. Installing one backs up first, then restarts Atlas."
      />
      {!u ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={u.available.length ? 'An update is available' : 'Atlas is up to date'}
              description={
                u.checkError ??
                `You're running ${u.current}. Checked ${u.checkedAt ? relativeTime(u.checkedAt) : 'never'} against ${u.repo}.`
              }
              actions={
                <Button variant="secondary" onClick={() => void check()} loading={checking}>
                  <RefreshCw /> Check now
                </Button>
              }
            />
            {u.run.state !== 'idle' && <RunBanner run={u.run} />}
            {!u.canApply && u.available.length > 0 && (
              <p className="border-t border-border px-5 py-3.5 text-sm text-text-2">
                This server doesn't have the updater installed, so updates can't be installed from here. Install the new
                release the way Atlas was deployed (see docs/DEPLOYMENT.md).
              </p>
            )}
          </Card>
          {u.available.map((r, i) => (
            <ReleaseCard key={r.tag} release={r} latest={i === 0} info={u} />
          ))}
        </div>
      )}
    </>
  );
}

function RunBanner({ run }: { run: UpdateRun }) {
  const busy = run.state === 'requested' || run.state === 'running';
  const Icon = busy ? Loader2 : run.state === 'failed' ? TriangleAlert : CheckCircle2;
  return (
    <div className="flex items-start gap-3 border-t border-border px-5 py-3.5 text-sm" role="status">
      <Icon className={busy ? 'mt-0.5 size-4 animate-spin' : 'mt-0.5 size-4'} aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">
          {run.tag} · {RUN_TEXT[run.state]}
        </p>
        <p className="mt-0.5 text-text-2">
          {run.requestedBy && `Requested by ${run.requestedBy}`}
          {run.requestedAt && ` ${relativeTime(run.requestedAt)}`}
          {run.finishedAt && ` · finished ${formatDateTime(run.finishedAt)}`}
        </p>
        {run.message && <p className="mt-1 break-words whitespace-pre-wrap text-text-2">{run.message}</p>}
      </div>
    </div>
  );
}

function ReleaseCard({ release, latest, info }: { release: ReleaseView; latest: boolean; info: UpdateInfo }) {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const inProgress = info.run.state === 'requested' || info.run.state === 'running';
  const install = async () => {
    if (!confirm(`Install ${release.tag}? Atlas backs up, then restarts; people are signed out briefly.`)) return;
    setBusy(true);
    try {
      await api('/updates/apply', { method: 'POST', body: { tag: release.tag } });
      toast(`Update to ${release.tag} requested.`);
      await client.invalidateQueries({ queryKey: ['updates'] });
    } catch (error) {
      toast((error as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {release.name} {latest && <Badge tone="success">Latest</Badge>}
          </span>
        }
        description={release.publishedAt ? `Published ${formatDateTime(release.publishedAt)}` : undefined}
        actions={
          <div className="flex gap-2">
            {release.url && (
              <a
                className="inline-flex items-center gap-1 text-sm text-text-2 hover:underline"
                href={release.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                On GitHub <ExternalLink className="size-3.5" aria-hidden />
              </a>
            )}
            {info.canApply && (
              <Button onClick={() => void install()} loading={busy} disabled={inProgress}>
                <ArrowUpCircle /> Install {release.tag}
              </Button>
            )}
          </div>
        }
      />
      {release.notes && (
        <div className="max-h-96 overflow-auto border-t border-border px-5 py-4 text-sm break-words whitespace-pre-wrap text-text-2">
          {release.notes}
        </div>
      )}
    </Card>
  );
}
