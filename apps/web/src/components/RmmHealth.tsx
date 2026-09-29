import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Server, ServerOff, Activity } from 'lucide-react';
import type {
  RmmHealthCounts,
  RmmHealthDevice,
  RmmHealthFilter,
  RmmHealthReport,
  RmmHealthTrendPoint,
} from '@atlas/shared';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';
import { AppLink } from './AppLink';
import { Sparkline, StatusChart, Tile, pct, type Slice as StatusSlice } from './StatusChart';
import { Card, CardHeader, Dialog, EmptyState, Skeleton } from './ui';

type Slice = StatusSlice<RmmHealthFilter>;

export const useRmmHealth = (clientId?: string) =>
  useQuery({
    queryKey: ['rmm-health', clientId ?? 'all'],
    queryFn: () => api<RmmHealthReport>(`/rmm-health${clientId ? `?client=${clientId}` : ''}`),
  });

const TREND_DAYS = 30;
type Metric = 'online' | 'current' | 'protectionRunning';

export const useRmmHealthTrend = (clientId?: string) =>
  useQuery({
    queryKey: ['rmm-health', 'trend', clientId ?? 'all'],
    queryFn: () =>
      api<RmmHealthTrendPoint[]>(`/rmm-health/trend?days=${TREND_DAYS}${clientId ? `&client=${clientId}` : ''}`),
  });

const DEVICE_LIST_TITLES: Record<RmmHealthFilter, string> = {
  offline: 'Offline devices',
  online_unknown: 'Devices with no online state',
  stale: 'Stale agents',
  very_stale: 'Very stale agents',
  seen_unknown: 'Devices with no check-in time',
  protection_not_running: 'Protection not running',
  protection_missing: 'No endpoint protection',
  protection_unknown: 'Protection not reported',
};

