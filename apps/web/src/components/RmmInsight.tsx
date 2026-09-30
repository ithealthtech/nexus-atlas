import { useQuery } from '@tanstack/react-query';
import type { RmmDeviceInsight } from '@atlas/shared';
import { Badge, Card, CardHeader, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

// Under this much free space a disk is flagged.
const LOW_DISK_PERCENT = 10;

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 1 : 0)} GB`;

/** A small line of the day's samples (0 to 100 percent). */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 28;
  const points = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / 100) * h}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-7 w-28 text-primary" role="img" aria-label={label}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Meter({ percent, warn }: { percent: number; warn?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div
        className={cn('h-full rounded-full', warn ? 'bg-danger' : 'bg-primary')}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

/** Resource use, RMM device groups, and effective policy for a device synced from ConnectWise RMM. */
export function RmmInsightPanel({ assetId }: { assetId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['rmm-insight', assetId],
    queryFn: () => api<{ insight: RmmDeviceInsight | null }>(`/assets/${assetId}/rmm-insight`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (isLoading)
    return (
      <Card>
        <CardHeader title="ConnectWise RMM" />
        <Skeleton className="m-5 h-24" />
      </Card>
    );
  const insight = data?.insight;
  // Not an RMM device (or RMM isn't connected): nothing to show.
  if (!insight && !error) return null;
  return (
    <Card>
      <CardHeader title="ConnectWise RMM" description="Read live from the RMM." />
      <div className="space-y-4 px-5 py-4 text-sm">
        {error && <p className="text-muted">{(error as Error).message}</p>}
        {insight && (
          <>
            {insight.disks.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted">Disks</h3>
                {insight.disks.map((d) => {
                  const freePercent = (d.freeBytes / d.totalBytes) * 100;
                  const low = freePercent < LOW_DISK_PERCENT;
                  return (
                    <div key={d.name} className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{d.name}</span>
                        <span className={cn('text-xs', low ? 'text-danger' : 'text-muted')}>
                          {gb(d.freeBytes)} free of {gb(d.totalBytes)}
                          {low && (
                            <Badge tone="danger" className="ml-2">
                              Low disk
                            </Badge>
                          )}
                        </span>
                      </div>
                      <Meter percent={100 - freePercent} warn={low} />
                    </div>
                  );
                })}
              </section>
            )}
            {(insight.cpu || insight.memory) && (
              <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                {insight.cpu && (
                  <div>
                    <h3 className="text-xs font-medium text-muted">CPU</h3>
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {insight.cpu.percent}% now · peak {insight.cpu.peakPercent}% today
                      </span>
                      <Sparkline values={insight.cpu.samples} label="CPU use over the last day" />
                    </div>
                  </div>
                )}
                {insight.memory && (
                  <div>
                    <h3 className="text-xs font-medium text-muted">Memory ({gb(insight.memory.totalBytes)})</h3>
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {insight.memory.percent}% now · peak {insight.memory.peakPercent}% today
                      </span>
                      <Sparkline values={insight.memory.samples} label="Memory use over the last day" />
                    </div>
                  </div>
                )}
              </section>
            )}
            {insight.groups && (
              <section>
                <h3 className="text-xs font-medium text-muted">Device groups</h3>
                {insight.groups.length ? (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {insight.groups.map((g) => (
                      <Badge key={g}>{g}</Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted">In no device groups.</p>
                )}
              </section>
            )}
            {insight.policies && insight.policies.length > 0 && (
              <section>
                <h3 className="text-xs font-medium text-muted">Effective policy</h3>
                <ul className="mt-1 space-y-1">
                  {insight.policies.map((p) => (
                    <li key={`${p.name}|${p.level}`} className="flex justify-between gap-2">
                      <span>
                        {p.name}
                        {p.level && <span className="text-muted"> · {p.level}</span>}
                      </span>
                      <span className="text-xs text-muted">
                        {p.settings} setting{p.settings === 1 ? '' : 's'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!insight.disks.length && !insight.cpu && !insight.memory && !insight.groups && !insight.policies && (
              <p className="text-muted">ConnectWise has no usage, group, or policy data for this device yet.</p>
            )}
            {insight.notes.map((n) => (
              <p key={n} className="text-xs text-muted">
                {n}
              </p>
            ))}
          </>
        )}
      </div>
    </Card>
  );
}
