import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { AlertTriangle, Globe, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  TRACKER_FILTERS,
  atLeast,
  type TrackerCounts,
  type TrackerFilter,
  type TrackerItem,
  type TrackerKind,
  type TrackerReport,
  type TrackerRunResult,
  type ClientSummary,
} from '@atlas/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, relativeTime } from '@/lib/format';
import { useClient, useSave } from '@/lib/queries';
import { useActor } from '@/lib/session';
import { AppLink } from './AppLink';
import { StatusChart, SWATCH, type Slice, type Tone } from './StatusChart';
import { Button, Card, CardHeader, Dialog, EmptyState, Skeleton, useToast } from './ui';

export const useTrackers = (clientId?: string) =>
  useQuery({
    queryKey: ['trackers', clientId ?? 'all'],
    queryFn: () => api<TrackerReport>(`/trackers${clientId ? `?client=${clientId}` : ''}`),
  });

const useTrackerItems = (kind: TrackerKind, opts: { clientId?: string; filter?: TrackerFilter | null }) =>
  useQuery({
    queryKey: ['trackers', 'items', kind, opts.clientId ?? 'all', opts.filter ?? 'all'],
    queryFn: () => {
      const q = new URLSearchParams({ kind });
      if (opts.filter) q.set('filter', opts.filter);
      if (opts.clientId) q.set('client', opts.clientId);
      return api<TrackerItem[]>(`/trackers/items?${q}`);
    },
    enabled: opts.filter !== null,
  });

export const TRACKER: Record<
  TrackerKind,
  { title: string; noun: string; plural: string; source: string; path: string }
> = {
  domain: { title: 'Domain Tracker', noun: 'domain', plural: 'Domains', source: 'Registrar', path: 'domains' },
  ssl: { title: 'SSL Tracker', noun: 'certificate', plural: 'SSL certificates', source: 'Issuer', path: 'ssl' },
};

const STANDING: Record<TrackerFilter, { label: (soonDays: number) => string; tone: Tone }> = {
  expired: { label: () => 'Expired', tone: 'critical' },
  soon: { label: (d) => `Expiring within ${d} days`, tone: 'warning' },
  active: { label: () => 'Active', tone: 'good' },
  unknown: { label: () => 'Unknown', tone: 'unknown' },
};

const slicesOf = (c: TrackerCounts, soonDays: number): Slice<TrackerFilter>[] =>
  TRACKER_FILTERS.map((f) => ({ label: STANDING[f].label(soonDays), count: c[f], tone: STANDING[f].tone, filter: f }));

/** "12 Mar 2027 · in 164 days", or why there's no date. */
function when(i: TrackerItem) {
  if (i.daysLeft === null || !i.expires) return 'No date';
  const date = formatDate(`${i.expires}T12:00:00`);
  if (i.daysLeft < 0) return `${date} · ${-i.daysLeft} day${i.daysLeft === -1 ? '' : 's'} ago`;
  if (i.daysLeft === 0) return `${date} · today`;
  return `${date} · in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`;
}

