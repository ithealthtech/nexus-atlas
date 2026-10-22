import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Unplug } from 'lucide-react';
import { DEFAULT_BITDEFENDER_URL, type BitdefenderView, type ImportJobView } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  FormError,
  Input,
  Skeleton,
  useToast,
} from '@/components/ui';
import { CompanyMapping } from '@/components/CompanyMapping';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';
import { formatDateTime } from '@/lib/format';
import { JobSummary } from './DataTools';

/** Bitdefender GravityZone: connect with an API key, link companies to clients, sync endpoint protection. */
export function BitdefenderSync() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: ['bitdefender'],
    queryFn: () => api<BitdefenderView | null>('/integrations/bitdefender'),
  });
  const refetchConnection = connection.refetch;
  const [jobId, setJobId] = useState<string | null>(null);
  const { busy, error, act } = useAction();
  const job = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api<ImportJobView>(`/import/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });
  useEffect(() => {
    if (job.data && job.data.status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
      void queryClient.invalidateQueries({ queryKey: ['bitdefender'] });
      void refetchConnection();
    }
  }, [job.data, queryClient, refetchConnection]);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const apiKey = String(form.get('apiKey') ?? '').trim();
    return act('save', async () => {
      const saved = await api<BitdefenderView & { companies: number }>('/integrations/bitdefender', {
        method: 'PUT',
        body: {
          accessUrl: form.get('accessUrl'),
          autoSync: form.get('autoSync') === 'on',
          ...(apiKey ? { apiKey } : {}),
        },
      });
      await connection.refetch();
      await queryClient.invalidateQueries({ queryKey: ['bitdefender-companies'] });
      toast(
        `Connected. ${saved.companies} ${saved.companies === 1 ? 'company' : 'companies'} found; link them to clients below.`,
      );
    });
  };
  const data = connection.data;
  return (
    <Card>
      <CardHeader
        title="Bitdefender GravityZone"
        description="Each client's endpoint protection from GravityZone: what's infected, what needs attention, and devices Bitdefender doesn't cover. Shown on the client's overview and each device. Read-only, hourly."
      />
      <div className="space-y-5 p-5">
        {connection.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Access URL" help="GravityZone → My account → Control Center API.">
                {(p) => (
                  <Input
                    {...p}
                    name="accessUrl"
                    type="url"
                    defaultValue={data?.accessUrl ?? DEFAULT_BITDEFENDER_URL}
                    autoComplete="off"
                    required
                  />
                )}
              </Field>
              <Field
                label="API key"
                help={
                  data
                    ? 'Saved and encrypted. Leave empty to keep it.'
                    : 'Create one under My account → API keys with the Network and Companies APIs on. Service API keys work too.'
                }
              >
                {(p) => (
                  <Input {...p} name="apiKey" type="password" autoComplete="off" placeholder={data ? '••••••••' : ''} />
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
                    const { id } = await api<{ id: string }>('/integrations/bitdefender/sync', {
                      method: 'POST',
                      body: {},
                    });
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
                    await api('/integrations/bitdefender', { method: 'DELETE' });
                    await connection.refetch();
                    toast('Bitdefender disconnected. The key was deleted from Atlas; assets stay.');
                  })
                }
              >
                <Unplug /> Disconnect
              </Button>
            </div>
            {job.data && <JobSummary job={job.data} />}
            <Checkbox
              label="Add endpoints that aren't in Atlas as assets"
              description="Endpoints are matched to a client's assets by name or MAC address. With this on, the rest are added in the device layout ConnectWise RMM uses (or Configurations)."
              checked={data.options.createAssets}
              disabled={busy === 'options'}
              onChange={(e) =>
                act('options', async () => {
                  await api('/integrations/bitdefender/options', {
                    method: 'PUT',
                    body: { ...data.options, createAssets: e.target.checked },
                  });
                  await connection.refetch();
                })
              }
            />
            <CompanyMapping
              path="/integrations/bitdefender/companies"
              queryKey="bitdefender-companies"
              product="GravityZone"
            />
          </>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}
