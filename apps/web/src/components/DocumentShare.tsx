import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Link2 } from 'lucide-react';
import type { DocumentShareView } from '@atlas/shared';
import { Badge, Button, Dialog, Field, Select, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { DEMO } from '@/lib/demo';
import { formatDate, formatDateTime } from '@/lib/format';

// The demo runs on hash addresses, so its links need the hash to open.
const linkOf = (share: DocumentShareView) => (DEMO ? share.url.replace('/kb/', '/#/kb/') : share.url);

/** Links that let anyone read this document without signing in: make one, copy it, see its views, revoke it. */
export function DocumentShareDialog({
  documentId,
  title,
  onClose,
}: {
  documentId: string;
  title: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const shares = useQuery({
    queryKey: ['document-shares', documentId],
    queryFn: () => api<DocumentShareView[]>(`/documents/${documentId}/shares`),
  });
  const [expires, setExpires] = useState('');
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
  const copy = (share: DocumentShareView) =>
    navigator.clipboard.writeText(linkOf(share)).then(() => toast('Link copied.'));
  const active = (shares.data ?? []).filter((s) => s.status === 'active');
  const ended = (shares.data ?? []).filter((s) => s.status !== 'active');
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Share by link"
      description={`Anyone who has the link can read “${title}” without signing in. They see this document only, always as it is now.`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-5">
        <div className="rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning">
          Check the document first. Don&rsquo;t share one that contains passwords, internal addresses, or anything about
          another client.
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Link works for" className="min-w-44 flex-1">
            {(p) => (
              <Select {...p} value={expires} onChange={(e) => setExpires(e.target.value)}>
                <option value="">Until I revoke it</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
              </Select>
            )}
          </Field>
          <Button
            loading={busy === 'create'}
            onClick={() =>
              act('create', async () => {
                const made = await api<DocumentShareView>(`/documents/${documentId}/shares`, {
                  method: 'POST',
                  body: { expiresDays: expires ? Number(expires) : null },
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
          <p className="text-sm text-muted">This document isn&rsquo;t shared.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {[...active, ...ended].map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{linkOf(s)}</p>
                  <p className="text-xs text-muted">
                    Made {formatDate(s.createdAt)}
                    {s.createdByName && ` by ${s.createdByName}`} ·{' '}
                    {s.expiresAt
                      ? `${s.status === 'expired' ? 'expired' : 'expires'} ${formatDate(s.expiresAt)}`
                      : 'no expiry'}{' '}
                    · opened {s.views} {s.views === 1 ? 'time' : 'times'}
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
                      onClick={() => act(`revoke-${s.id}`, () => api(`/document-shares/${s.id}`, { method: 'DELETE' }))}
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
    </Dialog>
  );
}
