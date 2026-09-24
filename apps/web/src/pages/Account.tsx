import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Bell,
  Fingerprint,
  KeyRound,
  LifeBuoy,
  Laptop,
  LogOut,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react';
import type { SessionView } from '@atlas/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  Field,
  FormError,
  Input,
  PageHeader,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useActor, useApplySession } from '@/lib/session';
import { useAccountSecurity, useSave } from '@/lib/queries';
import { describeDevice, formatDate, relativeTime } from '@/lib/format';
import { addPasskey, passkeysSupported } from '@/lib/passkeys';
import { EnrollMfa } from '@/auth/AuthScreen';
import { RecoveryCodes } from '@/components/RecoveryCodes';

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

function PasskeyDialog({ open, onClose }: { open: boolean; onClose: (codes?: string[]) => void }) {
  const apply = useApplySession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '');
    setBusy(true);
    setError(null);
    try {
      const result = await addPasskey(name);
      apply(result);
      onClose(result.recoveryCodes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={() => onClose()}
      size="sm"
      title="Add a passkey"
      description="Windows Hello, Touch ID, a phone, or a security key such as a YubiKey."
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button type="submit" form="passkey-form" loading={busy}>
            <Fingerprint /> Continue
          </Button>
        </>
      }
    >
      <form id="passkey-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Name" help="For example, the device or key it lives on.">
          {(p) => <Input {...p} name="name" defaultValue="Work laptop" required maxLength={60} autoFocus />}
        </Field>
        <FormError message={error} />
      </form>
    </Dialog>
  );
}

function Row({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
      <span className="text-muted">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {detail && <p className="text-sm text-muted">{detail}</p>}
      </div>
      {children}
    </div>
  );
}

