import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { ArrowLeft, ArrowRight, Copy, Fingerprint, KeyRound, LifeBuoy, ShieldCheck, Smartphone } from 'lucide-react';
import type { SessionView } from '@atlas/shared';
import { Button, Checkbox, Field, FormError, Input } from '@/components/ui';
import { RecoveryCodes } from '@/components/RecoveryCodes';
import { addPasskey, passkeysSupported, signInWithPasskey, verifyWithPasskey } from '@/lib/passkeys';
import { DEMO } from '@/lib/demo';
import { ApiError, api } from '@/lib/api';
import { useApplySession } from '@/lib/session';
import { Logo } from '@/components/Logo';

type Stage = 'signin' | 'setup' | 'mfa' | 'password' | 'mfa-setup' | 'reset';

function useSubmit<T>(send: (values: Record<string, string>) => Promise<T>, done: (result: T) => void) {
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Capture the form now: React clears currentTarget once this handler awaits.
    const form = event.currentTarget;
    setBusy(true);
    setError(null);
    setFields({});
    try {
      done(await send(Object.fromEntries(new FormData(form)) as Record<string, string>));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      form.querySelector<HTMLInputElement>('input[name=code], input[type=password]')?.select();
    } finally {
      setBusy(false);
    }
  };
  return { error, fields, busy, onSubmit };
}

export function AuthScreen({
  stage,
  email,
  onSignOut,
  passwordReset = false,
  methods,
}: {
  stage: Stage;
  email?: string;
  onSignOut?: () => void;
  passwordReset?: boolean;
  methods?: SessionView['methods'];
}) {
  const apply = useApplySession();
  const done = (session: SessionView) => apply(session);
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-sidebar p-12 text-sidebar-text lg:flex lg:flex-col">
        <Logo className="text-white" />
        <div className="my-auto max-w-lg">
          <p className="mb-5 text-xs font-bold tracking-[0.18em] text-sidebar-muted uppercase">
            Documentation · Passwords · Clients
          </p>
          <h1 className="text-5xl leading-[1.08] font-semibold tracking-tight text-white">
            A clearer picture.
            <br />
            <span className="text-accent">For every client.</span>
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-sidebar-muted">
            Infrastructure, procedures, and credentials in one secure, connected workspace for your team and the clients
            you support.
          </p>
          <ul className="mt-10 space-y-4 text-sm">
            {[
              [ShieldCheck, 'Encrypted credentials with full access history'],
              [KeyRound, 'Per-client permissions for technicians and client contacts'],
              [Smartphone, 'Two-step verification for every staff account'],
            ].map(([Icon, text], i) => {
              const I = Icon as typeof ShieldCheck;
              return (
                <li key={i} className="flex items-center gap-3">
                  <span className="grid size-8 place-items-center rounded-lg bg-sidebar-2 text-accent">
                    <I className="size-4" aria-hidden />
                  </span>
                  {text as string}
                </li>
              );
            })}
          </ul>
        </div>
        <p className="text-xs text-sidebar-muted">Self-hosted. Your data stays on your servers.</p>
        <div
          className="pointer-events-none absolute -right-32 -bottom-32 size-96 rounded-full bg-accent/5"
          aria-hidden
        />
      </aside>
      <main id="main" className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-[420px]">
          <Logo className="mb-10 lg:hidden" />
          {stage === 'signin' && <SignIn done={done} passwordReset={passwordReset} />}
          {stage === 'setup' && <Setup done={done} />}
          {stage === 'mfa' && <VerifyMfa done={done} methods={methods ?? { totp: true, passkey: false }} />}
          {stage === 'password' && <ChangePassword done={done} />}
          {stage === 'reset' && <ResetPassword />}
          {stage === 'mfa-setup' && <EnrollMfa done={done} email={email ?? ''} />}
          {onSignOut && stage !== 'signin' && stage !== 'setup' && stage !== 'reset' && (
            <p className="mt-6 text-center text-sm text-muted">
              Not you?{' '}
              <button className="font-semibold text-primary underline underline-offset-2" onClick={onSignOut}>
                Sign out
              </button>
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-7">
      <h2 className="text-2xl font-semibold tracking-tight text-text">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

type Done = { done: (session: SessionView) => void };

function SignIn({ done, passwordReset }: Done & { passwordReset: boolean }) {
  const [forgot, setForgot] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const { error, busy, onSubmit } = useSubmit((v) => api<SessionView>('/session', { method: 'POST', body: v }), done);
  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} />;
  const withPasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      done(await signInWithPasskey());
    } catch (e) {
      setPasskeyError((e as Error).message);
    } finally {
      setPasskeyBusy(false);
    }
  };
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Sign in to Atlas">
        {DEMO
          ? 'This is a demo with sample data. The sign-in details are filled in; on the next step, any 6-digit code works.'
          : 'Use the account your administrator created for you.'}
      </Heading>
      <Field label="Email">
        {(p) => (
          <Input
            {...p}
            name="email"
            type="email"
            autoComplete="username webauthn"
            required
            autoFocus
            defaultValue={DEMO ? 'alex@itdoneright.demo' : undefined}
          />
        )}
      </Field>
      <Field label="Password">
        {(p) => (
          <Input
            {...p}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            defaultValue={DEMO ? 'demo-password' : undefined}
          />
        )}
      </Field>
      <FormError message={error ?? passkeyError} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Sign in <ArrowRight />
      </Button>
      {passkeysSupported() && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>
          <Button variant="secondary" size="lg" className="w-full" onClick={withPasskey} loading={passkeyBusy}>
            <Fingerprint /> Sign in with a passkey
          </Button>
        </>
      )}
      <p className="text-center text-xs text-muted">
        {passwordReset ? (
          <button type="button" className="font-semibold text-primary hover:underline" onClick={() => setForgot(true)}>
            Forgot your password?
          </button>
        ) : (
          'Forgot your password? Ask an Atlas administrator to issue a temporary one.'
        )}
      </p>
    </form>
  );
}

