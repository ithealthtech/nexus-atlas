import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { SessionView } from '@atlas/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  Field,
  FormError,
  Input,
  PageHeader,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useActor, useApplySession } from '@/lib/session';
import { EnrollMfa } from '@/auth/AuthScreen';

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const apply = useApplySession();
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      apply(
        await api<SessionView>('/account/password', {
          method: 'POST',
          body: Object.fromEntries(new FormData(e.currentTarget)),
        }),
      );
      toast('Password changed. Your other sessions were signed out.');
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Change password"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="password-form" loading={busy}>
            Save password
          </Button>
        </>
      }
    >
      <form id="password-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Current password" error={error?.fields?.current}>
          {(p) => <Input {...p} name="current" type="password" autoComplete="current-password" required autoFocus />}
        </Field>
        <Field
          label="New password"
          help="At least 12 characters. Your other sessions will be signed out."
          error={error?.fields?.next}
        >
          {(p) => <Input {...p} name="next" type="password" autoComplete="new-password" required minLength={12} />}
        </Field>
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

export function Account() {
  const actor = useActor();
  const apply = useApplySession();
  const toast = useToast();
  const [changing, setChanging] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  if (enrolling)
    return (
      <Card className="mx-auto max-w-md p-6 sm:p-8">
        <EnrollMfa
          email={actor.email}
          done={(session) => {
            apply(session);
            setEnrolling(false);
            toast('Two-step verification is on.');
          }}
        />
        <Button variant="link" className="mt-4 w-full" onClick={() => setEnrolling(false)}>
          Cancel
        </Button>
      </Card>
    );
  return (
    <>
      <PageHeader eyebrow="Your account" title="Profile & sign-in" />
      <div className="grid max-w-4xl gap-6">
        <Card className="flex flex-wrap items-center gap-4 p-5">
          <Avatar name={actor.name} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">{actor.name}</p>
            <p className="text-sm text-muted">{actor.email}</p>
          </div>
          <Badge tone="primary">{actor.roleLabel}</Badge>
        </Card>
        <Card>
          <CardHeader title="Sign-in security" description="Protect the credentials and client data you can reach." />
          <div className="divide-y divide-border">
            <div className="flex flex-wrap items-center gap-4 px-5 py-4">
              <KeyRound className="size-5 text-muted" aria-hidden />
              <div className="flex-1">
                <p className="font-medium">Password</p>
                <p className="text-sm text-muted">Changing it signs out your other devices.</p>
              </div>
              <Button variant="secondary" onClick={() => setChanging(true)}>
                Change password
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-4 px-5 py-4">
              {actor.mfa ? (
                <ShieldCheck className="size-5 text-success" aria-hidden />
              ) : (
                <ShieldAlert className="size-5 text-warning" aria-hidden />
              )}
              <div className="flex-1">
                <p className="font-medium">Two-step verification</p>
                <p className="text-sm text-muted">
                  {actor.mfa
                    ? 'On · authenticator app. Ask an administrator to reset it if you lose your device.'
                    : 'Off. Add an authenticator app for a second layer of protection.'}
                </p>
              </div>
              {actor.mfa ? (
                <Badge tone="success">On</Badge>
              ) : (
                <Button onClick={() => setEnrolling(true)}>Turn on</Button>
              )}
            </div>
          </div>
        </Card>
      </div>
      <PasswordDialog open={changing} onClose={() => setChanging(false)} />
    </>
  );
}
