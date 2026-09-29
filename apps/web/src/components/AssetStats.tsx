import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Monitor, Network, Phone, Printer, Server, Waypoints, type LucideIcon } from 'lucide-react';
import {
  ASSET_KIND_LABELS,
  ASSET_OS,
  ASSET_OS_INFO,
  type AssetKind,
  type AssetStatsAsset,
  type AssetStatsFilter,
  type AssetStatsReport,
} from '@atlas/shared';
import { api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { AppLink } from './AppLink';
import { StatusChart, Tile, type Slice } from './StatusChart';
import { Card, CardHeader, Dialog, EmptyState, Skeleton } from './ui';

export const useAssetStats = (clientId?: string) =>
  useQuery({
    queryKey: ['asset-stats', clientId ?? 'all'],
    queryFn: () => api<AssetStatsReport>(`/asset-stats${clientId ? `?client=${clientId}` : ''}`),
  });

const TILES: { kind: AssetKind; icon: LucideIcon }[] = [
  { kind: 'server', icon: Server },
  { kind: 'workstation', icon: Monitor },
  { kind: 'switch', icon: Waypoints },
  { kind: 'network', icon: Network },
  { kind: 'printer', icon: Printer },
  { kind: 'phone', icon: Phone },
];

function listTitle(filter: AssetStatsFilter) {
  if (filter === 'eos') return 'End-of-support operating systems';
  const [what, value] = filter.split(':') as [string, string];
  return what === 'kind'
    ? ASSET_KIND_LABELS[value as AssetKind]
    : `${ASSET_OS_INFO[value as keyof typeof ASSET_OS_INFO].label} devices`;
}

function AssetList({
  filter,
  clientId,
  onClose,
}: {
  filter: AssetStatsFilter | null;
  clientId?: string;
  onClose: () => void;
}) {
  const assets = useQuery({
    queryKey: ['asset-stats', 'assets', clientId ?? 'all', filter],
    queryFn: () =>
      api<AssetStatsAsset[]>(`/asset-stats/assets?filter=${filter}${clientId ? `&client=${clientId}` : ''}`),
    enabled: !!filter,
  });
  const list = assets.data ?? [];
  return (
    <Dialog
      open={!!filter}
      onClose={onClose}
      size="lg"
      title={filter ? listTitle(filter) : ''}
      description={
        assets.data ? `${list.length}${list.length === 500 ? '+' : ''} assets, by client and name.` : undefined
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
                Operating system
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
                  <span className="block text-xs text-muted">
                    {a.layoutName} · {ASSET_KIND_LABELS[a.kind]}
                  </span>
                </td>
                {!clientId && <td className="py-2 pr-3 text-text-2">{a.clientName}</td>}
                <td className="py-2 text-text-2">
                  {a.osName || 'Not recorded'}
                  {ASSET_OS_INFO[a.os].endOfSupport && (
                    <span className="block text-xs font-medium text-[#d03b3b] dark:text-[#ef8a7c]">End of support</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

/**
 * Documented devices by kind (servers, workstations, switches…) and by operating system, with end-of-support
 * versions flagged. With a clientId it covers that client; without, every client the viewer can read.
 */
export function AssetStatsCard({ clientId }: { clientId?: string }) {
  const actor = useActor();
  const stats = useAssetStats(clientId);
  const [filter, setFilter] = useState<AssetStatsFilter | null>(null);
  const report = stats.data;
  const c = report?.totals;
  if (!actor.isStaff && !c?.total) return null;
  const os = report?.os;
  const slices: Slice<AssetStatsFilter>[] = os
    ? ASSET_OS.filter((o) => os[o] > 0).map((o) => ({
        label: ASSET_OS_INFO[o].endOfSupport ? `${ASSET_OS_INFO[o].label} (end of support)` : ASSET_OS_INFO[o].label,
        count: os[o],
        tone: ASSET_OS_INFO[o].endOfSupport ? 'critical' : o === 'other' || o === 'unknown' ? 'unknown' : 'good',
        filter: `os:${o}`,
      }))
    : [];
  const eos = os ? ASSET_OS.filter((o) => ASSET_OS_INFO[o].endOfSupport).reduce((n, o) => n + os[o], 0) : 0;
  const supported = os
    ? ASSET_OS.filter((o) => !ASSET_OS_INFO[o].endOfSupport && o !== 'other' && o !== 'unknown').reduce(
        (n, o) => n + os[o],
        0,
      )
    : 0;
  return (
    <Card>
      <CardHeader title="Asset statistics" description="Documented devices by kind and operating system." />
      {stats.isLoading ? (
        <div className="p-5">
          <Skeleton className="h-40" />
        </div>
      ) : !report || !c?.total ? (
        <EmptyState
          icon={Boxes}
          title="No devices yet"
          description="Configurations and other device layouts are counted here, by their Type and operating system."
          action={
            actor.isAdmin ? (
              <AppLink to="/admin/settings" className="text-sm font-semibold text-primary hover:underline">
                Choose which layouts count
              </AppLink>
            ) : undefined
          }
        />
      ) : (
        <div className="@container space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 @xl:grid-cols-3 @4xl:grid-cols-6">
            {TILES.map((t) => (
              <Tile
                key={t.kind}
                label={ASSET_KIND_LABELS[t.kind]}
                value={c[t.kind]}
                icon={t.icon}
                onClick={() => setFilter(`kind:${t.kind}`)}
              />
            ))}
          </div>
          {c.other > 0 && (
            <p className="text-xs text-muted">
              {c.total} devices in all, including{' '}
              <button
                type="button"
                onClick={() => setFilter('kind:other')}
                className="font-semibold text-primary hover:underline"
              >
                {c.other} other
              </button>
              .
            </p>
          )}
          {/* The client table sits beside the chart when the card is wide enough. */}
          <div className="grid items-start gap-4 @4xl:grid-cols-2">
            <StatusChart
              title="Operating systems"
              unit="Devices"
              headline={{ label: 'supported', count: supported }}
              slices={slices}
              total={c.total}
              onPick={(s) => setFilter(s.filter ?? null)}
              footer={
                eos > 0 ? (
                  <p className="mt-auto border-t border-border pt-3 text-xs text-muted">
                    {eos} device{eos === 1 ? ' runs' : 's run'} an operating system past its end of support.{' '}
                    <button
                      type="button"
                      onClick={() => setFilter('eos')}
                      className="font-semibold text-primary hover:underline"
                    >
                      List them
                    </button>
                  </p>
                ) : undefined
              }
            />
            {!clientId && report.clients.length > 1 && <ClientTable report={report} />}
          </div>
        </div>
      )}
      <AssetList filter={filter} clientId={clientId} onClose={() => setFilter(null)} />
    </Card>
  );
}

function ClientTable({ report }: { report: AssetStatsReport }) {
  const [all, setAll] = useState(false);
  const rows = all ? report.clients : report.clients.slice(0, 8);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="pb-2 text-left text-sm font-semibold text-text">By client, most devices first</caption>
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 font-medium">
              Client
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Devices
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Servers
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Workstations
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              End of support
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ clientId, clientName, counts: k, endOfSupport }) => (
            <tr key={clientId}>
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                <AppLink to={`/clients/${clientId}`} className="text-primary hover:underline">
                  {clientName}
                </AppLink>
              </th>
              <td className="py-2 pr-3 text-right tabular-nums">{k.total}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{k.server}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{k.workstation}</td>
              <td className="py-2 text-right tabular-nums">{endOfSupport}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.clients.length > 8 && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="mt-2 text-sm font-semibold text-primary hover:underline"
        >
          {all ? 'Show fewer' : `Show all ${report.clients.length} clients`}
        </button>
      )}
    </div>
  );
}