function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [sent, setSent] = useState('');
  const { error, busy, onSubmit } = useSubmit(
    async (v) => {
      await api('/password-reset', { method: 'POST', body: v });
      return v.email ?? '';
    },
    (email) => setSent(email),
  );
  if (sent)
    return (
      <div className="space-y-5">
        <Heading title="Check your email">
          If {sent} has an Atlas account, a reset link is on its way. The link works once and expires in one hour.
        </Heading>
        <Button variant="secondary" size="lg" className="w-full" onClick={onBack}>
          <ArrowLeft /> Back to sign in
        </Button>
      </div>
    );
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Reset your password">
        Enter your email and we&rsquo;ll send you a link to choose a new password. Two-step verification still applies
        afterwards.
      </Heading>
      <Field label="Email">
        {(p) => <Input {...p} name="email" type="email" autoComplete="username" required autoFocus />}
      </Field>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Email me a reset link <ArrowRight />
      </Button>
      <Button variant="link" className="w-full" onClick={onBack}>
        Back to sign in
      </Button>
    </form>
  );
}

function Setup({ done }: Done) {
  const { error, fields, busy, onSubmit } = useSubmit(
    (v) => api<SessionView>('/setup', { method: 'POST', body: v }),
    done,
  );
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Welcome to Atlas">
        Create the owner account. You&rsquo;ll find the setup code in the Atlas server console or service log.
      </Heading>
      <Field label="Setup code" error={fields.setupCode}>
        {(p) => <Input {...p} name="setupCode" autoComplete="off" required autoFocus className="font-mono" />}
      </Field>
      <Field label="Company name" help="Your MSP's name, shown throughout Atlas." error={fields.organization}>
        {(p) => <Input {...p} name="organization" autoComplete="organization" required />}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Your name" error={fields.name}>
          {(p) => <Input {...p} name="name" autoComplete="name" required />}
        </Field>
        <Field label="Email" error={fields.email}>
          {(p) => <Input {...p} name="email" type="email" autoComplete="username" required />}
        </Field>
      </div>
      <Field label="Password" help="At least 12 characters. A long passphrase is best." error={fields.password}>
        {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" required minLength={12} />}
      </Field>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Create owner account <ArrowRight />
      </Button>
    </form>
  );
}

function CodeInput(props: { id: string }) {
  return (
    <Input
      {...props}
      name="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="[0-9]{6}"
      maxLength={6}
      required
      autoFocus
      className="h-12 text-center font-mono text-xl tracking-[0.5em]"
    />
  );
}

