import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Unplug } from 'lucide-react';
import {
  CW_RMM_REGIONS,
  CW_RMM_REGION_LABELS,
  type CwRmmCompany,
  type CwRmmRegion,
  type CwRmmView,
  type ImportJobView,
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
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useClients } from '@/lib/queries';
import { JobSummary } from './DataTools';

/** What the admin picked for one company in the mapping table. '' leaves it undecided. */
type Choice = '' | 'skip' | 'create' | `client:${string}`;

const choiceOf = (c: CwRmmCompany): Choice =>
  c.action === 'skip' ? 'skip' : c.action === 'link' && c.clientId ? `client:${c.clientId}` : '';

function CompanyMapping() {
  const toast = useToast();
  const clients = useClients();
  const companies = useQuery({
    queryKey: ['cw-rmm-companies'],
    queryFn: () => api<CwRmmCompany[]>('/integrations/cw-rmm/companies'),
  });
  // Only what the admin changed is kept; everything else shows the saved choice.
  const [edits, setEdits] = useState<Record<string, Choice>>({});
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Undecided companies start on the suggested same-name client.
  const choices = useMemo(
    () =>
      Object.fromEntries(
        (companies.data ?? []).map((c) => [
          c.id,
          edits[c.id] ??
            (c.action ? choiceOf(c) : c.suggestedClientId ? (`client:${c.suggestedClientId}` as Choice) : ''),
        ]),
      ) as Record<string, Choice>,
    [companies.data, edits],
  );
  const setChoices = (update: (prev: Record<string, Choice>) => Record<string, Choice>) => setEdits(update(choices));
  const changed = useMemo(
    () => (companies.data ?? []).filter((c) => (choices[c.id] ?? '') !== choiceOf(c)),
    [companies.data, choices],
  );
  const shown = (companies.data ?? []).filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/integrations/cw-rmm/companies', {
        method: 'PUT',
        body: {
          mappings: changed.map((c) => {
            const choice = choices[c.id] ?? '';
            return choice.startsWith('client:')
              ? { companyId: c.id, action: 'link', clientId: choice.slice(7) }
              : { companyId: c.id, action: choice || 'clear' };
          }),
        },
      });
      await companies.refetch();
      setEdits({});
      toast('Company links saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (companies.isLoading) return <Skeleton className="h-40" />;
  if (companies.error) return <FormError message={(companies.error as Error).message} />;
  const linked = (companies.data ?? []).filter((c) => c.action === 'link').length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-sm font-semibold">
          Companies{' '}
          <span className="font-normal text-muted">
            · {linked} linked of {companies.data?.length ?? 0}
          </span>
        </p>
        <label className="w-full sm:w-56">
          <span className="sr-only">Filter companies</span>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter companies…" />
        </label>
      </div>
      <div className="max-h-96 overflow-y-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-2 text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">ConnectWise RMM company</th>
              <th className="px-4 py-2.5 font-medium">Atlas client</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2.5 font-medium">{c.name}</td>
                <td className="px-4 py-2">
                  <label>
                    <span className="sr-only">Atlas client for {c.name}</span>
                    <Select
                      value={choices[c.id] ?? ''}
                      onChange={(e) => setChoices((prev) => ({ ...prev, [c.id]: e.target.value as Choice }))}
                      className="h-8"
                    >
                      <option value="">Not decided (not synced)</option>
                      <option value="create">Create a new client</option>
                      <option value="skip">Don&rsquo;t sync</option>
                      <optgroup label="Link to">
                        {(clients.data ?? []).map((cl) => (
                          <option key={cl.id} value={`client:${cl.id}`}>
                            {cl.name}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} loading={busy} disabled={!changed.length}>
          Save {changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'}` : 'links'}
        </Button>
        <p className="text-xs text-muted">Same-name clients are suggested. Nothing syncs until a company is linked.</p>
      </div>
      <FormError message={error} />
    </div>
  );
}

/** ConnectWise RMM (Asio): connect, link companies to clients, sync devices. */
export function CwRmmSync() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: ['cw-rmm'],
    queryFn: () => api<CwRmmView | null>('/integrations/cw-rmm'),
  });
  const refetchConnection = connection.refetch;
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api<ImportJobView>(`/import/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });
  useEffect(() => {
    if (job.data && job.data.status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
      void refetchConnection();
    }
  }, [job.data, queryClient, refetchConnection]);

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
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const clientSecret = String(form.get('clientSecret') ?? '');
    return act('save', async () => {
      const saved = await api<CwRmmView & { companies: number }>('/integrations/cw-rmm', {
        method: 'PUT',
        body: {
          region: form.get('region') as CwRmmRegion,
          clientId: form.get('clientId'),
          autoSync: form.get('autoSync') === 'on',
          ...(clientSecret ? { clientSecret } : {}),
        },
      });
      await connection.refetch();
      await queryClient.invalidateQueries({ queryKey: ['cw-rmm-companies'] });
      toast(`Connected. ${saved.companies} companies found; link them to clients below.`);
    });
  };
  const data = connection.data;
  return (
    <Card>
      <CardHeader
        title="ConnectWise RMM"
        description="Sync devices from ConnectWise RMM (Asio) into each client's Configurations, and sites into Locations. Runs hourly; devices removed from the RMM are archived."
      />
      <div className="space-y-5 p-5">
        {connection.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-[10rem_1fr_1fr]">
              <Field label="Region">
                {(p) => (
                  <Select {...p} name="region" defaultValue={data?.region ?? 'na'}>
                    {CW_RMM_REGIONS.map((r) => (
                      <option key={r} value={r}>
                        {CW_RMM_REGION_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Client ID" help="ConnectWise RMM → Integrations → API Access">
                {(p) => <Input {...p} name="clientId" defaultValue={data?.clientId} autoComplete="off" required />}
              </Field>
              <Field
                label="Client secret"
                help={
                  data
                    ? 'Saved and encrypted. Leave empty to keep it.'
                    : 'Needs companies, sites and devices read scopes.'
                }
              >
                {(p) => (
                  <Input
                    {...p}
                    name="clientSecret"
                    type="password"
                    autoComplete="off"
                    placeholder={data ? '••••••••' : ''}
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Checkbox name="autoSync" defaultChecked={data?.autoSync ?? true} label="Sync every hour" />
              <Button type="submit" variant="secondary" loading={busy === 'save'} className="ml-auto">
                {data ? 'Save and test' : 'Connect'}
              </Button>
            </div>
          </form>
        )}
        {data && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="success">Connected</Badge>
              <span className="text-sm text-muted">
                {data.lastSyncAt ? `Last synced ${formatDateTime(data.lastSyncAt)}` : 'Not synced yet'}
              </span>
              <Button
                className="ml-auto"
                loading={busy === 'sync'}
                disabled={job.data?.status === 'running'}
                onClick={() =>
                  act('sync', async () => {
                    const { id } = await api<{ id: string }>('/integrations/cw-rmm/sync', { method: 'POST', body: {} });
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
                    await api('/integrations/cw-rmm', { method: 'DELETE' });
                    await connection.refetch();
                    toast('ConnectWise RMM disconnected. The secret was deleted from Atlas; synced devices stay.');
                  })
                }
              >
                <Unplug /> Disconnect
              </Button>
            </div>
            {job.data && <JobSummary job={job.data} />}
            <CompanyMapping />
          </>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}
