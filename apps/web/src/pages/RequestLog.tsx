import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  Trash2,
  Waypoints,
} from 'lucide-react';
import type { RequestLogDetail, RequestLogEntry, RequestLogPage, RequestLogSettings } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const RETENTION = [1, 3, 7, 14, 30, 90];

const statusTone = (s: number) => (s === 0 || s >= 500 ? 'danger' : s >= 400 ? 'warning' : 'success');

export function RequestLog() {
  const [direction, setDirection] = useState('');
  const [service, setService] = useState('');
  const [method, setMethod] = useState('');
  const [outcome, setOutcome] = useState('');
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [live, setLive] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setQ(typed), 300);
    return () => clearTimeout(t);
  }, [typed]);
  const filters = { direction, service, method, outcome, q };
  const log = useInfiniteQuery({
    queryKey: ['request-log', filters],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
      if (pageParam) params.set('before', String(pageParam));
      return api<RequestLogPage>(`/request-log?${params}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: live ? 5000 : false,
  });
  const first = log.data?.pages[0];
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Request log"
        description="Every call Atlas makes to ConnectWise, Hudu, Microsoft and other services, and every request to Atlas's own API, while verbose logging is on. Passwords, keys, and tokens are always redacted."
      />
      {first && <LogSettings settings={first.settings} />}
      <Card className="mt-6">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <label className="relative block min-w-56 flex-1">
            <span className="sr-only">Search requests</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search URL, body, status, or person…"
              className="pl-9"
            />
          </label>
          <Select
            aria-label="Direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
            className="w-auto"
          >
            <option value="">In and out</option>
            <option value="outbound">Outbound</option>
            <option value="inbound">Incoming</option>
          </Select>
          <Select aria-label="Service" value={service} onChange={(e) => setService(e.target.value)} className="w-auto">
            <option value="">All services</option>
            {first?.services.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
          <Select aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value)} className="w-auto">
            <option value="">All methods</option>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
          <Select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className="w-auto">
            <option value="">Any status</option>
            <option value="ok">Succeeded</option>
            <option value="error">Failed</option>
          </Select>
          <Checkbox label="Live" checked={live} onChange={(e) => setLive(e.target.checked)} />
          <Button variant="secondary" onClick={() => void log.refetch()} loading={log.isRefetching && !live}>
            <RefreshCw /> Refresh
          </Button>
        </div>
        {log.isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !entries.length ? (
          <EmptyState
            icon={Waypoints}
            title="No requests"
            description={
              first?.settings.enabled
                ? 'Nothing matches these filters yet.'
                : 'Turn on verbose logging above to start recording requests.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <Row key={e.id} entry={e} />
            ))}
          </ul>
        )}
        {log.hasNextPage && (
          <div className="border-t border-border p-4 text-center">
            <Button variant="secondary" onClick={() => void log.fetchNextPage()} loading={log.isFetchingNextPage}>
              Load older
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

function LogSettings({ settings }: { settings: RequestLogSettings }) {
  const client = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<RequestLogSettings>) => {
    setBusy(true);
    try {
      await api('/request-log/settings', { method: 'PUT', body: { ...settings, ...patch } });
      await client.invalidateQueries({ queryKey: ['request-log'] });
    } catch (error) {
      toast((error as ApiError).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!confirm('Delete every entry in the request log?')) return;
    try {
      await api('/request-log', { method: 'DELETE' });
      await client.invalidateQueries({ queryKey: ['request-log'] });
      toast('Request log cleared.');
    } catch (error) {
      toast((error as ApiError).message, 'error');
    }
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Verbose logging{' '}
            <Badge tone={settings.enabled ? 'success' : 'neutral'}>{settings.enabled ? 'On' : 'Off'}</Badge>
          </span>
        }
        description="Records method, URL, status, timing, headers, and bodies. Turn it off when you're done troubleshooting."
        actions={
          <>
            <Button variant="secondary" onClick={() => void clear()}>
              <Trash2 /> Clear log
            </Button>
            <Button onClick={() => void save({ enabled: !settings.enabled })} loading={busy}>
              {settings.enabled ? 'Turn off' : 'Turn on'}
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-6 px-5 py-3.5 text-sm">
        <Checkbox
          label="Include requests to Atlas"
          description="Outbound integration calls are always recorded."
          checked={settings.incoming}
          disabled={busy}
          onChange={(e) => void save({ incoming: e.target.checked })}
        />
        <label className="flex items-center gap-2">
          <span className="font-medium">Keep entries for</span>
          <Select
            className="w-auto"
            value={settings.retentionDays}
            disabled={busy}
            onChange={(e) => void save({ retentionDays: Number(e.target.value) })}
          >
            {RETENTION.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? '1 day' : `${d} days`}
              </option>
            ))}
          </Select>
        </label>
      </div>
    </Card>
  );
}

function Row({ entry: e }: { entry: RequestLogEntry }) {
  const [open, setOpen] = useState(false);
  const Dir = e.direction === 'outbound' ? ArrowUpRight : ArrowDownLeft;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-5 py-2.5 text-left text-sm hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-4 shrink-0" aria-hidden />
        )}
        <Dir className="size-4 shrink-0 text-muted" aria-label={e.direction === 'outbound' ? 'Outbound' : 'Incoming'} />
        <Badge tone={statusTone(e.status)} className="shrink-0 tabular-nums">
          {e.status || 'ERR'}
        </Badge>
        <span className="w-14 shrink-0 font-mono text-xs font-semibold">{e.method}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={e.url}>
          {e.url}
        </span>
        <span className="hidden shrink-0 text-xs text-text-2 sm:inline">{e.service}</span>
        <span className="w-16 shrink-0 text-right text-xs text-muted tabular-nums">{e.durationMs} ms</span>
        <time dateTime={e.at} className="hidden w-40 shrink-0 text-right text-xs text-muted md:inline">
          {formatDateTime(e.at)}
        </time>
      </button>
      {open && <Detail id={e.id} />}
    </li>
  );
}

function Detail({ id }: { id: number }) {
  const { data } = useQuery({
    queryKey: ['request-log-entry', id],
    queryFn: () => api<RequestLogDetail>(`/request-log/${id}`),
  });
  if (!data) return <Skeleton className="mx-5 mb-3 h-24" />;
  return (
    <div className="space-y-3 bg-surface-2 px-5 py-4 text-sm">
      <p className="break-all font-mono text-xs">
        {data.method} {data.url}
      </p>
      <p className="text-xs text-muted">
        {data.service} · {formatDateTime(data.at)} · {data.durationMs} ms
        {data.actor && ` · ${data.actor}`}
      </p>
      {data.error && <p className="text-danger">{data.error}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Request headers" text={headers(data.requestHeaders)} />
        <Section title="Response headers" text={headers(data.responseHeaders)} />
        <Section title="Request body" text={data.requestBody} />
        <Section title="Response body" text={data.responseBody} />
      </div>
    </div>
  );
}

const headers = (h: Record<string, string>) =>
  Object.entries(h)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

function Section({ title, text }: { title: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-semibold text-text-2">{title}</p>
      <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs break-all whitespace-pre-wrap">
        {text || <span className="text-muted">(empty)</span>}
      </pre>
    </div>
  );
}