function VerifyMfa({ done, methods }: Done & { methods: NonNullable<SessionView['methods']> }) {
  const [mode, setMode] = useState<'totp' | 'passkey' | 'recovery'>(methods.totp ? 'totp' : 'passkey');
  const [remember, setRemember] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const totpForm = useSubmit(
    (v) => api<SessionView>('/session/mfa', { method: 'POST', body: { code: v.code, remember } }),
    done,
  );
  const recoveryForm = useSubmit(
    (v) => api<SessionView>('/session/recovery', { method: 'POST', body: { code: v.recovery, remember } }),
    done,
  );
  const usePasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      done(await verifyWithPasskey(remember));
    } catch (e) {
      setPasskeyError((e as Error).message);
    } finally {
      setPasskeyBusy(false);
    }
  };
  const rememberBox = (
    <Checkbox
      checked={remember}
      onChange={(e) => setRemember(e.target.checked)}
      label="Remember this browser for 30 days"
      description="Skip this step here. Only choose this on your own device."
    />
  );
  const others = (
    <div className="flex flex-col items-center gap-1.5 text-sm">
      {mode !== 'totp' && methods.totp && (
        <Button variant="link" onClick={() => setMode('totp')}>
          <Smartphone /> Use your authenticator app
        </Button>
      )}
      {mode !== 'passkey' && methods.passkey && (
        <Button variant="link" onClick={() => setMode('passkey')}>
          <Fingerprint /> Use a passkey
        </Button>
      )}
      {mode !== 'recovery' && (
        <Button variant="link" onClick={() => setMode('recovery')}>
          <LifeBuoy /> Use a recovery code
        </Button>
      )}
    </div>
  );
  if (mode === 'passkey')
    return (
      <div className="space-y-5">
        <Heading title="Two-step verification">Confirm it&rsquo;s you with your passkey or security key.</Heading>
        {rememberBox}
        <FormError message={passkeyError} />
        <Button size="lg" className="w-full" onClick={usePasskey} loading={passkeyBusy} autoFocus>
          <Fingerprint /> Use passkey
        </Button>
        {others}
      </div>
    );
  if (mode === 'recovery')
    return (
      <form onSubmit={recoveryForm.onSubmit} className="space-y-5" noValidate>
        <Heading title="Use a recovery code">
          Enter one of the recovery codes you saved when you turned on two-step verification. Each code works once.
        </Heading>
        <Field label="Recovery code">
          {(p) => (
            <Input
              {...p}
              name="recovery"
              autoComplete="one-time-code"
              placeholder="abcde-12345"
              required
              autoFocus
              className="h-12 text-center font-mono text-lg tracking-widest"
            />
          )}
        </Field>
        {rememberBox}
        <FormError message={recoveryForm.error} />
        <Button type="submit" size="lg" className="w-full" loading={recoveryForm.busy}>
          Verify <ArrowRight />
        </Button>
        {others}
      </form>
    );
  return (
    <form onSubmit={totpForm.onSubmit} className="space-y-5" noValidate>
      <Heading title="Two-step verification">Enter the 6-digit code from your authenticator app.</Heading>
      <Field label="Authentication code">{(p) => <CodeInput {...p} />}</Field>
      {rememberBox}
      <FormError message={totpForm.error} />
      <Button type="submit" size="lg" className="w-full" loading={totpForm.busy}>
        Verify <ArrowRight />
      </Button>
      {others}
    </form>
  );
}

/** Opened from the emailed link: /reset-password#<token>. */
function ResetPassword() {
  // Read the token once, then drop it from the address bar and history.
  const [token] = useState(() => {
    const value = window.location.hash.slice(1);
    if (value) window.history.replaceState(null, '', window.location.pathname);
    return value;
  });
  const [finished, setFinished] = useState(false);
  const { error, fields, busy, onSubmit } = useSubmit(
    (v) => api('/password-reset/complete', { method: 'POST', body: { token, password: v.password } }),
    () => setFinished(true),
  );
  const toSignIn = () => window.location.assign('/');
  if (finished)
    return (
      <div className="space-y-5">
        <Heading title="Password changed">
          You&rsquo;ve been signed out everywhere. Sign in with your new password. Two-step verification still applies.
        </Heading>
        <Button size="lg" className="w-full" onClick={toSignIn}>
          Sign in <ArrowRight />
        </Button>
      </div>
    );
  if (!token)
    return (
      <div className="space-y-5">
        <Heading title="This link is incomplete">
          Open the reset link from your email again, or ask for a new one from the sign-in page.
        </Heading>
        <Button size="lg" className="w-full" onClick={toSignIn}>
          Go to sign in
        </Button>
      </div>
    );
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Choose a new password">Use at least 12 characters. A long passphrase is best.</Heading>
      <Field label="New password" error={fields.password}>
        {(p) => <Input {...p} name="password" type="password" autoComplete="new-password" required autoFocus />}
      </Field>
      <FormError message={fields.password ? null : error} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Save new password <ArrowRight />
      </Button>
      {error && !fields.password && (
        <Button variant="link" className="w-full" onClick={toSignIn}>
          Ask for a new link
        </Button>
      )}
    </form>
  );
}

function ChangePassword({ done }: Done) {
  const { error, fields, busy, onSubmit } = useSubmit(
    (v) => api<SessionView>('/account/password', { method: 'POST', body: v }),
    done,
  );
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Choose your password">
        Your administrator gave you a temporary password. Replace it with one only you know.
      </Heading>
      <Field label="Temporary password" error={fields.current}>
        {(p) => <Input {...p} name="current" type="password" autoComplete="current-password" required autoFocus />}
      </Field>
      <Field label="New password" help="At least 12 characters. A long passphrase is best." error={fields.next}>
        {(p) => <Input {...p} name="next" type="password" autoComplete="new-password" required minLength={12} />}
      </Field>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Save password <ArrowRight />
      </Button>
    </form>
  );
}

