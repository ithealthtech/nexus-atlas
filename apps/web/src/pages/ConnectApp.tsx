import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Puzzle, ShieldAlert } from 'lucide-react';
import { DEVICE_KIND_LABELS, type DevicePairingView } from '@atlas/shared';
import { Button, Card, EmptyState, FormError, PageHeader, Skeleton, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { formatDate, relativeTime } from '@/lib/format';

/**
 * Approving a sign-in from the browser extension. The extension opens this page with the code it shows; the person
 * checks the two match and allows it. Approving needs a recent password confirmation.
 */
export function ConnectApp() {
  const { code = '' } = useSearch({ strict: false }) as { code?: string };
  const actor = useActor();
  const toast = useToast();
  const navigate = useNavigate();
  const [done, setDone] = useState<'allowed' | 'denied' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const request = useQuery({
    queryKey: ['device-pairing', code],
    queryFn: () => api<DevicePairingView>(`/account/apps/pairing/${encodeURIComponent(code)}`),
    enabled: !!code && actor.isStaff && !done,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const answer = async (allow: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/account/apps/pairing/${encodeURIComponent(code)}${allow ? '/approve' : ''}`, {
        method: allow ? 'POST' : 'DELETE',
        body: allow ? {} : undefined,
      });
      setDone(allow ? 'allowed' : 'denied');
      if (!allow) toast('Sign-in request refused.');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const shell = (body: ReactNode) => (
    <>
      <PageHeader eyebrow="Your account" title="Sign in an app" />
      <Card className="max-w-lg">{body}</Card>
    </>
  );

  if (!actor.isStaff)
    return shell(
      <EmptyState
        icon={ShieldAlert}
        title="Staff only"
        description="The browser extension is for staff accounts. Ask your Atlas administrator."
      />,
    );
  if (done === 'allowed')
    return shell(
      <EmptyState
        icon={CheckCircle2}
        title="Browser signed in"
        description="Go back to the extension; it finishes signing in on its own. You can sign it out any time from your account page."
        action={
          <Button variant="secondary" onClick={() => navigate({ to: '/account' })}>
            Go to your account
          </Button>
        }
      />,
    );
  if (done === 'denied' || !code || request.isError)
    return shell(
      <EmptyState
        icon={Puzzle}
        title={done === 'denied' ? 'Request refused' : 'This request has ended'}
        description={
          done === 'denied'
            ? 'Nothing was signed in.'
            : ((request.error as Error | null)?.message ??
              'Open the Atlas extension and choose Sign in through Atlas to start again.')
        }
        action={
          <Link to="/" className="font-semibold text-primary hover:underline">
            Go to the dashboard
          </Link>
        }
      />,
    );
  if (!request.data) return shell(<Skeleton className="m-6 h-40" />);

  const r = request.data;
  return shell(
    <div className="grid gap-5 p-6">
      <div>
        <p className="text-sm text-muted">{DEVICE_KIND_LABELS[r.kind]}</p>
        <p className="text-lg font-semibold">{r.name}</p>
        <p className="text-sm text-muted">
          Asked {relativeTime(r.createdAt)} from {r.ip || 'an unknown address'} · expires {formatDate(r.expiresAt)}
        </p>
      </div>
      <div>
        <p className="text-sm font-medium">Check the extension shows this code</p>
        <p className="mt-2 rounded-lg bg-surface-2 px-4 py-3 text-center font-mono text-2xl font-semibold tracking-widest">
          {r.code}
        </p>
      </div>
      <p className="text-sm">
        Allowing it lets this browser fill and copy the passwords you can use in Atlas, as you, until you sign it out.
        Each fill and copy is recorded. Only allow it if you just started signing in from the extension yourself.
      </p>
      <FormError message={error?.message} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => answer(true)} disabled={busy}>
          Allow
        </Button>
        <Button variant="secondary" onClick={() => answer(false)} disabled={busy}>
          Don’t allow
        </Button>
      </div>
    </div>,
  );
}
