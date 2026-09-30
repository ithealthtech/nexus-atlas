import { useState } from 'react';
import { CheckCircle2, MonitorDown, ShieldAlert, XCircle } from 'lucide-react';
import { APP_SCOPE_LABELS, NATIVE_CLIENTS, nativeAuthorizeSchema } from '@atlas/shared';
import { Button, Card, EmptyState, FormError } from '@/components/ui';
import { api } from '@/lib/api';
import { useActor } from '@/lib/session';

/**
 * Where Atlas for Windows sends the browser to sign in. The person is already signed in here (with MFA or a
 * passkey); this page asks them to approve the app, then hands the browser back to the app on this computer.
 */
export function NativeAuthorize() {
  const actor = useActor();
  // Read once: the app puts the whole request in the address, and nothing here changes it.
  const [params] = useState(() => Object.fromEntries(new URLSearchParams(window.location.search)));
  const parsed = nativeAuthorizeSchema.safeParse(params);
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'allowed' | 'denied' | null>(null);

  if (!parsed.success)
    return (
      <Card className="mx-auto max-w-lg">
        <EmptyState
          icon={XCircle}
          title="This sign-in link isn't valid"
          description={`${parsed.error.issues[0]?.message ?? 'Something in the link is missing.'} Start signing in again from the app.`}
        />
      </Card>
    );
  if (done)
    return (
      <Card className="mx-auto max-w-lg">
        <EmptyState
          icon={CheckCircle2}
          title={done === 'allowed' ? 'You’re signed in' : 'Sign-in cancelled'}
          description="You can close this tab and go back to the app."
        />
      </Card>
    );

  const request = parsed.data;
  const app = NATIVE_CLIENTS[request.client_id].name;
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'allow' : 'deny');
    setError(null);
    try {
      const { redirect } = await api<{ redirect: string }>('/native/authorize', {
        method: 'POST',
        body: { ...params, approve },
      });
      setDone(approve ? 'allowed' : 'denied');
      // Back to the app, which is listening on this computer for this one reply.
      window.location.assign(redirect);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mx-auto max-w-lg p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span className="grid size-11 place-items-center rounded-xl bg-primary-soft text-primary">
          <MonitorDown className="size-6" aria-hidden />
        </span>
        <div>
          <h1 className="text-lg font-semibold">Sign in to {app}?</h1>
          <p className="text-sm text-muted">
            On <strong className="font-semibold text-text">{request.device_name}</strong> as {actor.email}
          </p>
        </div>
      </div>
      <p className="mt-6 text-sm font-medium">The app will be able to:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-text-2">
        {request.scope.map((scope) => (
          <li key={scope}>{APP_SCOPE_LABELS[scope]}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">
        It only sees the clients you can see, and everything it does is recorded under your name. You can sign it out
        from your Account page at any time.
      </p>
      <div className="mt-5 flex gap-3 rounded-lg bg-warning-soft p-3 text-sm text-warning">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>Only continue if you just started signing in from {app} on this computer. If you didn’t, cancel.</p>
      </div>
      <FormError message={error} />
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button variant="secondary" onClick={() => decide(false)} loading={busy === 'deny'} disabled={!!busy}>
          Cancel
        </Button>
        <Button onClick={() => decide(true)} loading={busy === 'allow'} disabled={!!busy}>
          Allow and sign in
        </Button>
      </div>
    </Card>
  );
}
