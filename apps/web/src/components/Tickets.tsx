import { useState, type MouseEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Ticket } from 'lucide-react';
import { TICKET_DAYS, type TicketDays, type TicketReport, type TicketView } from '@atlas/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';
import { AppLink } from './AppLink';
import { Card, CardHeader, Dialog, EmptyState, Skeleton } from './ui';

const query = (params: Record<string, string | undefined>) => {
  const q = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined));
  return q.size ? `?${q}` : '';
};

export const useTickets = (clientId: string | undefined, days: TicketDays) =>
  useQuery({
    queryKey: ['tickets', clientId ?? 'all', days],
    queryFn: () => api<TicketReport>(`/tickets${query({ client: clientId, days: String(days) })}`),
  });

const useTicketList = (clientId: string | undefined, status: string | undefined, days: TicketDays, enabled = true) =>
  useQuery({
    queryKey: ['tickets', 'list', clientId ?? 'all', status ?? '(open)', days],
    queryFn: () => api<TicketView[]>(`/tickets/list${query({ client: clientId, status, days: String(days) })}`),
    enabled,
  });

/** How long a ticket has been open, in the largest whole unit. */
export function ticketAge(openedAt: string | null, closedAt: string | null = null) {
  if (!openedAt) return 'Not reported';
  const hours = Math.max((Date.parse(closedAt ?? new Date().toISOString()) - Date.parse(openedAt)) / 3_600_000, 0);
  if (hours < 1) return 'Under an hour';
  if (hours < 48) return `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'}`;
  return `${Math.floor(hours / 24)} days`;
}

// Opened and closed: the first two categorical slots, stepped for each mode and checked for colour-blind separation.
const SERIES = {
  opened: { label: 'Opened', stroke: 'stroke-[#2a78d6] dark:stroke-[#3987e5]', bg: 'bg-[#2a78d6] dark:bg-[#3987e5]' },
  closed: { label: 'Closed', stroke: 'stroke-[#eb6834] dark:stroke-[#d95926]', bg: 'bg-[#eb6834] dark:bg-[#d95926]' },
} as const;
const day = (d: string) => formatDate(`${d}T12:00:00`);

