import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Link2 } from 'lucide-react';
import type { ReportShareView } from '@atlas/shared';
import { Badge, Button, Field, Select, Skeleton, useToast, Drawer } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';

/**
 * Links that let someone without an account (usually the client) see one report snapshot: make one, copy it, see
 * how often it was opened, revoke it. Report links always expire.
 */
export function ReportShareDialog({
  runId,
  title,
  client,
  onClose,
}: {
  runId: string;
  title: string;
  client: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const shares = useQuery({
    queryKey: ['report-shares', runId],
    queryFn: () => api<ReportShareView[]>(`/reports/runs/${runId}/shares`),
  });
  const [expires, setExpires] = useState('30');
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await work();
      await shares.refetch();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const copy = (share: ReportShareView) => navigator.clipboard.writeText(share.url).then(() => toast('Link copied.'));
  const active = (shares.data ?? []).filter((s) => s.status === 'active');
  const ended = (shares.data ?? []).filter((s) => s.status !== 'active');
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title="Share with the client"
      description={`Anyone who has the link can see this snapshot of “${title}” for ${client} without signing in, and download it as a PDF, until the link expires.`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning">
          Check the report first. The link shows every section of this snapshot, as it was captured.
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Link works for" className="min-w-44 flex-1">
            {(p) => (
              <Select {...p} value={expires} onChange={(e) => setExpires(e.target.value)}>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </Select>
            )}
          </Field>
          <Button
            loading={busy === 'create'}
            onClick={() =>
              act('create', async () => {
                const made = await api<ReportShareView>(`/reports/runs/${runId}/shares`, {
                  method: 'POST',
                  body: { expiresDays: Number(expires) },
                });
                await copy(made);
              })
            }
          >
            <Link2 /> Create link
          </Button>
        </div>
        {!shares.data ? (
          <Skeleton className="h-16" />
        ) : !shares.data.length ? (
          <p className="text-sm text-muted">This report isn&rsquo;t shared.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {[...active, ...ended].map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{s.url}</p>
                  <p className="text-xs text-muted">
                    Made {formatDate(s.createdAt)}
                    {s.createdByName && ` by ${s.createdByName}`} ·{' '}
                    {`${s.status === 'expired' ? 'expired' : 'expires'} ${formatDate(s.expiresAt)}`} · opened {s.views}{' '}
                    {s.views === 1 ? 'time' : 'times'}
                    {s.lastViewedAt && `, last ${formatDateTime(s.lastViewedAt)}`}
                  </p>
                </div>
                {s.status === 'active' ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => void copy(s)}>
                      <Copy /> Copy
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `revoke-${s.id}`}
                      onClick={() => act(`revoke-${s.id}`, () => api(`/report-shares/${s.id}`, { method: 'DELETE' }))}
                    >
                      Revoke
                    </Button>
                  </>
                ) : (
                  <Badge tone="neutral">{s.status === 'revoked' ? 'Revoked' : 'Expired'}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
