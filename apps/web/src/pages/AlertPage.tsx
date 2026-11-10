import { useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Check, ExternalLink } from 'lucide-react';
import { ALERT_DELIVERY_STATUS_LABELS, ALERT_KIND_LABELS, type AlertDeliveryView } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Badge, Button, Card, EmptyState, FormError, PageHeader, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';
import { formatDateTime, relativeTime } from '@/lib/format';

/**
 * The page an alert's email or Teams post links to: what it's about, and Acknowledge, which records that someone is
 * on it, for everyone it went to, and stops it escalating.
 */
export function AlertPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const queries = useQueryClient();
  const alert = useQuery({ queryKey: ['alert', id], queryFn: () => api<AlertDeliveryView>(`/alerts/${id}`) });
  const { busy, error, act } = useAction();
  const acknowledge = () =>
    act('ack', async () => {
      queries.setQueryData(
        ['alert', id],
        await api<AlertDeliveryView>(`/alerts/${id}/acknowledge`, { method: 'POST' }),
      );
    });
  if (alert.isLoading) return <Skeleton className="h-64" />;
  const a = alert.data;
  if (!a)
    return (
      <Card>
        <EmptyState
          icon={BellRing}
          title="Alert not found"
          description={alert.error?.message ?? 'It may be for a client you can’t open.'}
        />
      </Card>
    );
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader eyebrow={ALERT_KIND_LABELS[a.kind]} title={a.subject} description={`${a.ruleName} · ${a.reason}`} />
      <Card className="space-y-4 p-5 text-sm">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">About</dt>
            <dd className="font-medium">{a.itemName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Client</dt>
            <dd>
              {a.clientId && a.clientName ? (
                <AppLink to={`/clients/${a.clientId}`} className="font-medium text-primary hover:underline">
                  {a.clientName}
                </AppLink>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Sent</dt>
            <dd title={a.sentAt ? formatDateTime(a.sentAt) : undefined}>
              {a.sentAt ? relativeTime(a.sentAt) : ALERT_DELIVERY_STATUS_LABELS[a.status]} to {a.destination}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Status</dt>
            <dd className="flex flex-wrap gap-2">
              {a.acknowledgedAt ? (
                <Badge tone="success">Acknowledged</Badge>
              ) : (
                <Badge tone="warning">Not acknowledged</Badge>
              )}
              {a.escalation && <Badge tone="danger">Escalated</Badge>}
            </dd>
          </div>
        </dl>
        {a.acknowledgedAt && (
          <p className="text-text-2">
            {a.acknowledgedBy?.startsWith('Resolved by ')
              ? `${a.acknowledgedBy} ${relativeTime(a.acknowledgedAt)}: nothing to acknowledge.`
              : `${a.acknowledgedBy ?? 'Someone'} acknowledged it ${relativeTime(a.acknowledgedAt)}, for everyone it went to.`}
          </p>
        )}
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          {!a.acknowledgedAt && (
            <Button loading={busy === 'ack'} onClick={() => void acknowledge()}>
              <Check /> Acknowledge
            </Button>
          )}
          <a
            href={a.link}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-semibold hover:bg-surface-3"
          >
            <ExternalLink className="size-4" aria-hidden /> Open {a.itemName}
          </a>
        </div>
        {!a.acknowledgedAt && (
          <p className="text-xs text-muted">
            Acknowledging tells the rest of the team you’re on it, and stops the alert escalating.
          </p>
        )}
      </Card>
    </div>
  );
}