export function Account() {
  const actor = useActor();
  const apply = useApplySession();
  const toast = useToast();
  const security = useAccountSecurity();
  const [changing, setChanging] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = [['account-security']];
  const action = useSave(
    (req: { path: string; method: string; body?: unknown }) =>
      api<unknown>(req.path, { method: req.method, body: req.body }),
    refresh,
  );
  const run = async (req: { path: string; method: string; body?: unknown }, message: string) => {
    try {
      const result = await action.mutateAsync(req);
      toast(message);
      return result;
    } catch (err) {
      toast((err as Error).message, 'error');
      return null;
    }
  };

  if (enrolling)
    return (
      <Card className="mx-auto max-w-md p-6 sm:p-8">
        <EnrollMfa
          email={actor.email}
          done={(session) => {
            apply(session);
            setEnrolling(false);
            void security.refetch();
            toast('Two-step verification is on.');
          }}
        />
        <Button variant="link" className="mt-4 w-full" onClick={() => setEnrolling(false)}>
          Cancel
        </Button>
      </Card>
    );

  const data = security.data;
  const otherSessions = data?.sessions.filter((s) => !s.current).length ?? 0;
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
            <Row
              icon={<KeyRound className="size-5" aria-hidden />}
              title="Password"
              detail="Changing it signs out your other devices."
            >
              <Button variant="secondary" onClick={() => setChanging(true)}>
                Change password
              </Button>
            </Row>
            <Row
              icon={
                actor.mfa ? (
                  <ShieldCheck className="size-5 text-success" aria-hidden />
                ) : (
                  <ShieldAlert className="size-5 text-warning" aria-hidden />
                )
              }
              title="Two-step verification"
              detail={
                actor.mfa
                  ? 'On. You confirm each new sign-in with an authenticator app or a passkey.'
                  : 'Off. Add an authenticator app or a passkey for a second layer of protection.'
              }
            >
              {actor.mfa ? <Badge tone="success">On</Badge> : null}
            </Row>
            <Row
              icon={<Smartphone className="size-5" aria-hidden />}
              title="Authenticator app"
              detail={
                data?.totp
                  ? 'Codes from Microsoft Authenticator, Google Authenticator, 1Password, or similar.'
                  : 'Not set up.'
              }
            >
              {data &&
                (data.totp ? (
                  <Badge tone="success">Set up</Badge>
                ) : (
                  <Button onClick={() => setEnrolling(true)}>Set up</Button>
                ))}
            </Row>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Passkeys"
            description="Sign in with Windows Hello, Touch ID, your phone, or a security key. No password or code needed."
            actions={
              passkeysSupported() ? (
                <Button variant="secondary" size="sm" onClick={() => setAddingKey(true)}>
                  <Fingerprint /> Add passkey
                </Button>
              ) : undefined
            }
          />
          {!data ? (
            <Skeleton className="m-5 h-10" />
          ) : data.passkeys.length ? (
            <ul className="divide-y divide-border">
              {data.passkeys.map((k) => (
                <li key={k.id}>
                  <Row
                    icon={<Fingerprint className="size-5" aria-hidden />}
                    title={k.name}
                    detail={`Added ${formatDate(k.createdAt)} · ${k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'not used yet'}`}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove passkey ${k.name}`}
                      onClick={async () => {
                        const session = await run(
                          { path: `/account/passkeys/${encodeURIComponent(k.id)}`, method: 'DELETE' },
                          'Passkey removed.',
                        );
                        if (session) apply(session as SessionView);
                      }}
                    >
                      <Trash2 /> Remove
                    </Button>
                  </Row>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 py-4 text-sm text-muted">
              {passkeysSupported() ? 'No passkeys yet.' : 'This browser does not support passkeys.'}
            </p>
          )}
        </Card>

        {actor.mfa && (
          <Card>
            <div className="divide-y divide-border">
              <Row
                icon={<LifeBuoy className="size-5" aria-hidden />}
                title="Recovery codes"
                detail={
                  data
                    ? `${data.recoveryCodesLeft} of 10 unused. Each one signs you in once if you lose your app or passkey.`
                    : ' '
                }
              >
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const result = (await run(
                      { path: '/account/recovery-codes', method: 'POST', body: {} },
                      'New recovery codes created. The old ones no longer work.',
                    )) as { recoveryCodes: string[] } | null;
                    if (result) setCodes(result.recoveryCodes);
                  }}
                >
                  Create new codes
                </Button>
              </Row>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Where you're signed in"
            description="Sign out anything you don't recognise, then change your password."
            actions={
              otherSessions > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    run(
                      { path: '/account/sessions/end-others', method: 'POST', body: {} },
                      'Other sessions signed out.',
                    )
                  }
                >
                  <LogOut /> Sign out all others
                </Button>
              ) : undefined
            }
          />
          <ul className="divide-y divide-border">
            {data?.sessions.map((s) => (
              <li key={s.id}>
                <Row
                  icon={<Laptop className="size-5" aria-hidden />}
                  title={
                    <>
                      {describeDevice(s.userAgent)} {s.current && <Badge tone="success">This browser</Badge>}
                    </>
                  }
                  detail={`${s.ip || 'Unknown address'} · signed in ${formatDate(s.createdAt)} · active ${relativeTime(s.lastSeenAt)}`}
                >
                  {!s.current && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        run({ path: `/account/sessions/${s.id}`, method: 'DELETE' }, 'Session signed out.')
                      }
                    >
                      Sign out
                    </Button>
                  )}
                </Row>
              </li>
            ))}
          </ul>
        </Card>

        {!!data?.devices.length && (
          <Card>
            <CardHeader
              title="Remembered browsers"
              description="These skip two-step verification for 30 days after you chose to remember them."
            />
            <ul className="divide-y divide-border">
              {data.devices.map((d) => (
                <li key={d.id}>
                  <Row
                    icon={<MonitorSmartphone className="size-5" aria-hidden />}
                    title={describeDevice(d.userAgent)}
                    detail={`${d.ip || 'Unknown address'} · remembered ${formatDate(d.createdAt)} · until ${formatDate(d.expiresAt)}`}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => run({ path: `/account/devices/${d.id}`, method: 'DELETE' }, 'Browser forgotten.')}
                    >
                      Forget
                    </Button>
                  </Row>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {actor.isStaff && data && (
          <Card>
            <CardHeader title="Email notifications" />
            <div className="flex items-start gap-4 px-5 py-4">
              <Bell className="mt-0.5 size-5 text-muted" aria-hidden />
              <Checkbox
                checked={data.notifyDigest}
                onChange={(e) =>
                  run(
                    { path: '/account/preferences', method: 'PATCH', body: { notifyDigest: e.target.checked } },
                    'Notification preference saved.',
                  )
                }
                label="Email me about expirations"
                description="Alerts when certificates, domains, licences, warranties, password rotations, and document reviews come due, plus a Monday digest."
              />
            </div>
          </Card>
        )}
      </div>
      <PasswordDialog open={changing} onClose={() => setChanging(false)} />
      <PasskeyDialog
        open={addingKey}
        onClose={(newCodes) => {
          setAddingKey(false);
          void security.refetch();
          if (newCodes?.length) setCodes(newCodes);
          else if (newCodes) toast('Passkey added.');
        }}
      />
      <Dialog open={!!codes} onClose={() => setCodes(null)} size="sm" title="Your recovery codes">
        {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
      </Dialog>
    </>
  );
}