type Enrolled = SessionView & { recoveryCodes?: string[] };

export function EnrollMfa({ done, email }: Done & { email: string }) {
  const [codes, setCodes] = useState<{ session: SessionView; codes: string[] } | null>(null);
  const [passkey, setPasskey] = useState(false);
  // New recovery codes are shown before continuing, because they can't be shown again.
  const finish = (result: Enrolled) =>
    result.recoveryCodes?.length ? setCodes({ session: result, codes: result.recoveryCodes }) : done(result);
  if (codes)
    return (
      <div className="space-y-5">
        <Heading title="Save your recovery codes">Two-step verification is on.</Heading>
        <RecoveryCodes codes={codes.codes} onDone={() => done(codes.session)} doneLabel="Continue to Atlas" />
      </div>
    );
  if (passkey) return <EnrollPasskey done={finish} onBack={() => setPasskey(false)} />;
  return (
    <EnrollTotp done={finish} email={email} onPasskey={passkeysSupported() ? () => setPasskey(true) : undefined} />
  );
}

function EnrollPasskey({ done, onBack }: { done: (s: Enrolled) => void; onBack: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get('name') ?? '');
    setBusy(true);
    setError(null);
    try {
      done(await addPasskey(name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      <Heading title="Use a passkey">
        Windows Hello, Touch ID, your phone, or a security key such as a YubiKey. You&rsquo;ll confirm with your PIN,
        fingerprint, or face.
      </Heading>
      <Field label="Name this passkey" help="So you can tell your passkeys apart later.">
        {(p) => <Input {...p} name="name" defaultValue="Work laptop" required maxLength={60} autoFocus />}
      </Field>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        <Fingerprint /> Create passkey
      </Button>
      <Button variant="link" className="w-full" onClick={onBack}>
        Use an authenticator app instead
      </Button>
    </form>
  );
}

function EnrollTotp({
  done,
  email,
  onPasskey,
}: {
  done: (s: Enrolled) => void;
  email: string;
  onPasskey?: () => void;
}) {
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null);
  const [qr, setQr] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api<{ secret: string; uri: string }>('/account/mfa/setup', { method: 'POST', body: {} })
      .then(async (e) => {
        setEnrollment(e);
        setQr(await QRCode.toDataURL(e.uri, { margin: 1, width: 200, color: { dark: '#173e32', light: '#ffffff' } }));
      })
      .catch((e: Error) => setLoadError(e.message));
  }, []);
  const { error, busy, onSubmit } = useSubmit(
    (v) => api<Enrolled>('/account/mfa/confirm', { method: 'POST', body: v }),
    done,
  );
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Protect your account">
        Staff accounts use an authenticator app such as Microsoft Authenticator, Google Authenticator, or 1Password.
      </Heading>
      <FormError message={loadError} />
      <ol className="space-y-5 text-sm">
        <li>
          <p className="mb-3 font-semibold">1. Scan this code with your app</p>
          <div className="flex items-center gap-4 rounded-xl border border-border bg-surface-2 p-4">
            {qr ? (
              <img
                src={qr}
                alt={`QR code to add ${email} to an authenticator app`}
                className="size-32 rounded-lg bg-white p-1"
              />
            ) : (
              <div className="size-32 animate-pulse rounded-lg bg-surface-3" />
            )}
            <div className="min-w-0 text-xs text-muted">
              Can&rsquo;t scan? Enter this key:
              <code className="mt-1.5 block font-mono text-sm leading-relaxed font-semibold break-all text-text">
                {enrollment?.secret.match(/.{1,4}/g)?.join(' ') ?? '…'}
              </code>
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1 font-semibold text-primary hover:underline"
                disabled={!enrollment}
                onClick={async () => {
                  await navigator.clipboard.writeText(enrollment!.secret);
                  setCopied(true);
                }}
              >
                <Copy className="size-3" aria-hidden /> {copied ? 'Copied' : 'Copy key'}
              </button>
            </div>
          </div>
        </li>
        <li>
          <Field label="2. Enter the 6-digit code it shows">{(p) => <CodeInput {...p} />}</Field>
        </li>
      </ol>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!enrollment}>
        Turn on two-step verification <ArrowRight />
      </Button>
      {onPasskey && (
        <Button variant="link" className="w-full" onClick={onPasskey}>
          <Fingerprint /> Use a passkey instead
        </Button>
      )}
    </form>
  );
}