/** Runs the trackers now for one client, or every client the viewer can edit, and says what happened. */
function useCheckNow(clientId?: string) {
  const toast = useToast();
  const save = useSave(
    () => api<TrackerRunResult>('/trackers/check', { method: 'POST', body: clientId ? { client: clientId } : {} }),
    [['trackers'], ['assets'], ['expirations']],
  );
  const run = async () => {
    try {
      const r = await save.mutateAsync(undefined);
      const checked = r.domains + r.certificates;
      toast(
        checked
          ? `Checked ${r.domains} domain${r.domains === 1 ? '' : 's'} and ${r.certificates} certificate${
              r.certificates === 1 ? '' : 's'
            }${r.created ? `, added ${r.created} certificate${r.created === 1 ? '' : 's'}` : ''}${
              r.failed ? `. ${r.failed} couldn't be read.` : '.'
            }`
          : 'Nothing to check yet. Add Domains or SSL certificates assets first.',
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return { run, pending: save.isPending };
}

function CheckNowButton({ clientId, size = 'sm' }: { clientId?: string; size?: 'sm' | 'md' }) {
  const check = useCheckNow(clientId);
  return (
    <Button variant="secondary" size={size} loading={check.pending} onClick={() => void check.run()}>
      <RefreshCw aria-hidden /> Check now
    </Button>
  );
}

/** Where the last check got to: when, and what it found or why it failed. */
function LastCheck({ item }: { item: TrackerItem }) {
  if (!item.checkedAt) return <span className="text-muted">Not checked yet</span>;
  return (
    <span className="block">
      <span className={cn('flex items-center gap-1.5', item.ok === false && SWATCH.serious)}>
        {item.ok === false && <AlertTriangle className="size-3.5 shrink-0" aria-hidden />}
        {item.ok === false ? 'Check failed' : 'Checked'} {relativeTime(item.checkedAt)}
      </span>
      {/* A good check's note repeats the registrar or issuer shown beside it; a problem is worth reading. */}
      {item.detail && (item.ok === false || /not trusted/.test(item.detail)) && (
        <span className="block text-xs text-muted">{item.detail}</span>
      )}
    </span>
  );
}

function ItemTable({ kind, items, showClient }: { kind: TrackerKind; items: TrackerItem[]; showClient: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th scope="col" className="pb-2 font-medium">
              {kind === 'domain' ? 'Domain' : 'Certificate'}
            </th>
            {showClient && (
              <th scope="col" className="pb-2 font-medium">
                Client
              </th>
            )}
            <th scope="col" className="pb-2 font-medium">
              Expires
            </th>
            <th scope="col" className="pb-2 font-medium">
              Last check
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((i) => (
            <tr key={i.assetId} className="align-top">
              <td className="py-2 pr-3">
                <AppLink to={`/assets/${i.assetId}`} className="font-medium text-primary hover:underline">
                  {i.name}
                </AppLink>
                <span className="block text-xs text-muted">
                  {i.source ? `${TRACKER[kind].source}: ${i.source}` : `${TRACKER[kind].source} not known`}
                </span>
              </td>
              {showClient && <td className="py-2 pr-3 text-text-2">{i.clientName}</td>}
              <td className="py-2 pr-3 text-text-2 tabular-nums">
                <StandingLabel standing={i.standing} />
                <span className="block text-xs text-muted">{when(i)}</span>
              </td>
              <td className="py-2 text-text-2">
                <LastCheck item={i} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StandingLabel({ standing, soonDays = 30 }: { standing: TrackerFilter; soonDays?: number }) {
  const s = STANDING[standing];
  return (
    <span className={cn('font-medium', SWATCH[s.tone])}>
      {standing === 'soon' ? 'Expiring soon' : s.label(soonDays)}
    </span>
  );
}

function ItemList({
  pick,
  clientId,
  soonDays,
  onClose,
}: {
  pick: { kind: TrackerKind; filter: TrackerFilter } | null;
  clientId?: string;
  soonDays: number;
  onClose: () => void;
}) {
  const kind = pick?.kind ?? 'domain';
  const items = useTrackerItems(kind, { clientId, filter: pick?.filter ?? null });
  const list = items.data ?? [];
  return (
    <Dialog
      open={!!pick}
      onClose={onClose}
      size="lg"
      title={pick ? `${TRACKER[kind].plural}: ${STANDING[pick.filter].label(soonDays).toLowerCase()}` : ''}
      description={
        pick && items.data
          ? `${list.length} ${list.length === 1 ? TRACKER[kind].noun : `${TRACKER[kind].noun}s`}. Soonest expiry first.`
          : undefined
      }
    >
      {items.isLoading ? <Skeleton className="h-24" /> : <ItemTable kind={kind} items={list} showClient={!clientId} />}
    </Dialog>
  );
}

/**
 * Domains and SSL certificates by when they expire, as two donuts. Domains are Domains assets; certificates are SSL
 * certificates assets, which the tracker keeps current from what each site serves.
 */
export function TrackerCard({ clientId }: { clientId?: string }) {
  const actor = useActor();
  // The client's own access decides who can check; the same query ClientLayout already loaded.
  const client = useQuery({
    queryKey: ['clients', clientId],
    queryFn: () => api<ClientSummary>(`/clients/${clientId}`),
    enabled: !!clientId,
  });
  const trackers = useTrackers(clientId);
  const [pick, setPick] = useState<{ kind: TrackerKind; filter: TrackerFilter } | null>(null);
  const report = trackers.data;
  const total = (report?.domain.total ?? 0) + (report?.ssl.total ?? 0);
  if (!actor.isStaff && !total) return null;
  const canCheck = clientId ? !!client.data && atLeast(client.data.access, 'edit') : actor.isStaff;
  return (
    <Card>
      <CardHeader
        title="Domain and SSL expiry"
        description="Registrations and certificates, checked on a schedule."
        actions={canCheck && total > 0 ? <CheckNowButton clientId={clientId} /> : undefined}
      />
      {trackers.isLoading ? (
        <div className="p-5">
          <Skeleton className="h-40" />
        </div>
      ) : !report || !total ? (
        <EmptyState
          icon={Globe}
          title="No domains or certificates yet"
          description="Add Domains assets, and the SSL certificates their sites serve are tracked too."
        />
      ) : (
        <div className="grid gap-4 p-5 md:grid-cols-2">
          {(['domain', 'ssl'] as const).map((kind) => (
            <StatusChart
              key={kind}
              title={TRACKER[kind].plural}
              unit={TRACKER[kind].plural}
              headline={{ label: 'valid', count: report[kind].active + report[kind].soon }}
              slices={slicesOf(report[kind], report.soonDays)}
              total={report[kind].total}
              onPick={(s) => s.filter && setPick({ kind, filter: s.filter })}
              footer={
                clientId ? (
                  <p className="mt-auto border-t border-border pt-3 text-xs">
                    <AppLink
                      to={`/clients/${clientId}/trackers/${TRACKER[kind].path}`}
                      className="font-semibold text-primary hover:underline"
                    >
                      Open {TRACKER[kind].title}
                    </AppLink>
                  </p>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
      <ItemList pick={pick} clientId={clientId} soonDays={report?.soonDays ?? 30} onClose={() => setPick(null)} />
    </Card>
  );
}

/** A client's Domain Tracker or SSL Tracker: every item, filterable by standing, with each one's last check. */
function TrackerPage({ kind }: { kind: TrackerKind }) {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId).data;
  const report = useTrackers(clientId).data;
  const [filter, setFilter] = useState<TrackerFilter | undefined>(undefined);
  const items = useTrackerItems(kind, { clientId, filter });
  const counts = report?.[kind];
  const soonDays = report?.soonDays ?? 30;
  const t = TRACKER[kind];
  const Icon = kind === 'domain' ? Globe : ShieldCheck;
  return (
    <Card>
      <CardHeader
        title={t.title}
        description={
          kind === 'domain'
            ? 'Registration expiry of this client’s Domains assets, re-checked with the registry on a schedule.'
            : 'Certificates this client’s sites serve, read over a secure connection every day.'
        }
        actions={client && atLeast(client.access, 'edit') ? <CheckNowButton clientId={clientId} /> : undefined}
      />
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2 px-5 pt-4">
        {([undefined, ...TRACKER_FILTERS] as const).map((f) => (
          <button
            key={f ?? 'all'}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border border-border px-3 py-1 text-sm font-medium text-text-2 hover:bg-surface-2',
              filter === f && 'border-primary bg-primary-soft text-primary',
            )}
          >
            {f ? STANDING[f].label(soonDays) : 'All'}
            {counts && <span className="ml-1.5 tabular-nums">{f ? counts[f] : counts.total}</span>}
          </button>
        ))}
      </div>
      <div className="p-5">
        {items.isLoading ? (
          <Skeleton className="h-32" />
        ) : items.data?.length ? (
          <ItemTable kind={kind} items={items.data} showClient={false} />
        ) : (
          <EmptyState
            icon={Icon}
            title={filter ? `No ${t.noun}s here` : `No ${t.plural.toLowerCase()} yet`}
            description={
              kind === 'domain'
                ? 'Add a Domains asset named for the domain, like example.com, and it is tracked from then on.'
                : 'A certificate is added for each Domains asset whose website serves one. Add an SSL certificates asset for any other host.'
            }
          />
        )}
      </div>
    </Card>
  );
}

export const DomainTracker = () => <TrackerPage kind="domain" />;
export const SslTracker = () => <TrackerPage kind="ssl" />;