function DeviceList({
  filter,
  clientId,
  onClose,
}: {
  filter: RmmHealthFilter | null;
  clientId?: string;
  onClose: () => void;
}) {
  const devices = useQuery({
    queryKey: ['rmm-health', 'devices', clientId ?? 'all', filter],
    queryFn: () =>
      api<RmmHealthDevice[]>(`/rmm-health/devices?filter=${filter}${clientId ? `&client=${clientId}` : ''}`),
    enabled: !!filter,
  });
  const list = devices.data ?? [];
  return (
    <Dialog
      open={!!filter}
      onClose={onClose}
      size="lg"
      title={filter ? DEVICE_LIST_TITLES[filter] : ''}
      description={
        devices.data ? `${list.length}${list.length === 500 ? '+' : ''} devices, oldest check-in first.` : undefined
      }
    >
      {devices.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th scope="col" className="pb-2 font-medium">
                Device
              </th>
              {!clientId && (
                <th scope="col" className="pb-2 font-medium">
                  Client
                </th>
              )}
              <th scope="col" className="pb-2 font-medium">
                Last check-in
              </th>
              <th scope="col" className="pb-2 font-medium">
                Protection
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {list.map((d) => (
              <tr key={d.assetId}>
                <td className="py-2 pr-3">
                  <AppLink
                    to={`/assets/${d.assetId}`}
                    className="font-medium text-primary hover:underline"
                    onClick={onClose}
                  >
                    {d.name}
                  </AppLink>
                  <span className="block text-xs text-muted capitalize">
                    {d.kind} · {d.online === null ? 'online state unknown' : d.online ? 'online' : 'offline'}
                  </span>
                </td>
                {!clientId && <td className="py-2 pr-3 text-text-2">{d.clientName}</td>}
                <td className="py-2 pr-3 text-text-2">{d.lastSeenAt ? relativeTime(d.lastSeenAt) : 'Not reported'}</td>
                <td className="py-2 text-text-2">
                  {d.protection === 'running'
                    ? 'Running'
                    : d.protection === 'not_running'
                      ? 'Not running'
                      : d.protection === 'missing'
                        ? 'Missing'
                        : 'Not reported'}
                  {d.protectionProduct && <span className="block text-xs text-muted">{d.protectionProduct}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}

function charts(c: RmmHealthCounts, staleDays: number, veryStaleDays: number) {
  return [
    {
      title: 'Agent online',
      metric: 'online' as Metric,
      headline: { label: 'online', count: c.online },
      slices: [
        { label: 'Online', count: c.online, tone: 'good' },
        { label: 'Offline', count: c.offline, tone: 'critical', filter: 'offline' },
        { label: 'Unknown', count: c.onlineUnknown, tone: 'unknown', filter: 'online_unknown' },
      ] as Slice[],
    },
    {
      title: 'Stale agents',
      metric: 'current' as Metric,
      headline: { label: 'current', count: c.current },
      slices: [
        { label: `Current (under ${staleDays} days)`, count: c.current, tone: 'good' },
        { label: `Stale (${staleDays}–${veryStaleDays} days)`, count: c.stale, tone: 'warning', filter: 'stale' },
        { label: `Very stale (${veryStaleDays}+ days)`, count: c.veryStale, tone: 'critical', filter: 'very_stale' },
        { label: 'Never reported', count: c.seenUnknown, tone: 'unknown', filter: 'seen_unknown' },
      ] as Slice[],
    },
    {
      title: 'Endpoint protection',
      metric: 'protectionRunning' as Metric,
      headline: { label: 'protected', count: c.protectionRunning },
      slices: [
        { label: 'Running', count: c.protectionRunning, tone: 'good' },
        { label: 'Not running', count: c.protectionNotRunning, tone: 'serious', filter: 'protection_not_running' },
        { label: 'Missing', count: c.protectionMissing, tone: 'critical', filter: 'protection_missing' },
        { label: 'Not reported', count: c.protectionUnknown, tone: 'unknown', filter: 'protection_unknown' },
      ] as Slice[],
    },
  ];
}

/**
 * Agent online, stale agents, and endpoint protection from the RMM sync. With a clientId it covers that client;
 * without, every client the viewer can read, with a per-client table.
 */
export function RmmHealthCard({ clientId }: { clientId?: string }) {
  const actor = useActor();
  const health = useRmmHealth(clientId);
  const trend = useRmmHealthTrend(clientId).data ?? [];
  const [filter, setFilter] = useState<RmmHealthFilter | null>(null);
  const report = health.data;
  const c = report?.totals;
  if (!actor.isStaff && !c?.total) return null;
  return (
    <Card>
      <CardHeader
        title="RMM health"
        description={
          report?.updatedAt
            ? `From ConnectWise RMM · updated ${relativeTime(report.updatedAt)}`
            : 'Agent status from ConnectWise RMM.'
        }
      />
      {health.isLoading ? (
        <div className="grid gap-4 p-5 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : !report || !c?.total ? (
        <EmptyState
          icon={Activity}
          title="No RMM data yet"
          description={
            clientId
              ? 'Link this client to a ConnectWise RMM company and sync to see agent status here.'
              : 'Connect ConnectWise RMM and sync devices to see agent status across your clients.'
          }
          action={
            actor.isAdmin ? (
              <AppLink to="/admin/data" className="text-sm font-semibold text-primary hover:underline">
                Set up the sync
              </AppLink>
            ) : undefined
          }
        />
      ) : (
        <div className="@container space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Devices" value={c.total} icon={Monitor} />
            <Tile label="Servers" value={c.servers} icon={Server} />
            <Tile label="Workstations" value={c.workstations} icon={Monitor} />
            <Tile label="Offline servers" value={c.offlineServers} icon={ServerOff} alert={c.offlineServers > 0} />
          </div>
          {/* Side by side only when the card is wide enough for three legends (not in a client's narrower column). */}
          <div className="grid gap-4 @4xl:grid-cols-3">
            {charts(c, report.staleDays, report.veryStaleDays).map((chart) => (
              <StatusChart
                key={chart.title}
                title={chart.title}
                headline={chart.headline}
                slices={chart.slices}
                unit="Devices"
                total={c.total}
                onPick={(s) => setFilter(s.filter ?? null)}
                footer={
                  <Sparkline
                    label={chart.headline.label}
                    days={TREND_DAYS}
                    points={trend
                      .filter((p) => p.total > 0)
                      .map((p) => ({ day: p.day, value: pct(p[chart.metric], p.total) }))}
                  />
                }
              />
            ))}
          </div>
          {!clientId && report.clients.length > 1 && <ClientTable report={report} />}
        </div>
      )}
      <DeviceList filter={filter} clientId={clientId} onClose={() => setFilter(null)} />
    </Card>
  );
}

function ClientTable({ report }: { report: RmmHealthReport }) {
  const [all, setAll] = useState(false);
  const rows = all ? report.clients : report.clients.slice(0, 8);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="pb-2 text-left text-sm font-semibold text-text">By client, most trouble first</caption>
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 font-medium">
              Client
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Devices
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Online
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              Stale or very stale
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Protected
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(({ clientId, clientName, counts: k }) => (
            <tr key={clientId}>
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                <AppLink to={`/clients/${clientId}`} className="text-primary hover:underline">
                  {clientName}
                </AppLink>
              </th>
              <td className="py-2 pr-3 text-right tabular-nums">{k.total}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{pct(k.online, k.total)}%</td>
              <td className="py-2 pr-3 text-right tabular-nums">{k.stale + k.veryStale}</td>
              <td className="py-2 text-right tabular-nums">{pct(k.protectionRunning, k.total)}%</td>
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
