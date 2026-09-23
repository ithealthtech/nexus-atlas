import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { ArrowRight, Copy, KeyRound, ShieldCheck, Smartphone } from 'lucide-react';
import type { SessionView } from '@atlas/shared';
import { Button, Field, FormError, Input } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useApplySession } from '@/lib/session';
import { Logo } from '@/components/Logo';

type Stage = 'signin' | 'setup' | 'mfa' | 'password' | 'mfa-setup';

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

export function AuthScreen({ stage, email, onSignOut }: { stage: Stage; email?: string; onSignOut?: () => void }) {
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
          {stage === 'signin' && <SignIn done={done} />}
          {stage === 'setup' && <Setup done={done} />}
          {stage === 'mfa' && <VerifyMfa done={done} />}
          {stage === 'password' && <ChangePassword done={done} />}
          {stage === 'mfa-setup' && <EnrollMfa done={done} email={email ?? ''} />}
          {onSignOut && stage !== 'signin' && stage !== 'setup' && (
            <p className="mt-6 text-center text-sm text-muted">
              Not you?{' '}
              <button className="font-semibold text-primary hover:underline" onClick={onSignOut}>
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

function SignIn({ done }: Done) {
  const { error, busy, onSubmit } = useSubmit((v) => api<SessionView>('/session', { method: 'POST', body: v }), done);
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Sign in to Atlas">Use the account your administrator created for you.</Heading>
      <Field label="Email">
        {(p) => <Input {...p} name="email" type="email" autoComplete="username" required autoFocus />}
      </Field>
      <Field label="Password">
        {(p) => <Input {...p} name="password" type="password" autoComplete="current-password" required />}
      </Field>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Sign in <ArrowRight />
      </Button>
      <p className="text-center text-xs text-muted">
        Forgot your password? Ask an Atlas administrator to issue a temporary one.
      </p>
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

function VerifyMfa({ done }: Done) {
  const { error, busy, onSubmit } = useSubmit(
    (v) => api<SessionView>('/session/mfa', { method: 'POST', body: v }),
    done,
  );
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <Heading title="Two-step verification">Enter the 6-digit code from your authenticator app.</Heading>
      <Field label="Authentication code">{(p) => <CodeInput {...p} />}</Field>
      <FormError message={error} />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Verify <ArrowRight />
      </Button>
      <p className="text-center text-xs text-muted">
        Lost your authenticator? An administrator can reset two-step verification for you.
      </p>
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

export function EnrollMfa({ done, email }: Done & { email: string }) {
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
    (v) => api<SessionView>('/account/mfa/confirm', { method: 'POST', body: v }),
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
    </form>
  );
}
