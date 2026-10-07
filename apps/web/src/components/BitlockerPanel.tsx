import { useQuery } from '@tanstack/react-query';
import type { BitlockerDeviceView } from '@atlas/shared';
import { Badge, Card, CardHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { BitlockerStatusBadge } from '@/pages/BitlockerCollector';

/** What the BitLocker collector last reported for this asset's machine. Shows nothing for assets it hasn't seen. */
export function BitlockerPanel({ assetId }: { assetId: string }) {
  const { data } = useQuery({
    queryKey: ['asset-bitlocker', assetId],
    queryFn: () => api<BitlockerDeviceView[]>(`/assets/${assetId}/bitlocker`),
    staleTime: 60_000,
    retry: false,
  });
  if (!data?.length) return null;
  return (
    <Card>
      <CardHeader title="BitLocker" description="Reported by the collector script. Recovery keys are under Related." />
      <div className="space-y-4 px-5 py-4 text-sm">
        {data.map((d) => (
          <div key={d.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <BitlockerStatusBadge status={d.status} />
              <span className="text-xs text-muted">
                {d.hostname} · reported {formatDateTime(d.collectedAt)}
              </span>
            </div>
            <ul className="space-y-1.5">
              {d.volumes.map((v, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="w-8 font-mono font-medium">{v.mountPoint || '—'}</span>
                  <Badge tone={v.protection === 'On' ? 'success' : v.protection === 'Off' ? 'danger' : 'neutral'}>
                    {v.protection === 'On' ? 'On' : v.protection === 'Off' ? 'Off' : 'Unknown'}
                  </Badge>
                  <span className="text-xs text-text-2">
                    {[
                      v.protection === 'On' && v.encryptionMethod !== 'Unknown' ? v.encryptionMethod : null,
                      v.conversionStatus !== 'Unknown'
                        ? `${v.conversionStatus.toLowerCase()} (${v.encryptionPercentage}%)`
                        : null,
                      v.protection === 'On'
                        ? v.keys === 1
                          ? '1 recovery key saved'
                          : `${v.keys} recovery keys saved`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {v.error && <span className="basis-full pl-10 text-xs text-warning">{v.error}</span>}
                </li>
              ))}
              {!d.volumes.length && <li className="text-muted">No volumes reported.</li>}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
