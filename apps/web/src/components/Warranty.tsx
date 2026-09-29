import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import type { WarrantyAsset, WarrantyFilter, WarrantyReport } from '@atlas/shared';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useActor } from '@/lib/session';
import { AppLink } from './AppLink';
import { StatusChart, type Slice } from './StatusChart';
import { Card, CardHeader, Dialog, EmptyState, Skeleton } from './ui';

export const useWarranty = (clientId?: string) =>
  useQuery({
    queryKey: ['warranty', clientId ?? 'all'],
    queryFn: () => api<WarrantyReport>(`/warranty${clientId ? `?client=${clientId}` : ''}`),
  });

const LIST: Record<WarrantyFilter, { title: string; description: string }> = {
  expired: { title: 'Expired warranties', description: 'Oldest first.' },
  soon: { title: 'Warranties expiring soon', description: 'Soonest first.' },
  active: { title: 'Active warranties', description: 'Soonest first.' },
  unknown: {
    title: 'Assets with no warranty date',
    description: 'Open each asset and enter when its warranty ends.',
  },
};

function when(a: WarrantyAsset) {
  if (a.daysLeft === null || !a.warrantyExpires) return 'No date';
  const date = formatDate(`${a.warrantyExpires}T12:00:00`);
  if (a.daysLeft < 0) return `${date} · ${-a.daysLeft} day${a.daysLeft === -1 ? '' : 's'} ago`;
  if (a.daysLeft === 0) return `${date} · today`;
  return `${date} · in ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'}`;
}

function AssetList({
  filter,
  clientId,
  onClose,
}: {
  filter: WarrantyFilter | null;
  clientId?: string;
  onClose: () => void;
}) {
  const assets = useQuery({
    queryKey: ['warranty', 'assets', clientId ?? 'all', filter],
    queryFn: () => api<WarrantyAsset[]>(`/warranty/assets?filter=${filter}${clientId ? `&client=${clientId}` : ''}`),
    enabled: !!filter,
  });
  const list = assets.data ?? [];
  return (
    <Dialog
      open={!!filter}
      onClose={onClose}
      size="lg"
      title={filter ? LIST[filter].title : ''}
      description={
        filter && assets.data
          ? `${list.length}${list.length === 500 ? '+' : ''} assets. ${LIST[filter].description}`
          : undefined
      }
    >
      {assets.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="pb-2 font-medium">
                Asset
              </th>
              {!clientId && (
                <th scope="col" className="pb-2 font-medium">
                  Client
                </th>
              )}
              <th scope="col" className="pb-2 font-medium">
                Warranty ends
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((a) => (
              <tr key={a.assetId}>
                <td className="py-2 pr-3">
                  <AppLink
                    to={`/assets/${a.assetId}`}
                    className="font-medium text-primary hover:underline"
                    onClick={onClose}
                  >
                    {a.name}
                  </AppLink>
                  <span className="block text-xs text-muted">{a.layoutName}</span>
                </td>
                {!clientId && <td className="py-2 pr-3 text-text-2">{a.clientName}</td>}
                <td className="py-2 text-text-2 tabular-nums">{when(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

/**
 * Hardware assets by where their warranty ends. Assets count when their layout has a warranty date field (the
 * Configurations layout's "Warranty expires", or any date field named for a warranty).
 */
export function WarrantyCard({ clientId }: { clientId?: string }) {
  const actor = useActor();
  const warranty = useWarranty(clientId);
  const [filter, setFilter] = useState<WarrantyFilter | null>(null);
  const report = warranty.data;
  const c = report?.totals;
  if (!actor.isStaff && !c?.total) return null;
  const slices: Slice<WarrantyFilter>[] = c
    ? [
        { label: 'Expired', count: c.expired, tone: 'critical', filter: 'expired' },
        { label: `Expiring within ${report.soonDays} days`, count: c.soon, tone: 'warning', filter: 'soon' },
        { label: 'Active', count: c.active, tone: 'good', filter: 'active' },
        { label: 'No date', count: c.unknown, tone: 'unknown', filter: 'unknown' },
      ]
    : [];
  return (
    <Card>
      <CardHeader title="Asset warranty" description="Hardware assets by when their warranty ends." />
      {warranty.isLoading ? (
        <div className="p-5">
          <Skeleton className="h-40" />
        </div>
      ) : !report || !c?.total ? (
        <EmptyState
          icon={ShieldCheck}
          title="No hardware assets yet"
          description="Assets whose layout has a warranty date, like Configurations, are counted here."
        />
      ) : (
        <div className="p-5">
          <StatusChart
            bare
            title="Asset warranty"
            unit="Assets"
            headline={{ label: 'in warranty', count: c.active + c.soon }}
            slices={slices}
            total={c.total}
            onPick={(s) => setFilter(s.filter ?? null)}
            footer={
              c.unknown > 0 ? (
                <p className="mt-auto border-t border-border pt-3 text-xs text-muted">
                  {c.unknown} asset{c.unknown === 1 ? ' has' : 's have'} no warranty date.{' '}
                  <button
                    type="button"
                    onClick={() => setFilter('unknown')}
                    className="font-semibold text-primary hover:underline"
                  >
                    List them
                  </button>
                </p>
              ) : undefined
            }
          />
        </div>
      )}
      <AssetList filter={filter} clientId={clientId} onClose={() => setFilter(null)} />
    </Card>
  );
}
