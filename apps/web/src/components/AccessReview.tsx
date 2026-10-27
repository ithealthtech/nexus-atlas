import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ShieldCheck, UserMinus } from 'lucide-react';
import { ACCESS_REVIEW_DAYS, LEVEL_INFO, ROLE_INFO, type AccessDecision, type AccessReviewView } from '@atlas/shared';
import { Badge, Button, Card, CardHeader, Field, FormError, Input, useToast } from '@/components/ui';
import { api, download } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';

/**
 * A client's access review, for administrators: who can open the client, keep or remove each person, then sign it
 * off. Past reviews download as PDFs, as evidence. Says a review is due after ACCESS_REVIEW_DAYS.
 */
export function AccessReviewCard({ clientId }: { clientId: string }) {
  const actor = useActor();
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = ['access-reviews', clientId];
  const reviews = useQuery({
    queryKey: key,
    queryFn: () => api<AccessReviewView[]>(`/clients/${clientId}/access-reviews`),
    enabled: actor.isAdmin,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [signedName, setSignedName] = useState(actor.name);
  const [error, setError] = useState<string | null>(null);
  // When the page opened, for "due": a review doesn't fall due while someone is looking at it.
  const [now] = useState(() => Date.now());
  if (!actor.isAdmin || !reviews.data) return null;
  const open = reviews.data.find((r) => !r.completedAt);
  const done = reviews.data.filter((r) => r.completedAt);
  const last = done[0];
  const due = !last || now - Date.parse(last.completedAt!) > ACCESS_REVIEW_DAYS * 86_400_000;
  const run = async (what: string, call: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await call();
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const decide = (review: AccessReviewView, userId: string, decision: AccessDecision) =>
    run(userId, () => api(`/access-reviews/${review.id}/decisions`, { method: 'POST', body: { userId, decision } }));
  const undecided = open?.items.filter((i) => !i.decision).length ?? 0;
  return (
    <Card>
      <CardHeader
        title="Access review"
        description={
          last
            ? `Last signed off ${formatDate(last.completedAt!)} by ${last.signedName}.`
            : 'Check who can open this client, keep or remove each person, and sign it off.'
        }
        actions={
          open ? (
            <Badge tone="info">In progress</Badge>
          ) : (
            <>
              {due && <Badge tone="warning">Due</Badge>}
              <Button
                size="sm"
                loading={busy === 'start'}
                onClick={() => void run('start', () => api(`/clients/${clientId}/access-reviews`, { method: 'POST' }))}
              >
                <ShieldCheck /> Start review
              </Button>
            </>
          )
        }
      />
      <FormError message={error} />
      {open && (
        <>
          <ul className="divide-y divide-border border-t border-border">
            {open.items.map((i) => (
              <li key={i.userId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                <span className="min-w-0">
                  <span className="block font-medium">{i.name}</span>
                  <span className="block text-xs text-muted">
                    {[ROLE_INFO[i.role].label, LEVEL_INFO[i.level].label, ...i.via].join(' · ')}
                    {!i.mfa && ' · No two-factor'}
                    {` · ${i.lastLoginAt ? `Signed in ${relativeTime(i.lastLoginAt)}` : 'Never signed in'}`}
                  </span>
                  {i.decision === 'remove' && i.stillHasAccess && (
                    <span className="block text-xs text-warning">
                      Still has access through {i.via.filter((v) => v !== 'Direct').join(', ')}. Change it under People.
                    </span>
                  )}
                </span>
                <span className="flex gap-2">
                  <Button
                    size="sm"
                    variant={i.decision === 'keep' ? 'primary' : 'secondary'}
                    aria-pressed={i.decision === 'keep'}
                    loading={busy === i.userId}
                    onClick={() => void decide(open, i.userId, 'keep')}
                  >
                    <Check /> Keep
                  </Button>
                  <Button
                    size="sm"
                    variant={i.decision === 'remove' ? 'danger' : 'secondary'}
                    aria-pressed={i.decision === 'remove'}
                    onClick={() => void decide(open, i.userId, 'remove')}
                  >
                    <UserMinus /> Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-wrap items-end gap-3 border-t border-border px-5 py-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run('sign', async () => {
                await api(`/access-reviews/${open.id}/sign-off`, { method: 'POST', body: { signedName } });
                toast('Access review signed off.');
              });
            }}
          >
            <Field label="Signed off by" className="min-w-48 flex-1">
              {(p) => (
                <Input {...p} value={signedName} onChange={(e) => setSignedName(e.target.value)} maxLength={120} />
              )}
            </Field>
            <Button type="submit" disabled={undecided > 0} loading={busy === 'sign'}>
              {undecided ? `${undecided} left to decide` : 'Sign off'}
            </Button>
          </form>
        </>
      )}
      {done.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {done.slice(0, 5).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
              <span>
                {formatDate(r.completedAt!)} · {r.signedName}
                <span className="text-muted">
                  {' '}
                  · {r.items.filter((i) => i.decision === 'remove').length} removed of {r.items.length}
                </span>
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Download the access review of ${formatDate(r.completedAt!)}`}
                onClick={() =>
                  void download(`/access-reviews/${r.id}/pdf`, 'access-review.pdf').catch((e: Error) =>
                    setError(e.message),
                  )
                }
              >
                <Download /> PDF
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
