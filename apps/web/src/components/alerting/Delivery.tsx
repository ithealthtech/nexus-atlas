import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Mail, MessageSquare, Radio, RotateCcw, Send } from 'lucide-react';
import {
  ALERT_DELIVERY_STATUSES,
  ALERT_DELIVERY_STATUS_LABELS,
  ALERT_KIND_LABELS,
  CLASSIC_ALERTS_REPLACED,
  type AlertDeliveryPage,
  type AlertDeliveryState,
  type AlertDeliveryStatus,
  type AlertDeliveryView,
  type AlertDryRun,
  type AlertTemplate,
} from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  FormError,
  Select,
  Skeleton,
  useToast,
  type Tone,
} from '@/components/ui';
import { AppLink } from '@/components/AppLink';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useClients } from '@/lib/queries';
import { ALERTING_BASE } from './useAlertEditor';

const STATUS_TONE: Record<AlertDeliveryStatus, Tone> = {
  pending: 'info',
  sending: 'info',
  sent: 'success',
  failed: 'danger',
  uncertain: 'warning',
  skipped: 'quiet',
};
const useDeliveryState = () =>
  useQuery({
    queryKey: ['alert-delivery'],
    queryFn: () => api<AlertDeliveryState>(`${ALERTING_BASE}/delivery`),
    refetchInterval: 60_000,
  });

/**
 * Whether the alerting center sends this organization's alerts, and the way to go live or back. Going live shows
 * what would send first, and says plainly which classic alerts stop.
 */
