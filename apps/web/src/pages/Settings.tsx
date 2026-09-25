import { useState, type FormEvent } from 'react';
import { Info, Mail, Send } from 'lucide-react';
import {
  SMTP_PRESETS,
  type NotificationSettings,
  type SmtpPreset,
  type SmtpSecurity,
  type SmtpSettingsView,
} from '@atlas/shared';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { useEmailSettings, useNotificationSettings, useSave } from '@/lib/queries';
import { ApiKeysCard, BrandingCard } from './SettingsExtra';

const SECURITY_LABEL: Record<SmtpSecurity, string> = {
  starttls: 'STARTTLS (usually port 587)',
  tls: 'TLS from the start (usually port 465)',
  none: 'None (trusted internal relay only)',
};

function EmailSettings({ current }: { current: SmtpSettingsView }) {
  const actor = useActor();
  const toast = useToast();
  const [form, setForm] = useState({ ...current, password: '', clientSecret: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [testTo, setTestTo] = useState(actor.email);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const save = useSave(
    (body: object) => api<SmtpSettingsView>('/settings/email', { method: 'PUT', body }),
    [['settings', 'email'], ['setup']],
  );
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  // Microsoft 365 via Graph is its own choice; the SMTP presets fill in the server details.
  type Service = 'graph' | SmtpPreset;
  const service: Service = form.method === 'graph' ? 'graph' : form.preset;
  const chooseService = (next: Service) => {
    if (next === 'graph') return setForm((f) => ({ ...f, method: 'graph' }));
    const p = SMTP_PRESETS[next];
    setForm((f) => ({
      ...f,
      method: 'smtp',
      preset: next,
      ...(next === 'm365'
        ? { host: p.host, port: p.port, security: p.security, fromAddress: f.fromAddress || f.username }
        : {}),
    }));
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const { hasPassword: _hasPassword, hasClientSecret: _hasSecret, password, clientSecret, ...rest } = form;
    try {
      await save.mutateAsync({ ...rest, ...(password ? { password } : {}), ...(clientSecret ? { clientSecret } : {}) });
      toast(form.enabled ? 'Email settings saved. Send a test to check them.' : 'Email settings saved.');
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const sendTest = async () => {
    setTesting(true);
    setTestError(null);
    try {
      await api('/settings/email/test', { method: 'POST', body: { to: testTo } });
      toast(`Test email sent to ${testTo}.`);
    } catch (err) {
      setTestError((err as Error).message);
    } finally {
      setTesting(false);
    }
  };
  const m365 = service === 'm365';
  const graph = service === 'graph';
  const SERVICES: [Service, string][] = [
    ['graph', 'Microsoft 365 (app registration)'],
    ['m365', 'Microsoft 365 SMTP (legacy)'],
    ['custom', SMTP_PRESETS.custom.label],
  ];
  return (
    <Card>
      <CardHeader title="Email" description="Used for password reset links, expiry alerts, and the weekly digest." />
      <form onSubmit={submit} className="space-y-5 p-5" noValidate>
        <Checkbox
          checked={form.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
          label="Send email from Atlas"
          description="Turning this on also lets people reset a forgotten password from the sign-in page."
        />
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold">Mail service</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {SERVICES.map(([value, label]) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3 text-sm font-semibold has-checked:border-primary has-checked:bg-primary-soft/60"
              >
                <input
                  type="radio"
                  name="service"
                  checked={service === value}
                  onChange={() => chooseService(value)}
                  className="accent-(--primary)"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {graph && (
          <div className="flex gap-3 rounded-lg bg-info-soft p-3.5 text-sm text-text-2">
            <Info className="size-5 shrink-0 text-info" aria-hidden />
            <div className="space-y-1.5">
              <p>
                Atlas signs in as an <strong>app registration</strong> (OAuth2) and sends through Microsoft Graph. No
                mailbox password or SMTP sign-in is involved.
              </p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>
                  In the Microsoft Entra admin center, open <strong>App registrations → New registration</strong>{' '}
                  (single tenant, no redirect URI).
                </li>
                <li>
                  Under <strong>API permissions</strong>, add{' '}
                  <strong>Microsoft Graph → Application permissions → Mail.Send</strong>, then{' '}
                  <strong>Grant admin consent</strong>.
                </li>
                <li>
                  Under <strong>Certificates &amp; secrets</strong>, create a client secret and paste its <em>value</em>{' '}
                  below. Note when it expires.
                </li>
                <li>
                  Recommended: limit the app to the From mailbox with an Exchange Online application access policy or
                  RBAC for Applications, so it can't send as anyone else.
                </li>
              </ol>
            </div>
          </div>
        )}
        {m365 && (
          <div className="flex gap-3 rounded-lg bg-warning-soft p-3.5 text-sm text-text-2">
            <Info className="size-5 shrink-0 text-warning" aria-hidden />
            <p>
              Microsoft is retiring basic authentication for SMTP in Exchange Online. Use{' '}
              <strong>Microsoft 365 (app registration)</strong> instead. Until then: sign in as a licensed mailbox, turn
              on <strong>Authenticated SMTP</strong> for it, and use an app password if it has MFA.
            </p>
          </div>
        )}
        {graph && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Directory (tenant) ID" error={error?.fields?.tenantId}>
                {(p) => (
                  <Input
                    {...p}
                    value={form.tenantId}
                    onChange={(e) => set('tenantId', e.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    autoComplete="off"
                    className="font-mono"
                  />
                )}
              </Field>
              <Field label="Application (client) ID" error={error?.fields?.clientId}>
                {(p) => (
                  <Input
                    {...p}
                    value={form.clientId}
                    onChange={(e) => set('clientId', e.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    autoComplete="off"
                    className="font-mono"
                  />
                )}
              </Field>
            </div>
            <Field
              label="Client secret"
              error={error?.fields?.clientSecret}
              help={
                current.hasClientSecret
                  ? 'Saved and encrypted. Leave empty to keep it; paste a new one before it expires.'
                  : 'The secret’s value (not its ID). Stored encrypted with the master key.'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  value={form.clientSecret}
                  onChange={(e) => set('clientSecret', e.target.value)}
                  autoComplete="new-password"
                  placeholder={current.hasClientSecret ? '••••••••' : ''}
                />
              )}
            </Field>
          </>
        )}
        {!graph && (
          <>
            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <Field label="SMTP server" error={error?.fields?.host}>
                {(p) => (
                  <Input
                    {...p}
                    value={form.host}
                    onChange={(e) => set('host', e.target.value)}
                    placeholder="smtp.example.com"
                    readOnly={m365}
                  />
                )}
              </Field>
              <Field label="Port" error={error?.fields?.port}>
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={1}
                    max={65535}
                    value={form.port}
                    onChange={(e) => set('port', Number(e.target.value))}
                    readOnly={m365}
                  />
                )}
              </Field>
            </div>
            <Field label="Encryption">
              {(p) => (
                <Select
                  {...p}
                  value={form.security}
                  onChange={(e) => set('security', e.target.value as SmtpSecurity)}
                  disabled={m365}
                >
                  {(Object.keys(SECURITY_LABEL) as SmtpSecurity[]).map((s) => (
                    <option key={s} value={s}>
                      {SECURITY_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Username"
                help={
                  m365
                    ? 'The mailbox address, e.g. atlas@yourdomain.com'
                    : 'Leave empty if the server needs no sign-in.'
                }
              >
                {(p) => (
                  <Input
                    {...p}
                    value={form.username}
                    onChange={(e) => set('username', e.target.value)}
                    autoComplete="off"
                  />
                )}
              </Field>
              <Field
                label="Password"
                help={current.hasPassword ? 'Saved and encrypted. Leave empty to keep it.' : 'Stored encrypted.'}
              >
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    value={form.password}
                    onChange={(e) => set('password', e.target.value)}
                    autoComplete="new-password"
                    placeholder={current.hasPassword ? '••••••••' : ''}
                  />
                )}
              </Field>
            </div>
          </>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="From address"
            error={error?.fields?.fromAddress}
            help={graph ? 'A mailbox in this tenant. Messages are sent as this mailbox.' : undefined}
          >
            {(p) => (
              <Input
                {...p}
                type="email"
                value={form.fromAddress}
                onChange={(e) => set('fromAddress', e.target.value)}
                placeholder="atlas@yourdomain.com"
              />
            )}
          </Field>
          <Field label="From name">
            {(p) => <Input {...p} value={form.fromName} onChange={(e) => set('fromName', e.target.value)} />}
          </Field>
        </div>
        <FormError
          message={
            error && !['host', 'fromAddress', 'tenantId', 'clientId', 'clientSecret'].some((k) => error.fields?.[k])
              ? error.message
              : null
          }
        />
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save email settings
          </Button>
        </div>
      </form>
      <div className="border-t border-border p-5">
        <p className="mb-2 text-[13px] font-semibold">Send a test email</p>
        <div className="flex flex-wrap gap-2">
          <label className="min-w-56 flex-1">
            <span className="sr-only">Test recipient</span>
            <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          </label>
          <Button variant="secondary" onClick={sendTest} loading={testing} disabled={!current.enabled}>
            <Send /> Send test
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">
          {current.enabled ? 'Uses the saved settings.' : 'Save settings with email turned on first.'}
        </p>
        <FormError message={testError} />
      </div>
    </Card>
  );
}

const ALERT_OPTIONS = [60, 30, 14, 7, 3, 1];
const RETENTION = [
  { value: null, label: 'Keep forever' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
  { value: 1095, label: '3 years' },
  { value: 2555, label: '7 years' },
];

function NotificationSettingsCard({ current }: { current: NotificationSettings }) {
  const toast = useToast();
  const [form, setForm] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (body: object) => api<NotificationSettings>('/settings/notifications', { method: 'PUT', body }),
    [['settings', 'notifications']],
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      await save.mutateAsync(form);
      toast('Notification settings saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader title="Alerts and logs" description="When expiry emails go out, and how long logs are kept." />
      <form onSubmit={submit} className="space-y-5 p-5" noValidate>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">
            Email an alert this many days before something is due
          </legend>
          <div className="flex flex-wrap gap-2">
            {ALERT_OPTIONS.map((d) => (
              <label
                key={d}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm has-checked:border-primary has-checked:bg-primary-soft/60"
              >
                <input
                  type="checkbox"
                  className="size-4 accent-(--primary)"
                  checked={form.alertDays.includes(d)}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      alertDays: e.target.checked ? [...f.alertDays, d] : f.alertDays.filter((x) => x !== d),
                    }))
                  }
                />
                {d} day{d === 1 ? '' : 's'}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            An alert also goes out on the day itself. Each person can opt out on their account page.
          </p>
        </fieldset>
        <Checkbox
          checked={form.weeklyDigest}
          onChange={(e) => setForm((f) => ({ ...f, weeklyDigest: e.target.checked }))}
          label="Send a weekly digest on Monday mornings"
          description="Lists everything overdue or due in the coming weeks."
        />
        <Field
          label="Keep security and password logs for"
          help="Older entries are deleted automatically. Many compliance frameworks ask for at least one year."
        >
          {(p) => (
            <Select
              {...p}
              value={form.auditRetentionDays ?? ''}
              onChange={(e) =>
                setForm((f) => ({ ...f, auditRetentionDays: e.target.value ? Number(e.target.value) : null }))
              }
            >
              {RETENTION.map((r) => (
                <option key={r.label} value={r.value ?? ''}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <FormError message={error} />
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function Settings() {
  const email = useEmailSettings();
  const notifications = useNotificationSettings();
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Settings"
        description="Email, alerts, log retention, branding, and API keys."
      />
      <div className="grid max-w-3xl gap-6">
        {email.data ? (
          <EmailSettings key={JSON.stringify(email.data)} current={email.data} />
        ) : (
          <Card className="p-5">
            <Mail className="mb-3 size-5 text-muted" aria-hidden />
            <Skeleton className="h-40" />
          </Card>
        )}
        {notifications.data ? (
          <NotificationSettingsCard key={JSON.stringify(notifications.data)} current={notifications.data} />
        ) : (
          <Skeleton className="h-48" />
        )}
        <BrandingCard />
        <ApiKeysCard />
      </div>
    </>
  );
}
