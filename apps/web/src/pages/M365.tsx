import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, RefreshCw, Unplug } from 'lucide-react';
import type { ImportJobView, M365TenantLink, M365View } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  FormError,
  Input,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useClients } from '@/lib/queries';
import { JobSummary } from './DataTools';

type M365State = { connection: M365View | null; tenants: M365TenantLink[]; redirectUri: string };

const STATUS: Record<M365TenantLink['status'], { tone: 'success' | 'danger' | 'neutral'; label: string }> = {
  ok: { tone: 'success', label: 'Connected' },
  failed: { tone: 'danger', label: 'Needs attention' },
  unchecked: { tone: 'neutral', label: 'Waiting for consent' },
};

/** Microsoft 365 documentation sync: one multi-tenant app, each client's tenant linked and consented. */
export function M365Sync() {
  const toast = useToast();
  const clients = useClients();
  const state = useQuery({ queryKey: ['m365'], queryFn: () => api<M365State>('/integrations/m365') });
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api<ImportJobView>(`/import/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });
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

  // Back from Microsoft's consent screen: check that tenant straight away.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || !state.data?.connection) return;
    const query = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const outcome = query.get('m365');
    if (!outcome) return;
    handled.current = true;
    const client = query.get('client');
    window.history.replaceState(null, '', window.location.hash.split('?')[0]);
    if (outcome !== 'consented' || !client) {
      toast('Consent wasn’t granted. Open the link again as a Global Administrator of that tenant.', 'error');
      return;
    }
    api<M365State>(`/integrations/m365/tenants/${client}/check`, { method: 'POST', body: {} })
      .then(async (next) => {
        await state.refetch();
        const link = next.tenants.find((t) => t.clientId === client);
        if (link?.status === 'ok') toast(`${link.clientName} is connected to ${link.tenantName}.`);
        else toast(link?.detail ?? 'Atlas couldn’t sign in to that tenant yet.', 'error');
      })
      .catch((err: Error) => toast(err.message, 'error'));
  }, [state.data?.connection]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const clientSecret = String(form.get('clientSecret') ?? '');
    return act('save', async () => {
      await api('/integrations/m365', {
        method: 'PUT',
        body: {
          clientId: form.get('clientId'),
          autoSync: form.get('autoSync') === 'on',
          ...(clientSecret ? { clientSecret } : {}),
        },
      });
      await state.refetch();
      toast('Saved. Link each client to its tenant below.');
    });
  };
  const link = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    return act('link', async () => {
      await api('/integrations/m365/tenants', {
        method: 'POST',
        body: { clientId: form.get('clientId'), tenant: form.get('tenant') },
      });
      await state.refetch();
      formEl.reset();
      toast('Linked. Now grant consent in that tenant.');
    });
  };

  const data = state.data;
  const conn = data?.connection;
  const linked = new Set(data?.tenants.map((t) => t.clientId));
  return (
    <Card>
      <CardHeader
        title="Microsoft 365"
        description="Document each client's tenant: users as contacts, subscriptions as licenses, custom domains, and who the administrators are. Syncs every six hours."
      />
      <div className="space-y-5 p-5">
        {state.isLoading || !data ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            {!conn && (
              <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-text-2">
                <p className="font-medium text-text">In your own Microsoft Entra → App registrations:</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                  <li>
                    New registration, <strong>Supported account types</strong>: accounts in any organizational directory
                    (multitenant).
                  </li>
                  <li>
                    Add a <strong>Web</strong> redirect URI:
                  </li>
                </ol>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 rounded bg-surface px-2 py-1 font-mono text-xs break-all">
                    {data.redirectUri}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Copy the redirect URI"
                    onClick={() => navigator.clipboard.writeText(data.redirectUri).then(() => toast('Address copied.'))}
                  >
                    <Copy />
                  </Button>
                </div>
                <ol start={3} className="mt-1 list-decimal space-y-0.5 pl-5">
                  <li>
                    API permissions → Microsoft Graph → <strong>Application</strong> permission{' '}
                    <em>Directory.Read.All</em>. It only reads.
                  </li>
                  <li>Create a client secret and paste its Value below.</li>
                </ol>
              </div>
            )}
            <form onSubmit={save} className="space-y-4" noValidate>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Microsoft 365 app ID" help="The app registration's Application (client) ID.">
                  {(p) => (
                    <Input
                      {...p}
                      name="clientId"
                      defaultValue={conn?.clientId}
                      className="font-mono"
                      autoComplete="off"
                      required
                    />
                  )}
                </Field>
                <Field
                  label="Microsoft 365 app secret"
                  help={conn ? 'Saved and encrypted. Leave empty to keep it.' : undefined}
                >
                  {(p) => (
                    <Input
                      {...p}
                      name="clientSecret"
                      type="password"
                      autoComplete="off"
                      placeholder={conn ? '••••••••' : ''}
                    />
                  )}
                </Field>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Checkbox name="autoSync" defaultChecked={conn?.autoSync ?? true} label="Sync every six hours" />
                <Button type="submit" variant="secondary" loading={busy === 'save'} className="ml-auto">
                  {conn ? 'Save' : 'Connect'}
                </Button>
              </div>
            </form>
          </>
        )}
        {conn && data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">
                {conn.lastSyncAt ? `Last synced ${formatDateTime(conn.lastSyncAt)}` : 'Not synced yet'}
              </span>
              <Button
                className="ml-auto"
                loading={busy === 'sync'}
                disabled={job.data?.status === 'running' || !data.tenants.length}
                onClick={() =>
                  act('sync', async () => {
                    const { id } = await api<{ id: string }>('/integrations/m365/sync', { method: 'POST', body: {} });
                    setJobId(id);
                  })
                }
              >
                <RefreshCw /> Sync now
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  act('forget', async () => {
                    await api('/integrations/m365', { method: 'DELETE' });
                    await state.refetch();
                    toast('Microsoft 365 disconnected. The secret was deleted from Atlas; synced items stay.');
                  })
                }
              >
                <Unplug /> Disconnect
              </Button>
            </div>
            {job.data && <JobSummary job={job.data} />}
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">What to sync</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ['users', 'Users', 'As contacts, with their licenses and admin roles.'],
                    ['licensedOnly', 'Licensed users only', 'Skips shared mailboxes, rooms, and service accounts.'],
                    ['licenses', 'Subscriptions', 'As License assets, with seats bought and assigned.'],
                    ['domains', 'Custom domains', 'As Domain assets.'],
                  ] as const
                ).map(([key, label, help]) => (
                  <Checkbox
                    key={key}
                    label={label}
                    description={help}
                    checked={conn.options[key]}
                    disabled={busy === 'options' || (key === 'licensedOnly' && !conn.options.users)}
                    onChange={(e) =>
                      act('options', async () => {
                        await api('/integrations/m365/options', {
                          method: 'PUT',
                          body: { ...conn.options, [key]: e.target.checked },
                        });
                        await state.refetch();
                      })
                    }
                  />
                ))}
              </div>
            </fieldset>

            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Client tenants</h3>
              {data.tenants.length ? (
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {data.tenants.map((t) => (
                    <li key={t.clientId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{t.clientName}</p>
                        <p className="truncate text-xs text-muted">
                          {t.tenantName ? `${t.tenantName} · ` : ''}
                          <span className="font-mono">{t.tenantId}</span>
                        </p>
                        {t.detail && <p className="text-xs text-danger">{t.detail}</p>}
                      </div>
                      <Badge tone={STATUS[t.status].tone}>{STATUS[t.status].label}</Badge>
                      {t.status !== 'ok' && (
                        <a
                          href={t.consentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:underline"
                        >
                          Grant consent <ExternalLink className="size-3.5" aria-hidden />
                        </a>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `check-${t.clientId}`}
                        onClick={() =>
                          act(`check-${t.clientId}`, async () => {
                            await api(`/integrations/m365/tenants/${t.clientId}/check`, { method: 'POST', body: {} });
                            await state.refetch();
                          })
                        }
                      >
                        Check
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          act(`unlink-${t.clientId}`, async () => {
                            await api(`/integrations/m365/tenants/${t.clientId}`, { method: 'DELETE' });
                            await state.refetch();
                          })
                        }
                      >
                        Unlink
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">No clients linked yet.</p>
              )}
              <form onSubmit={link} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]" noValidate>
                <Field label="Client">
                  {(p) => (
                    <Select {...p} name="clientId" required defaultValue="">
                      <option value="" disabled>
                        Choose a client…
                      </option>
                      {(clients.data ?? [])
                        .filter((c) => !linked.has(c.id))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </Select>
                  )}
                </Field>
                <Field label="Tenant ID or domain">
                  {(p) => (
                    <Input {...p} name="tenant" placeholder="contoso.onmicrosoft.com" autoComplete="off" required />
                  )}
                </Field>
                <Button type="submit" variant="secondary" loading={busy === 'link'}>
                  Link tenant
                </Button>
              </form>
              <p className="text-xs text-muted">
                After linking, a Global Administrator of that tenant opens <strong>Grant consent</strong> and approves
                read access. Atlas checks the tenant when they come back.
              </p>
            </div>
          </>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}