/** Tickets opened and closed per day, as two lines with a crosshair tooltip; a table carries the same numbers. */
function TrendChart({ trend }: { trend: TicketReport['trend'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...trend.flatMap((p) => [p.opened, p.closed]), 1);
  // A round top for the axis: 1, 2, 5, 10, 20, 50…
  const top =
    [1, 2, 5].map((m) => m * 10 ** Math.floor(Math.log10(max))).find((v) => v >= max) ??
    10 ** Math.ceil(Math.log10(max));
  const x = (i: number) => (trend.length > 1 ? (i / (trend.length - 1)) * 600 : 300);
  const y = (v: number) => 150 - (v / top) * 140;
  const line = (key: 'opened' | 'closed') => trend.map((p, i) => `${x(i)},${y(p[key])}`).join(' ');
  const totals = { opened: trend.reduce((n, p) => n + p.opened, 0), closed: trend.reduce((n, p) => n + p.closed, 0) };
  const move = (e: MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - box.left) / box.width) * (trend.length - 1));
    setHover(Math.min(Math.max(i, 0), trend.length - 1));
  };
  const point = hover === null ? null : trend[hover]!;
  return (
    <figure className="min-w-0">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2">
        {(['opened', 'closed'] as const).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={cn('h-0.5 w-4 rounded-full', SERIES[k].bg)} aria-hidden />
            {SERIES[k].label} <span className="font-semibold text-text tabular-nums">{totals[k]}</span>
          </span>
        ))}
      </figcaption>
      <div className="mt-2 flex gap-2">
        <div className="flex flex-col justify-between pb-5 text-right text-[11px] text-muted tabular-nums" aria-hidden>
          <span>{top}</span>
          <span>{Number.isInteger(top / 2) ? top / 2 : ''}</span>
          <span>0</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-40" onMouseMove={move} onMouseLeave={() => setHover(null)} aria-hidden>
            <svg viewBox="0 0 600 160" preserveAspectRatio="none" className="size-full overflow-visible">
              {[0, 0.5, 1].map((f) => (
                <line
                  key={f}
                  x1="0"
                  x2="600"
                  y1={y(top * f)}
                  y2={y(top * f)}
                  className="stroke-border"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {hover !== null && (
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1="0"
                  y2="150"
                  className="stroke-muted"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {(['closed', 'opened'] as const).map((k) => (
                <polyline
                  key={k}
                  points={line(k)}
                  fill="none"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  className={SERIES[k].stroke}
                />
              ))}
            </svg>
            {point && (
              <div
                className={cn(
                  'pointer-events-none absolute top-0 z-10 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-card',
                  hover! > trend.length / 2 ? '-translate-x-[calc(100%+8px)]' : 'translate-x-2',
                )}
                style={{ left: `${(x(hover!) / 600) * 100}%` }}
              >
                <p className="font-semibold text-text">{day(point.day)}</p>
                {(['opened', 'closed'] as const).map((k) => (
                  <p key={k} className="flex items-center gap-1.5 text-text-2">
                    <span className={cn('size-2 rounded-full', SERIES[k].bg)} />
                    {SERIES[k].label}{' '}
                    <span className="ml-auto pl-3 font-semibold text-text tabular-nums">{point[k]}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted" aria-hidden>
            <span>{day(trend[0]!.day)}</span>
            <span>{day(trend[trend.length - 1]!.day)}</span>
          </div>
        </div>
      </div>
      <table className="sr-only">
        <caption>Tickets opened and closed per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Opened</th>
            <th scope="col">Closed</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((p) => (
            <tr key={p.day}>
              <th scope="row">{day(p.day)}</th>
              <td>{p.opened}</td>
              <td>{p.closed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** The ticket number, linking to the ticket in ConnectWise when it gave a link. */
function TicketNumber({ t }: { t: TicketView }) {
  return t.url ? (
    <a
      href={t.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
    >
      #{t.number}
      <ExternalLink className="size-3" aria-hidden />
      <span className="sr-only">(opens ConnectWise)</span>
    </a>
  ) : (
    <span className="font-medium">#{t.number}</span>
  );
}

/** Tickets as a table: number (linked to ConnectWise), summary, status, age, and last update. Text is escaped. */
function TicketTable({ tickets, showClient }: { tickets: TicketView[]; showClient: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 pr-3 font-medium">
              Ticket
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Summary
            </th>
            {showClient && (
              <th scope="col" className="py-2 pr-3 font-medium">
                Client
              </th>
            )}
            <th scope="col" className="py-2 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Age
            </th>
            <th scope="col" className="py-2 font-medium">
              Last updated
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tickets.map((t) => (
            <tr key={t.id} className="align-top">
              <td className="py-2 pr-3 whitespace-nowrap">
                <TicketNumber t={t} />
              </td>
              <td className="max-w-80 py-2 pr-3 break-words text-text">{t.summary || '(no summary)'}</td>
              {showClient && (
                <td className="py-2 pr-3 text-text-2">
                  <AppLink to={`/clients/${t.clientId}`} className="hover:underline">
                    {t.clientName}
                  </AppLink>
                </td>
              )}
              <td className="py-2 pr-3 text-text-2">{t.status}</td>
              <td className="py-2 pr-3 whitespace-nowrap text-text-2 tabular-nums">
                {ticketAge(t.openedAt, t.closedAt)}
              </td>
              <td className="py-2 whitespace-nowrap text-text-2">
                {t.updatedAt ? relativeTime(t.updatedAt) : 'Not reported'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusList({
  status,
  clientId,
  days,
  onClose,
}: {
  status: string | null;
  clientId?: string;
  days: TicketDays;
  onClose: () => void;
}) {
  const list = useTicketList(clientId, status ?? undefined, days, status !== null);
  const n = list.data?.length ?? 0;
  return (
    <Dialog
      open={status !== null}
      onClose={onClose}
      size="lg"
      title={status ? `Tickets: ${status}` : ''}
      description={list.data ? `${n}${n === 500 ? '+' : ''} tickets, the longest since an update first.` : undefined}
    >
      {list.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <TicketTable tickets={list.data ?? []} showClient={!clientId} />
      )}
    </Dialog>
  );
}

function SetUp({ clientId }: { clientId?: string }) {
  const actor = useActor();
  return (
    <EmptyState
      icon={Ticket}
      title={clientId ? 'No ConnectWise company linked' : 'No tickets yet'}
      description={
        clientId
          ? 'Link this client to its ConnectWise company, with tickets switched on, to see its tickets here.'
          : 'Link clients to their ConnectWise companies, with tickets switched on, to see tickets here.'
      }
      action={
        actor.isAdmin ? (
          <AppLink to="/admin/data" className="text-sm font-semibold text-primary hover:underline">
            Set up the connection
          </AppLink>
        ) : (
          <p className="text-xs text-muted">An administrator sets this up under Import &amp; export.</p>
        )
      }
    />
  );
}

/**
 * Ticket tiles (a count per status; each lists its tickets) and statistics (opened and closed per day) from the
 * ConnectWise sync. With a clientId it covers that client; without, every client the viewer can read.
 */
export function TicketsCard({ clientId }: { clientId?: string }) {
  const actor = useActor();
  const [days, setDays] = useState<TicketDays>(30);
  const [status, setStatus] = useState<string | null>(null);
  const tickets = useTickets(clientId, days);
  const report = tickets.data;
  const empty = !report || (!report.statuses.length && !report.trend.some((p) => p.opened || p.closed));
  if (!actor.isStaff && empty) return null;
  return (
    <Card>
      <CardHeader
        title="Tickets"
        description={
          report?.updatedAt
            ? `From ConnectWise · updated ${relativeTime(report.updatedAt)}`
            : 'Read-only, from ConnectWise.'
        }
        actions={
          report?.linked && (
            <div role="group" aria-label="Period" className="flex gap-1 rounded-lg bg-surface-3 p-1">
              {TICKET_DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  aria-pressed={days === d}
                  className="rounded-md px-2.5 py-1 text-[13px] font-medium text-text-2 aria-pressed:bg-surface aria-pressed:text-text aria-pressed:shadow-sm"
                >
                  {d} days
                </button>
              ))}
            </div>
          )
        }
      />
      {tickets.isLoading ? (
        <div className="p-5">
          <Skeleton className="h-48" />
        </div>
      ) : !report?.linked && empty ? (
        <SetUp clientId={clientId} />
      ) : (
        <div className="space-y-5 p-5">
          <TrendChart trend={report!.trend} />
          <div>
            <h3 className="text-sm font-semibold text-text">
              By status <span className="font-normal text-muted">· {report!.open} open</span>
            </h3>
            {report!.statuses.length ? (
              <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {report!.statuses.map((s) => (
                  <li key={s.name}>
                    <button
                      type="button"
                      onClick={() => setStatus(s.name)}
                      className="w-full rounded-lg border border-border px-3 py-2.5 text-left hover:bg-surface-2"
                    >
                      <span className="block truncate text-xs text-muted">
                        {s.name}
                        {s.closed && <span className="sr-only">, closed in the last {days} days</span>}
                      </span>
                      <span className="mt-0.5 block text-xl font-semibold tracking-tight text-text tabular-nums">
                        {s.count}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">No open tickets, and none closed in the last {days} days.</p>
            )}
            {report!.statuses.some((s) => s.closed) && (
              <p className="mt-2 text-xs text-muted">Closed statuses count tickets closed in the last {days} days.</p>
            )}
          </div>
        </div>
      )}
      <StatusList status={status} clientId={clientId} days={days} onClose={() => setStatus(null)} />
    </Card>
  );
}

/** A client's open tickets, the longest since an update first, linking to each in ConnectWise. */
export function TicketDetails({ clientId }: { clientId: string }) {
  const [all, setAll] = useState(false);
  const report = useTickets(clientId, 30).data;
  const list = useTicketList(clientId, undefined, 30, !!report?.linked);
  if (!report?.linked) return null;
  const tickets = list.data ?? [];
  const shown = all ? tickets : tickets.slice(0, 10);
  return (
    <Card>
      <CardHeader title="Ticket details" description="Open tickets, the longest since an update first." />
      {list.isLoading ? (
        <div className="p-5">
          <Skeleton className="h-24" />
        </div>
      ) : tickets.length ? (
        <div className="px-5 pt-2 pb-4">
          <TicketTable tickets={shown} showClient={false} />
          {tickets.length > 10 && (
            <button
              type="button"
              onClick={() => setAll(!all)}
              className="mt-2 text-sm font-semibold text-primary hover:underline"
            >
              {all ? 'Show fewer' : `Show all ${tickets.length}${tickets.length === 500 ? '+' : ''}`}
            </button>
          )}
        </div>
      ) : (
        <p className="px-5 py-4 text-sm text-muted">No open tickets.</p>
      )}
    </Card>
  );
}
