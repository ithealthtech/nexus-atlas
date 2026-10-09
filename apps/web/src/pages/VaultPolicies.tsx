import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Radio, ShieldAlert, ShieldCheck, Siren, UserPlus } from 'lucide-react';
import {
  EMERGENCY_ACCESS_HOURS,
  GENERATOR_MIN_LENGTH,
  ROLE_INFO,
  SYSLOG_TRANSPORTS,
  type EmergencyAccessView,
  type EmergencyRequestView,
  type EmergencyStatus,
  type SiemSettingsView,
  type SyslogTransport,
  type VaultPolicy,
  type VaultPolicyView,
} from '@atlas/shared';
import {
  Badge,
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
  Textarea,
  useToast,
  type Tone,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useSave, useUsers } from '@/lib/queries';
import { useActor } from '@/lib/session';

export const useVaultPolicyView = () =>
  useQuery({ queryKey: ['settings', 'vault-policy'], queryFn: () => api<VaultPolicyView>('/settings/vault-policy') });
const useEmergencyAccess = () =>
  useQuery({ queryKey: ['emergency-access'], queryFn: () => api<EmergencyAccessView>('/emergency-access') });
const useSiemSettings = () =>
  useQuery({ queryKey: ['settings', 'siem'], queryFn: () => api<SiemSettingsView>('/settings/siem') });