export function DeliveryPanel() {
  const queries = useQueryClient();
  const toast = useToast();
  const state = useDeliveryState();
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sendDue, setSendDue] = useState(false);
  const { busy, error, act } = useAction({
    after: () => queries.invalidateQueries({ queryKey: ['alert-delivery'] }),
  });
  if (state.isLoading) return <Skeleton className="h-40" />;
  if (!state.data) return <FormError message={state.error?.message} />;
  const s = state.data;
  const live = s.mode === 'center';
  const setMode = (mode: 'center' | 'classic') =>
    act(mode, async () => {
      await api(`${ALERTING_BASE}/delivery`, { method: 'PUT', body: { mode, confirm: mode === 'center', sendDue } });
      await queries.invalidateQueries({ queryKey: ['alert-deliveries'] });
      setConfirming(false);
      toast(mode === 'center' ? 'The alerting center is live.' : 'Back on the classic alerts.');
    });
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Radio className="size-4 text-muted" aria-hidden /> Delivery
          </span>
        }
        description={
          live
            ? `Live${s.since ? ` since ${formatDateTime(s.since)}${s.by ? ` (${s.by})` : ''}` : ''}. The latest published version sends: version ${s.publishedVersion ?? '–'}, ${s.publishedRules} ${s.publishedRules === 1 ? 'rule' : 'rules'}.`
            : 'The classic alerts are on. Publish your rules, preview what they would send, then go live.'
        }
        actions={<Badge tone={live ? 'success' : 'neutral'}>{live ? 'Live' : 'Classic alerts'}</Badge>}
      />
      <div className="grid gap-4 border-t border-border px-5 py-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Sent (7 days)" value={s.counts.sent} />
        <Fact label="Waiting" value={s.counts.pending} />
        <Fact label="Failed or to check" value={s.counts.failed + s.counts.uncertain} warn />
        <div>
          <p className="text-xs text-muted">Connections</p>
          <p className="mt-1 flex flex-wrap gap-2">
            <Badge tone={s.email ? 'success' : 'warning'}>Email {s.email ? 'ready' : 'not set up'}</Badge>
            <Badge tone={s.teams ? 'success' : 'quiet'}>Teams {s.teams ? 'connected' : 'not connected'}</Badge>
          </p>
        </div>
      </div>
      <FormError message={error} />
      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-4">
        <Button variant="secondary" disabled={!s.publishedVersion} onClick={() => setPreviewing(true)}>
          Preview what would send
        </Button>
        {live ? (
          <Button variant="secondary" loading={busy === 'classic'} onClick={() => void setMode('classic')}>
            Switch back to classic alerts
          </Button>
        ) : (
          <Button disabled={!s.publishedVersion} onClick={() => setConfirming(true)}>
            Go live
          </Button>
        )}
      </div>
      {previewing && <DryRunDrawer onClose={() => setPreviewing(false)} />}
      {confirming && (
        <Dialog
          open
          onClose={() => setConfirming(false)}
          title="Go live with the alerting center?"
          description={`Your published rules (version ${s.publishedVersion}) start sending within a minute.`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button loading={busy === 'center'} onClick={() => void setMode('center')}>
                Go live
              </Button>
            </>
          }
        >
          <div className="space-y-4 text-sm">
            <p>These classic alerts stop, so nothing is sent twice:</p>
            <ul className="list-disc space-y-1 pl-5 text-text-2">
              {CLASSIC_ALERTS_REPLACED.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="text-text-2">You can switch back at any time; the classic alerts pick up where they were.</p>
            <Checkbox
              label="Also send reminders that are already due"
              description="Off: what's due today was most likely sent by the classic alerts, so it's recorded as done. New reminders send as they fall due."
              checked={sendDue}
              onChange={(e) => setSendDue(e.target.checked)}
            />
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function Fact({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${warn && value ? 'text-danger' : ''}`}>{value}</p>
    </div>
  );
}

/** What the published rules would send right now, and to whom, with anything already sent marked. */
function DryRunDrawer({ onClose }: { onClose: () => void }) {
  const run = useQuery({
    queryKey: ['alert-dry-run'],
    queryFn: () => api<AlertDryRun>(`${ALERTING_BASE}/delivery/preview`),
    gcTime: 0,
  });
  const fresh = run.data?.matches.filter((m) => m.destinations.some((d) => d.ready && !d.alreadySent)).length ?? 0;
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title="What would send now"
      description={
        run.data
          ? `Version ${run.data.version ?? '–'} matches ${run.data.matches.length} of ${run.data.events} current events; ${fresh} would send now. Nothing is sent from here.`
          : 'Checking your published rules against what Atlas knows now. Nothing is sent from here.'
      }
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <FormError message={run.error?.message} />
      {run.isLoading && <Skeleton className="h-40" />}
      {run.data && !run.data.matches.length && (
        <EmptyState icon={Radio} title="Nothing to send now" description="No current event matches a published rule." />
      )}
      <ul className="space-y-3">
        {run.data?.matches.map((m, i) => (
          <li key={i} className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">
              {m.clientName} · {m.itemName}
            </p>
            <p className="text-xs text-muted">
              {m.ruleName} · {ALERT_KIND_LABELS[m.kind]} · {m.reason}
            </p>
            <ul className="mt-2 space-y-1">
              {m.destinations.map((d) => (
                <li key={d.label} className="flex flex-wrap items-center gap-2 text-xs">
                  {d.channel === 'email' ? (
                    <Mail className="size-3.5 text-muted" aria-hidden />
                  ) : (
                    <MessageSquare className="size-3.5 text-muted" aria-hidden />
                  )}
                  <span>{d.label}</span>
                  <Badge tone={d.alreadySent ? 'quiet' : d.ready ? 'success' : 'warning'}>
                    {d.alreadySent ? 'Already sent' : d.ready ? 'Would send' : d.detail}
                  </Badge>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Drawer>
  );
}

/** Every alert the center sent or tried to, newest first: what, why, to whom, and how it went. */
export function DeliveryHistory() {
  const queries = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<AlertDeliveryStatus | ''>('');
  const pages = useInfiniteQuery({
    queryKey: ['alert-deliveries', status],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api<AlertDeliveryPage>(
        `${ALERTING_BASE}/deliveries?${new URLSearchParams({ ...(status ? { status } : {}), ...(pageParam ? { before: pageParam } : {}) })}`,
      ),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 60_000,
  });
  const { busy, act } = useAction({ toast: true });
  const retry = (d: AlertDeliveryView) =>
    act(d.id, async () => {
      if (
        d.status === 'uncertain' &&
        !confirm('Atlas can’t tell whether this arrived. Check first: sending again may send it twice. Send again?')
      )
        return;
      await api(`${ALERTING_BASE}/deliveries/${d.id}/retry`, {
        method: 'POST',
        body: { confirmUncertain: d.status === 'uncertain' },
      });
      await queries.invalidateQueries({ queryKey: ['alert-deliveries'] });
      await queries.invalidateQueries({ queryKey: ['alert-delivery'] });
      toast('It will be sent again within a minute.');
    });
  const rows = pages.data?.pages.flatMap((p) => p.deliveries) ?? [];
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <History className="size-4 text-muted" aria-hidden /> Delivery history
          </span>
        }
        description="Every alert the alerting center sent, or tried to, with why it went and who it went to."
        actions={
          <label>
            <span className="sr-only">Show</span>
            <Select value={status} onChange={(e) => setStatus(e.target.value as AlertDeliveryStatus | '')}>
              <option value="">Everything</option>
              {ALERT_DELIVERY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ALERT_DELIVERY_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </label>
        }
      />
      <FormError message={pages.error?.message} />
      {pages.isLoading ? (
        <Skeleton className="m-5 h-24" />
      ) : !rows.length ? (
        <p className="border-t border-border px-5 py-6 text-sm text-muted">Nothing yet.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {d.channel === 'email' ? (
                    <Mail className="size-4 shrink-0 text-muted" aria-label="Email" />
                  ) : (
                    <MessageSquare className="size-4 shrink-0 text-muted" aria-label="Teams" />
                  )}
                  <span className="min-w-0 truncate">{d.subject}</span>
                  {d.test && <Badge tone="info">Test</Badge>}
                </p>
                <p className="text-xs text-muted">
                  {d.ruleName} · {d.reason} · {d.itemName} · to {d.destination}
                  {d.clientId && d.clientName && (
                    <>
                      {' · '}
                      <AppLink to={`/clients/${d.clientId}`} className="hover:underline">
                        {d.clientName}
                      </AppLink>
                    </>
                  )}
                </p>
                {d.error && <p className="mt-1 text-xs text-text-2">{d.error}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted" title={formatDateTime(d.sentAt ?? d.createdAt)}>
                  {relativeTime(d.sentAt ?? d.createdAt)}
                </span>
                <Badge tone={STATUS_TONE[d.status]}>{ALERT_DELIVERY_STATUS_LABELS[d.status]}</Badge>
                {(d.status === 'failed' || d.status === 'uncertain') && (
                  <Button size="sm" variant="secondary" loading={busy === d.id} onClick={() => void retry(d)}>
                    <RotateCcw /> Send again
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {pages.hasNextPage && (
        <div className="border-t border-border px-5 py-3">
          <Button
            variant="secondary"
            size="sm"
            loading={pages.isFetchingNextPage}
            onClick={() => void pages.fetchNextPage()}
          >
            Show older
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Sends the selected template, saved, with example details: to yourself by email, or to a client's Teams channel. */
export function TestSend({ template, saved }: { template: AlertTemplate; saved: boolean }) {
  const queries = useQueryClient();
  const toast = useToast();
  const clients = useClients();
  const [channel, setChannel] = useState<'email' | 'teams'>('email');
  const [clientId, setClientId] = useState('');
  const { busy, error, act } = useAction();
  const send = () =>
    act('test', async () => {
      const result = await api<AlertDeliveryView>(`${ALERTING_BASE}/test`, {
        method: 'POST',
        body: { templateId: template.id, channel, clientId: clientId || null },
      });
      await queries.invalidateQueries({ queryKey: ['alert-deliveries'] });
      if (result.status === 'sent') toast(channel === 'email' ? 'Test sent to your email.' : 'Test posted to Teams.');
      else throw new Error(result.error || 'The test couldn’t be sent.');
    });
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <Send className="size-4 text-muted" aria-hidden /> Send a test
      </h2>
      <p className="mt-1 text-sm text-text-2">
        Sends “{template.name}” as saved, with example details and marked as a test.
        {!saved && ' Save your drafts first to test your latest changes.'}
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Send to">
          {(p) => (
            <Select {...p} value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'teams')}>
              <option value="email">My email</option>
              <option value="teams">A client’s Teams channel</option>
            </Select>
          )}
        </Field>
        {channel === 'teams' && (
          <Field label="Client">
            {(p) => (
              <Select {...p} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Choose a client</option>
                {clients.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Button
          variant="secondary"
          loading={busy === 'test'}
          disabled={channel === 'teams' && !clientId}
          onClick={() => void send()}
        >
          <Send /> Send test
        </Button>
      </div>
      <FormError message={error} />
    </Card>
  );
}
