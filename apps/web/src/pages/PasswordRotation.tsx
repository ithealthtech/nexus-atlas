import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, RotateCw, ShieldOff, Trash2, X } from 'lucide-react';
import {
  ROTATION_ACCOUNT_TYPES,
  ROTATION_ACCOUNT_TYPE_LABELS,
  type CwRmmView,
  type PasswordView,
  type RotationAccountType,
  type RotationPolicyView,
  type RotationRunStatus,
  type RotationRunView,
  type RotationSettings,
  type RotationTargetView,
} from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
  type Tone,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
import { useClients } from '@/lib/queries';

const STATUS: Record<RotationRunStatus, { label: string; tone: Tone }> = {
  dispatched: { label: 'Waiting for device', tone: 'info' },
  candidate: { label: 'Setting password', tone: 'info' },
  succeeded: { label: 'Rotated', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

/** Runs one action at a time for a card, with its error. */
function useAct() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, act };
}

function RotationSettingsCard() {
  const toast = useToast();
  const { busy, error, act } = useAct();
  const settings = useQuery({
    queryKey: ['rotation-settings'],
    queryFn: () => api<RotationSettings>('/rotation/settings'),
  });
  const rmm = useQuery({ queryKey: ['cw-rmm'], queryFn: () => api<CwRmmView | null>('/integrations/cw-rmm') });
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    return act('save', async () => {
      await api('/rotation/settings', {
        method: 'PUT',
        body: { enabled: form.get('enabled') === 'on', scriptId: String(form.get('scriptId') ?? '') },
      });
      await settings.refetch();
      toast('Rotation settings saved.');
    });
  };
  return (
    <Card>
      <CardHeader
        title="ConnectWise RMM script"
        description="Rotations run the Atlas rotation script on the device through ConnectWise RMM. The device reports the new password to Atlas before setting it, and Atlas saves it only once the device confirms."
      />
      <div className="space-y-4 p-5">
        {settings.isLoading || rmm.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            {!rmm.data && (
              <FormError message="Connect ConnectWise RMM under Import & export first; rotation runs on its devices." />
            )}
            <ol className="list-decimal space-y-1 pl-5 text-sm text-text-2">
              <li>
                Give the ConnectWise RMM API key the Automation read and create permissions, as well as the ones syncing
                uses.
              </li>
              <li>
                Import <code className="font-mono text-[13px]">deploy/rmm/Invoke-AtlasPasswordRotation.ps1</code> into
                ConnectWise RMM as a PowerShell script, and enter its ID below.
              </li>
              <li>Add a policy, then choose the passwords to rotate.</li>
            </ol>
            <form onSubmit={save} className="space-y-4" noValidate>
              <Field label="Script ID" help="The rotation script's ID in ConnectWise RMM (Automation → Scripts).">
                {(p) => (
                  <Input
                    {...p}
                    name="scriptId"
                    defaultValue={settings.data?.scriptId}
                    autoComplete="off"
                    className="max-w-sm"
                  />
                )}
              </Field>
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox
                  name="enabled"
                  defaultChecked={settings.data?.enabled}
                  label="Rotate passwords automatically"
                  description="Turning this off cancels any rotation in progress."
                />
                <Button type="submit" variant="secondary" loading={busy === 'save'} className="ml-auto">
                  Save
                </Button>
              </div>
            </form>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <p className="mr-auto text-sm text-muted">
                Each rotation gets its own device token, good for 2 hours. Revoke them all if you think one leaked.
              </p>
              <Button
                variant="ghost"
                loading={busy === 'revoke'}
                onClick={() =>
                  act('revoke', async () => {
                    const { revoked } = await api<{ revoked: number }>('/rotation/revoke-tokens', {
                      method: 'POST',
                      body: {},
                    });
                    toast(`${revoked} device token${revoked === 1 ? '' : 's'} revoked.`);
                  })
                }
              >
                <ShieldOff /> Revoke device tokens
              </Button>
            </div>
          </>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}

function PolicyForm({ onSaved }: { onSaved: () => Promise<unknown> }) {
  const toast = useToast();
  const clients = useClients();
  const { busy, error, act } = useAct();
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    return act('save', async () => {
      await api('/rotation/policies', {
        method: 'PUT',
        body: {
          clientId: form.get('clientId') || null,
          accountType: form.get('accountType'),
          intervalDays: Number(form.get('intervalDays')),
          complexity: {
            length: Number(form.get('length')),
            upper: form.get('upper') === 'on',
            lower: form.get('lower') === 'on',
            digits: form.get('digits') === 'on',
            symbols: form.get('symbols') === 'on',
          },
          enabled: form.get('enabled') === 'on',
        },
      });
      await onSaved();
      toast('Policy saved.');
    });
  };
  return (
    <form onSubmit={save} className="space-y-4 border-t border-border p-5" noValidate>
      <p className="text-sm font-semibold">Add or replace a policy</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Client">
          {(p) => (
            <Select {...p} name="clientId" defaultValue="">
              <option value="">All clients (default)</option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Account type">
          {(p) => (
            <Select {...p} name="accountType" defaultValue="local_admin">
              {ROTATION_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ROTATION_ACCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Every (days)">
          {(p) => <Input {...p} name="intervalDays" type="number" min={1} max={365} defaultValue={30} />}
        </Field>
        <Field label="Length">
          {(p) => <Input {...p} name="length" type="number" min={12} max={128} defaultValue={24} />}
        </Field>
      </div>
      <div className="flex flex-wrap gap-4">
        <Checkbox name="upper" defaultChecked label="Upper case" />
        <Checkbox name="lower" defaultChecked label="Lower case" />
        <Checkbox name="digits" defaultChecked label="Digits" />
        <Checkbox name="symbols" defaultChecked label="Symbols" />
        <Checkbox name="enabled" defaultChecked label="Active" />
        <Button type="submit" variant="secondary" loading={busy === 'save'} className="ml-auto">
          Save policy
        </Button>
      </div>
      <FormError message={error} />
    </form>
  );
}

function Policies() {
  const toast = useToast();
  const { busy, error, act } = useAct();
  const policies = useQuery({
    queryKey: ['rotation-policies'],
    queryFn: () => api<RotationPolicyView[]>('/rotation/policies'),
  });
  return (
    <Card>
      <CardHeader
        title="Policies"
        description="How often each kind of account is rotated, and what its new password looks like. A client's own policy replaces the default for that client."
      />
      {policies.isLoading ? (
        <Skeleton className="m-5 h-20" />
      ) : policies.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Applies to</th>
                <th className="px-5 py-2.5 font-medium">Account type</th>
                <th className="px-5 py-2.5 font-medium">Every</th>
                <th className="px-5 py-2.5 font-medium">Password</th>
                <th className="px-5 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {policies.data.map((p) => (
                <tr key={p.id}>
                  <td className="px-5 py-2.5 font-medium">
                    {p.clientName ?? 'All clients'} {!p.enabled && <Badge>Paused</Badge>}
                  </td>
                  <td className="px-5 py-2.5">{ROTATION_ACCOUNT_TYPE_LABELS[p.accountType]}</td>
                  <td className="px-5 py-2.5">{p.intervalDays} days</td>
                  <td className="px-5 py-2.5 text-text-2">
                    {p.complexity.length} characters ·{' '}
                    {[
                      p.complexity.upper && 'upper',
                      p.complexity.lower && 'lower',
                      p.complexity.digits && 'digits',
                      p.complexity.symbols && 'symbols',
                    ]
                      .filter(Boolean)
                      .join(', ')}
                  </td>
                  <td className="px-5 py-2 text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove the policy for ${p.clientName ?? 'all clients'}`}
                      loading={busy === p.id}
                      onClick={() =>
                        act(p.id, async () => {
                          await api(`/rotation/policies/${p.id}`, { method: 'DELETE' });
                          await policies.refetch();
                          toast('Policy removed.');
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="p-5 text-sm text-muted">No policies yet, so nothing rotates. Add a default below.</p>
      )}
      {error && (
        <div className="px-5 pb-4">
          <FormError message={error} />
        </div>
      )}
      <PolicyForm onSaved={policies.refetch} />
    </Card>
  );
}

function AddAccount({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const toast = useToast();
  const clients = useClients();
  const { busy, error, act } = useAct();
  const [clientId, setClientId] = useState('');
  const passwords = useQuery({
    queryKey: ['passwords', { client: clientId }],
    queryFn: () => api<PasswordView[]>(`/passwords?client=${clientId}`),
    enabled: !!clientId,
  });
  const devices = useQuery({
    queryKey: ['rotation-devices', clientId],
    queryFn: () => api<{ id: string; name: string }[]>(`/rotation/clients/${clientId}/devices`),
    enabled: !!clientId,
  });
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    return act('add', async () => {
      await api('/rotation/targets', {
        method: 'POST',
        body: {
          passwordId: form.get('passwordId'),
          assetId: form.get('assetId'),
          accountType: form.get('accountType') as RotationAccountType,
        },
      });
      await onAdded();
      toast('Added. It rotates when its policy says it is due.');
    });
  };
  const logins = (passwords.data ?? []).filter((p) => p.kind === 'login');
  return (
    <form onSubmit={save} className="space-y-4 border-t border-border p-5" noValidate>
      <p className="text-sm font-semibold">Rotate a password</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Client">
          {(p) => (
            <Select {...p} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">Choose a client…</option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Password" help="Its username is the account the script changes.">
          {(p) => (
            <Select {...p} name="passwordId" disabled={!clientId}>
              {logins.map((pw) => (
                <option key={pw.id} value={pw.id}>
                  {pw.name}
                  {pw.username ? ` (${pw.username})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Run on device" help="For AD accounts, a domain controller.">
          {(p) => (
            <Select {...p} name="assetId" disabled={!clientId}>
              {(devices.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Account type">
          {(p) => (
            <Select {...p} name="accountType" defaultValue="local_admin">
              {ROTATION_ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ROTATION_ACCOUNT_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {clientId && devices.data && !devices.data.length && (
        <p className="text-sm text-muted">This client has no devices synced from ConnectWise RMM.</p>
      )}
      <Button
        type="submit"
        variant="secondary"
        loading={busy === 'add'}
        disabled={!clientId || !logins.length || !devices.data?.length}
      >
        Add
      </Button>
      <FormError message={error} />
    </form>
  );
}

function Accounts({ onChange }: { onChange: () => Promise<unknown> }) {
  const toast = useToast();
  const { busy, error, act } = useAct();
  const targets = useQuery({
    queryKey: ['rotation-targets'],
    queryFn: () => api<RotationTargetView[]>('/rotation/targets'),
  });
  const refresh = async () => {
    await targets.refetch();
    await onChange();
  };
  return (
    <Card>
      <CardHeader title="Passwords being rotated" />
      {targets.isLoading ? (
        <Skeleton className="m-5 h-20" />
      ) : targets.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-5 py-2.5 font-medium">Password</th>
                <th className="px-5 py-2.5 font-medium">Device</th>
                <th className="px-5 py-2.5 font-medium">Last rotated</th>
                <th className="px-5 py-2.5 font-medium">Next</th>
                <th className="px-5 py-2.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {targets.data.map((t) => (
                <tr key={t.id}>
                  <td className="px-5 py-2.5">
                    <AppLink to={`/passwords/${t.passwordId}`} className="font-medium">
                      {t.passwordName}
                    </AppLink>
                    <span className="block text-xs text-muted">
                      {t.clientName} · {ROTATION_ACCOUNT_TYPE_LABELS[t.accountType]}
                    </span>
                  </td>
                  <td className="px-5 py-2.5">{t.assetName}</td>
                  <td className="px-5 py-2.5">
                    {t.lastRotatedAt ? formatDate(t.lastRotatedAt) : 'Never'}
                    {t.lastStatus === 'failed' && (
                      <span className="block text-xs text-danger" title={t.lastError}>
                        Last attempt failed
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    {!t.enabled ? (
                      <Badge>Paused</Badge>
                    ) : !t.policyId ? (
                      <Badge tone="warning">No policy</Badge>
                    ) : t.nextDueAt ? (
                      formatDate(t.nextDueAt)
                    ) : null}
                  </td>
                  <td className="px-5 py-2 whitespace-nowrap text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === `rotate:${t.id}`}
                      disabled={!t.enabled || !t.policyId}
                      onClick={() =>
                        act(`rotate:${t.id}`, async () => {
                          await api(`/rotation/targets/${t.id}/rotate`, { method: 'POST', body: {} });
                          await refresh();
                          toast('Rotation started. The device reports back in a few minutes.');
                        })
                      }
                    >
                      <RotateCw /> Rotate now
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={
                        t.enabled ? `Pause rotation of ${t.passwordName}` : `Resume rotation of ${t.passwordName}`
                      }
                      loading={busy === `pause:${t.id}`}
                      onClick={() =>
                        act(`pause:${t.id}`, async () => {
                          await api(`/rotation/targets/${t.id}`, { method: 'PATCH', body: { enabled: !t.enabled } });
                          await refresh();
                        })
                      }
                    >
                      {t.enabled ? <Pause /> : <Play />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Stop rotating ${t.passwordName}`}
                      loading={busy === `remove:${t.id}`}
                      onClick={() =>
                        act(`remove:${t.id}`, async () => {
                          await api(`/rotation/targets/${t.id}`, { method: 'DELETE' });
                          await refresh();
                          toast('Removed from rotation. The password stays in the vault.');
                        })
                      }
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState icon={RotateCw} title="No passwords are rotated yet" description="Choose one below." />
      )}
      {error && (
        <div className="px-5 pb-4">
          <FormError message={error} />
        </div>
      )}
      <AddAccount onAdded={refresh} />
    </Card>
  );
}

function Attempts() {
  const { busy, error, act } = useAct();
  const runs = useQuery({
    queryKey: ['rotation-runs'],
    queryFn: () => api<RotationRunView[]>('/rotation/runs'),
    refetchInterval: (q) =>
      q.state.data?.some((r) => r.status === 'dispatched' || r.status === 'candidate') ? 5000 : false,
  });
  if (!runs.data?.length) return null;
  return (
    <Card>
      <CardHeader
        title="Recent attempts"
        description="A failed attempt leaves the old password in the vault and emails administrators."
      />
      <ul className="divide-y divide-border">
        {runs.data.slice(0, 50).map((r) => (
          <li key={r.id} className="flex flex-wrap items-start gap-3 px-5 py-3 text-sm">
            <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {r.passwordName} <span className="font-normal text-muted">on {r.assetName}</span>
              </p>
              <p className="text-xs text-muted">
                {r.clientName} · {formatDateTime(r.createdAt)} · started by {r.startedByName}
              </p>
              {r.error && <p className="mt-1 text-xs text-danger">{r.error}</p>}
            </div>
            {(r.status === 'dispatched' || r.status === 'candidate') && (
              <Button
                variant="ghost"
                size="sm"
                loading={busy === r.id}
                onClick={() =>
                  act(r.id, async () => {
                    await api(`/rotation/runs/${r.id}/cancel`, { method: 'POST', body: {} });
                    await runs.refetch();
                  })
                }
              >
                <X /> Cancel
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <div className="px-5 pb-4">
          <FormError message={error} />
        </div>
      )}
    </Card>
  );
}

/** Automated rotation of local administrator and AD service account passwords, through ConnectWise RMM. */
export function PasswordRotation() {
  const runs = useQuery({ queryKey: ['rotation-runs'], queryFn: () => api<RotationRunView[]>('/rotation/runs') });
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Password rotation"
        description="Change local administrator and AD service account passwords on a schedule, and keep the new ones in the vault. Every rotation is in the password's history and access log."
      />
      <div className="grid max-w-5xl gap-6">
        <RotationSettingsCard />
        <Policies />
        <Accounts onChange={runs.refetch} />
        <Attempts />
      </div>
    </>
  );
}