// ---------------------------------------------------------------- policies
function PoliciesCard({ current }: { current: VaultPolicyView }) {
  const actor = useActor();
  const toast = useToast();
  const owner = actor.role === 'owner';
  const { mfa, ...initial } = current;
  const [form, setForm] = useState<VaultPolicy>(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (body: VaultPolicy) => api<VaultPolicyView>('/settings/vault-policy', { method: 'PUT', body }),
    [['settings', 'vault-policy'], ['vault-policy'], ['passwords'], ['personal-vault']],
  );
  const generator = (patch: Partial<VaultPolicy['generator']>) =>
    setForm((f) => ({ ...f, generator: { ...f.generator, ...patch } }));
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      await save.mutateAsync(form);
      toast('Vault policies saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader
        title="Policies"
        description={
          owner
            ? 'Rules for everyone who uses the vault. Only the owner can change them.'
            : 'Rules for everyone who uses the vault. Only the owner can change them; you can see them here.'
        }
      />
      <form onSubmit={submit} className="space-y-6 p-5" noValidate>
        <section aria-labelledby="mfa-policy" className="space-y-2">
          <h3 id="mfa-policy" className="text-[13px] font-semibold">
            Multi-factor authentication
          </h3>
          <p className="flex items-start gap-2 text-sm">
            {mfa.requiredForStaff ? (
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            ) : (
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            )}
            <span>
              {mfa.requiredForStaff
                ? 'Required for all staff. Nobody on staff can reach the vault until they set up an authenticator app or a passkey.'
                : 'Not required: ATLAS_REQUIRE_STAFF_MFA is turned off on this server.'}{' '}
              <span className="text-muted">This is set on the server, not here.</span>
            </span>
          </p>
          {mfa.withoutMfa.length ? (
            <div className="rounded-lg border border-border">
              <p className="border-b border-border px-3 py-2 text-xs font-semibold text-text-2">
                {mfa.withoutMfa.length} account{mfa.withoutMfa.length === 1 ? '' : 's'} can reach passwords without MFA
              </p>
              <ul className="divide-y divide-border text-sm">
                {mfa.withoutMfa.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <span className="min-w-0">
                      <span className="font-medium">{u.name}</span> <span className="text-muted">{u.email}</span>
                    </span>
                    <Badge tone="warning">{ROLE_INFO[u.role].label}</Badge>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border px-3 py-2 text-xs text-muted">
                Client accounts aren’t made to set up MFA. Staff who sign in with Microsoft may be covered by
                Microsoft’s MFA instead, when the Entra settings trust it.
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted">Everyone who can reach passwords has MFA.</p>
          )}
        </section>

        <fieldset disabled={!owner} className="space-y-3">
          <legend className="mb-2 text-[13px] font-semibold">Password generator</legend>
          <Field
            label="Shortest generated password"
            help={`Characters. The generator won’t go below this. At least ${GENERATOR_MIN_LENGTH}.`}
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={GENERATOR_MIN_LENGTH}
                max={64}
                className="max-w-32"
                value={form.generator.minLength}
                onChange={(e) => generator({ minLength: Number(e.target.value) })}
              />
            )}
          </Field>
          <Checkbox
            checked={form.generator.requireDigits}
            onChange={(e) => generator({ requireDigits: e.target.checked })}
            label="Always include numbers"
          />
          <Checkbox
            checked={form.generator.requireSymbols}
            onChange={(e) => generator({ requireSymbols: e.target.checked })}
            label="Always include symbols"
          />
          <Checkbox
            checked={form.generator.allowPins}
            onChange={(e) => generator({ allowPins: e.target.checked })}
            label="Offer PINs"
            description="Short number codes, for door keypads and phones. Turn off if nobody should make one."
          />
        </fieldset>

        <fieldset disabled={!owner} className="space-y-3">
          <legend className="mb-2 text-[13px] font-semibold">Revealing passwords</legend>
          <Checkbox
            checked={form.requireRevealReason}
            onChange={(e) => setForm((f) => ({ ...f, requireRevealReason: e.target.checked }))}
            label="Require a reason for every reveal, copy, and share"
            description="Applies to every client. Clients can also require it one by one."
          />
          <Checkbox
            checked={form.blockReadOnlyReveal}
            onChange={(e) => setForm((f) => ({ ...f, blockReadOnlyReveal: e.target.checked }))}
            label="Don’t let read-only accounts reveal passwords"
            description="Client viewers still see which passwords are shared with them, but can’t reveal or copy them. Read-only technicians never can."
          />
          <Checkbox
            checked={form.restrictedListedOnly}
            onChange={(e) => setForm((f) => ({ ...f, restrictedListedOnly: e.target.checked }))}
            label="Restricted passwords are for the people listed on them"
            description="Administrators then need a place on the list too, or emergency access. The owner always has access."
          />
        </fieldset>

        <fieldset disabled={!owner}>
          <legend className="mb-2 text-[13px] font-semibold">Personal vaults</legend>
          <Checkbox
            checked={form.personalVaults}
            onChange={(e) => setForm((f) => ({ ...f, personalVaults: e.target.checked }))}
            label="Give each staff member a personal vault"
            description="A private place for their own logins and notes. Nobody else can open it, including you, and it isn’t in reports or the audit log. Turning this off hides the vaults without deleting anything."
          />
        </fieldset>

        <FormError message={error} />
        {owner && (
          <div className="flex justify-end">
            <Button type="submit" loading={save.isPending}>
              Save policies
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- emergency access
const STATUS: Record<EmergencyStatus, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  active: { label: 'Access on', tone: 'danger' },
  denied: { label: 'Denied', tone: 'neutral' },
  ended: { label: 'Ended', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};
const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
const WAITS = [1, 4, 12, 24, 48, 72, 168];

function RequestRow({
  request,
  owner,
  mine,
  act,
  busy,
}: {
  request: EmergencyRequestView;
  owner: boolean;
  mine: boolean;
  act: (id: string, action: 'approve' | 'deny' | 'end') => void;
  busy: boolean;
}) {
  const status = STATUS[request.status];
  const open = request.status === 'pending' || request.status === 'active';
  return (
    <li className="space-y-2 px-5 py-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>
          <span className="font-semibold">{request.userName}</span>{' '}
          <span className="text-muted">asked {formatDateTime(request.requestedAt)}</span>
        </p>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="text-text-2">“{request.reason}”</p>
      <p className="text-xs text-muted">
        {request.status === 'pending'
          ? `Access starts ${formatDateTime(request.availableAt)} unless the owner denies it.`
          : request.status === 'active'
            ? `Access on until ${formatDateTime(request.endsAt)}.`
            : request.decidedByName
              ? `${status.label} by ${request.decidedByName}${request.decidedAt ? ` · ${formatDateTime(request.decidedAt)}` : ''}.`
              : `Ended ${formatDateTime(request.endsAt)}.`}
      </p>
      {open && (owner || mine) && (
        <div className="flex flex-wrap gap-2">
          {owner && request.status === 'pending' && (
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => act(request.id, 'deny')}>
                Deny
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(request.id, 'approve')}>
                Approve now
              </Button>
            </>
          )}
          {(request.status === 'active' || (mine && !owner)) && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => act(request.id, 'end')}>
              {request.status === 'pending' ? 'Withdraw request' : 'End access'}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function EmergencyAccessCard({ listedOnly }: { listedOnly: boolean }) {
  const actor = useActor();
  const toast = useToast();
  const { data, refetch } = useEmergencyAccess();
  const owner = actor.role === 'owner';
  const users = useUsers(owner);
  const [pick, setPick] = useState('');
  const [wait, setWait] = useState(48);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refetch();
      toast(done);
      return true;
    } catch (err) {
      setError((err as ApiError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Skeleton className="h-48" />;
  const trusted = new Set(data.contacts.map((c) => c.userId));
  const candidates = (users.data ?? []).filter((u) => u.role === 'admin' && !u.disabled && !trusted.has(u.id));
  const act = (id: string, action: 'approve' | 'deny' | 'end') =>
    void run(
      () => api(`/emergency-access/requests/${id}/${action}`, { method: 'POST', body: {} }),
      action === 'approve'
        ? 'Emergency access approved.'
        : action === 'deny'
          ? 'Request denied.'
          : 'Emergency access ended.',
    );
  const open = data.requests.find((r) => r.userId === actor.id && (r.status === 'pending' || r.status === 'active'));
  return (
    <Card>
      <CardHeader
        title="Emergency access"
        description={`Administrators the owner trusts can ask for every restricted password when the owner can’t be reached. The owner is emailed at once and can deny it during the wait. Access then lasts ${hours(EMERGENCY_ACCESS_HOURS)}, and every password used is marked in its access history.`}
      />
      {!listedOnly && (
        <p className="flex items-start gap-2 border-b border-border px-5 py-3 text-sm text-text-2">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          Administrators already see restricted passwords. Emergency access matters once “Restricted passwords are for
          the people listed on them” is on.
        </p>
      )}
      {owner && (
        <div className="space-y-3 border-b border-border p-5">
          <h3 className="text-[13px] font-semibold">Trusted administrators</h3>
          {data.contacts.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {data.contacts.map((c) => (
                <li key={c.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{c.name}</span> <span className="text-muted">{c.email}</span>
                    <span className="block text-xs text-muted">Wait {hours(c.waitHours)}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api(`/emergency-access/contacts/${c.userId}`, { method: 'DELETE' }),
                        `${c.name} removed.`,
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nobody yet.</p>
          )}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!pick) return;
              void run(
                () => api('/emergency-access/contacts', { method: 'PUT', body: { userId: pick, waitHours: wait } }),
                'Trusted administrator added.',
              ).then((ok) => ok && setPick(''));
            }}
          >
            <Field label="Administrator" className="min-w-48 flex-1">
              {(p) => (
                <Select {...p} value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">{candidates.length ? 'Choose an administrator' : 'No other administrators'}</option>
                  {candidates.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Wait before access">
              {(p) => (
                <Select {...p} value={wait} onChange={(e) => setWait(Number(e.target.value))}>
                  {WAITS.map((w) => (
                    <option key={w} value={w}>
                      {w >= 24 && w % 24 === 0 ? `${w / 24} day${w === 24 ? '' : 's'}` : hours(w)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button type="submit" variant="secondary" disabled={!pick || busy}>
              <UserPlus /> Add
            </Button>
          </form>
        </div>
      )}
      {!owner && data.me.trusted && !open && (
        <form
          className="space-y-3 border-b border-border p-5"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api('/emergency-access/requests', { method: 'POST', body: { reason } }),
              'Emergency access requested. The owner has been told.',
            ).then((ok) => ok && setReason(''));
          }}
        >
          <p className="text-sm">
            The owner named you as a trusted administrator. If you ask, the owner is emailed and has{' '}
            {hours(data.me.waitHours ?? 0)} to deny it before your access starts.
          </p>
          <Field label="Why do you need emergency access?">
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                maxLength={300}
                value={reason}
                placeholder="e.g. Owner unreachable, client firewall down"
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="danger" disabled={!reason.trim() || busy}>
            <Siren /> Request emergency access
          </Button>
        </form>
      )}
      {!owner && !data.me.trusted && (
        <p className="border-b border-border px-5 py-3 text-sm text-muted">
          The owner hasn’t named you as a trusted administrator.
        </p>
      )}
      {error && (
        <div className="px-5 pt-4">
          <FormError message={error} />
        </div>
      )}
      {data.requests.length ? (
        <ul className="divide-y divide-border" aria-label="Emergency access requests">
          {data.requests.map((r) => (
            <RequestRow key={r.id} request={r} owner={owner} mine={r.userId === actor.id} act={act} busy={busy} />
          ))}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-muted">No requests yet.</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- SIEM
const TRANSPORT_LABEL: Record<SyslogTransport, string> = {
  tls: 'TLS (recommended, usually port 6514)',
  tcp: 'TCP (usually port 514)',
  udp: 'UDP (usually port 514)',
};

function SiemCard({ current }: { current: SiemSettingsView }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ ...current, secret: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<'test' | 'send' | null>(null);
  const save = useSave(
    (body: object) => api<SiemSettingsView>('/settings/siem', { method: 'PUT', body }),
    [['settings', 'siem']],
  );
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      const { secret, ...rest } = form;
      const saved = await save.mutateAsync({
        enabled: rest.enabled,
        method: rest.method,
        url: rest.url,
        host: rest.host,
        port: rest.port,
        transport: rest.transport,
        security: rest.security,
        vault: rest.vault,
        ...(secret ? { secret } : {}),
      });
      setForm({ ...saved, secret: '' });
      toast('SIEM settings saved.');
    } catch (err) {
      setError(err as ApiError);
    }
  };
  const action = async (kind: 'test' | 'send') => {
    setBusy(kind);
    setStatus(null);
    setError(null);
    try {
      if (kind === 'test') {
        await api('/settings/siem/test', { method: 'POST', body: {} });
        setStatus('Test event delivered.');
      } else {
        const result = await api<SiemSettingsView & { sent: number }>('/settings/siem/send', {
          method: 'POST',
          body: {},
        });
        setStatus(`${result.sent} event${result.sent === 1 ? '' : 's'} sent.`);
      }
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
      void queryClient.invalidateQueries({ queryKey: ['settings', 'siem'] });
    }
  };
  const fields = error?.fields ?? {};
  return (
    <Card>
      <CardHeader
        title="Stream logs to a SIEM"
        description="Sends the security log and the password access log as they happen, as JSON, to an HTTPS webhook or a syslog server."
      />
      <form onSubmit={submit} className="space-y-4 p-5" noValidate>
        <Checkbox
          checked={form.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
          label="Stream logs"
          description="Starts with what happens after you turn it on. Undelivered events are retried until they go through."
        />
        <Field label="Send by">
          {(p) => (
            <Select {...p} value={form.method} onChange={(e) => set('method', e.target.value as typeof form.method)}>
              <option value="webhook">HTTPS webhook</option>
              <option value="syslog">Syslog (RFC 5424)</option>
            </Select>
          )}
        </Field>
        {form.method === 'webhook' ? (
          <>
            <Field label="Webhook address" error={fields.url} help="Each batch is POSTed as JSON: { events: [...] }.">
              {(p) => (
                <Input
                  {...p}
                  type="url"
                  value={form.url}
                  placeholder="https://siem.example.com/collector"
                  onChange={(e) => set('url', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Signing secret"
              error={fields.secret}
              help={
                form.hasSecret
                  ? 'A secret is saved. Leave blank to keep it. Each body is signed in the X-Atlas-Signature header (sha256 HMAC).'
                  : 'Optional. Each body is signed in the X-Atlas-Signature header (sha256 HMAC).'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={form.secret}
                  onChange={(e) => set('secret', e.target.value)}
                />
              )}
            </Field>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field label="Syslog server" error={fields.host}>
              {(p) => (
                <Input
                  {...p}
                  value={form.host}
                  placeholder="siem.example.com"
                  onChange={(e) => set('host', e.target.value)}
                />
              )}
            </Field>
            <Field label="Port" error={fields.port}>
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  inputMode="numeric"
                  value={form.port}
                  onChange={(e) => set('port', Number(e.target.value))}
                />
              )}
            </Field>
            <Field label="Transport" className="sm:col-span-2">
              {(p) => (
                <Select
                  {...p}
                  value={form.transport}
                  onChange={(e) => set('transport', e.target.value as SyslogTransport)}
                >
                  {SYSLOG_TRANSPORTS.map((t) => (
                    <option key={t} value={t}>
                      {TRANSPORT_LABEL[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-semibold">Logs</legend>
          <Checkbox
            checked={form.security}
            onChange={(e) => set('security', e.target.checked)}
            label="Security log"
            description="Sign-ins, failures, lockouts, and changes to people and settings."
          />
          <Checkbox
            checked={form.vault}
            onChange={(e) => set('vault', e.target.checked)}
            label="Password access log"
            description="Every reveal, copy, change, and share, with the reason given."
          />
        </fieldset>
        {current.enabled && (
          <p className="text-xs text-muted" aria-live="polite">
            {current.lastError
              ? `Last attempt failed: ${current.lastError}`
              : current.lastSentAt
                ? `Last sent ${formatDateTime(current.lastSentAt)}.`
                : 'Nothing sent yet.'}{' '}
            {current.pending ? `${current.pending} event${current.pending === 1 ? '' : 's'} waiting.` : ''}
          </p>
        )}
        <FormError message={error && !Object.keys(fields).length ? error.message : null} />
        {status && (
          <p role="status" className="text-sm text-success">
            {status}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" loading={busy === 'test'} onClick={() => void action('test')}>
            <Radio /> Send a test event
          </Button>
          {current.enabled && (
            <Button type="button" variant="secondary" loading={busy === 'send'} onClick={() => void action('send')}>
              Send waiting events now
            </Button>
          )}
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function VaultPolicies() {
  const policy = useVaultPolicyView();
  const siem = useSiemSettings();
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Vault policies"
        description="Organization-wide rules for passwords, emergency access to restricted ones, and where the audit logs go."
      />
      <div className="grid gap-6">
        {policy.data ? (
          <PoliciesCard key={JSON.stringify(policy.data)} current={policy.data} />
        ) : (
          <Skeleton className="h-96" />
        )}
        <EmergencyAccessCard listedOnly={!!policy.data?.restrictedListedOnly} />
        {siem.data ? <SiemCard current={siem.data} /> : <Skeleton className="h-64" />}
      </div>
    </>
  );
}
