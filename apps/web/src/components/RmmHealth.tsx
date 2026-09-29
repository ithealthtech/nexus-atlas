import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Monitor,
  Server,
  ServerOff,
  Activity,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { RmmHealthCounts, RmmHealthDevice, RmmHealthFilter, RmmHealthReport } from '@atlas/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';
import { AppLink } from './AppLink';
import { Card, CardHeader, Dialog, EmptyState, Skeleton } from './ui';

/**
 * Status colours for the health charts (good, warning, serious, critical, unknown). They're fixed rather than
 * themed, and never carry meaning alone: every slice has an icon and a label in the legend beside it.
 */
type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';
const STROKE: Record<Tone, string> = {
  good: 'stroke-[#0ca30c]',
  warning: 'stroke-[#fab219]',
  serious: 'stroke-[#ec835a]',
  critical: 'stroke-[#d03b3b]',
  unknown: 'stroke-[#c3c2b7] dark:stroke-[#5b5a55]',
};
const SWATCH: Record<Tone, string> = {
  good: 'text-[#0ca30c]',
  warning: 'text-[#b27c0a] dark:text-[#fab219]',
  serious: 'text-[#c75a30] dark:text-[#ec835a]',
  critical: 'text-[#d03b3b] dark:text-[#ef8a7c]',
  unknown: 'text-muted',
};
const ICON: Record<Tone, LucideIcon> = {
  good: CheckCircle2,
  warning: AlertTriangle,
  serious: AlertTriangle,
  critical: XCircle,
  unknown: CircleHelp,
};

interface Slice {
  label: string;
  count: number;
  tone: Tone;
  /** The device list behind the slice; healthy slices have none. */
  filter?: RmmHealthFilter;
}

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

export const useRmmHealth = (clientId?: string) =>
  useQuery({
    queryKey: ['rmm-health', clientId ?? 'all'],
    queryFn: () => api<RmmHealthReport>(`/rmm-health${clientId ? `?client=${clientId}` : ''}`),
  });

/** A donut of status slices with a 2px gap between them. Decorative: the legend beside it carries the numbers. */
function Donut({ slices, total, active }: { slices: Slice[]; total: number; active: string | null }) {
  const shown = slices.filter((s) => s.count > 0);
  const gap = shown.length > 1 ? 0.7 : 0; // about 2px at this size, in path-length units of 100
  // Where each slice starts, as a share of the ring.
  const starts = shown.map((_, i) => shown.slice(0, i).reduce((sum, s) => sum + (s.count / total) * 100, 0));
  return (
    <svg viewBox="0 0 120 120" className="size-32 shrink-0 -rotate-90" aria-hidden>
      {shown.map((s, i) => {
        const length = (s.count / total) * 100;
        const dash = Math.max(length - gap, 0.1);
        return (
          <circle
            key={s.label}
            cx="60"
            cy="60"
            r="48"
            fill="none"
            strokeWidth={active === s.label ? 16 : 13}
            pathLength={100}
            strokeDasharray={`${dash} ${100 - dash}`}
            strokeDashoffset={-starts[i]!}
            className={cn(STROKE[s.tone], 'transition-[stroke-width]', active && active !== s.label && 'opacity-40')}
          >
            <title>{`${s.label}: ${s.count} (${pct(s.count, total)}%)`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

function HealthChart({
  title,
  headline,
  slices,
  total,
  onPick,
}: {
  title: string;
  /** The share the chart is about, e.g. "online", shown large in the middle. */
  headline: { label: string; count: number };
  slices: Slice[];
  total: number;
  onPick: (slice: Slice) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <div className="relative">
          <Donut slices={slices} total={total} active={active} />
          <div className="absolute inset-0 grid place-content-center text-center">
            <span className="text-2xl font-semibold tracking-tight text-text">{pct(headline.count, total)}%</span>
            <span className="text-xs text-muted">{headline.label}</span>
          </div>
        </div>
        <table className="min-w-40 flex-1 text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Devices</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => {
              const Icon = ICON[s.tone];
              const label = (
                <>
                  <Icon className={cn('size-4 shrink-0', SWATCH[s.tone])} aria-hidden />
                  <span className="truncate">{s.label}</span>
                </>
              );
              return (
                <tr
                  key={s.label}
                  onMouseEnter={() => setActive(s.label)}
                  onMouseLeave={() => setActive(null)}
                  className="align-middle"
                >
                  <th scope="row" className="py-1 pr-2 text-left font-normal text-text-2">
                    {s.filter && s.count > 0 ? (
                      <button
                        type="button"
                        onClick={() => onPick(s)}
                        onFocus={() => setActive(s.label)}
                        onBlur={() => setActive(null)}
                        className="-mx-1 flex min-h-7 items-center gap-2 rounded px-1 text-left hover:bg-surface-2 hover:underline"
                      >
                        {label}
                      </button>
                    ) : (
                      <span className="flex min-h-7 items-center gap-2">{label}</span>
                    )}
                  </th>
                  <td className="py-1 pr-2 text-right font-semibold text-text tabular-nums">{s.count}</td>
                  <td className="w-12 py-1 text-right text-muted tabular-nums">{pct(s.count, total)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Tile({
  label,
  value,
  icon: Icon,
  alert,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  alert?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex items-center justify-between text-xs text-muted">
        {label}
        <Icon className={cn('size-4', alert && SWATCH.critical)} aria-hidden />
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-text tabular-nums">{value}</div>
    </div>
  );
}

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
      headline: { label: 'online', count: c.online },
      slices: [
        { label: 'Online', count: c.online, tone: 'good' },
        { label: 'Offline', count: c.offline, tone: 'critical', filter: 'offline' },
        { label: 'Unknown', count: c.onlineUnknown, tone: 'unknown', filter: 'online_unknown' },
      ] as Slice[],
    },
    {
      title: 'Stale agents',
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
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Devices" value={c.total} icon={Monitor} />
            <Tile label="Servers" value={c.servers} icon={Server} />
            <Tile label="Workstations" value={c.workstations} icon={Monitor} />
            <Tile label="Offline servers" value={c.offlineServers} icon={ServerOff} alert={c.offlineServers > 0} />
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            {charts(c, report.staleDays, report.veryStaleDays).map((chart) => (
              <HealthChart key={chart.title} {...chart} total={c.total} onPick={(s) => setFilter(s.filter ?? null)} />
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
