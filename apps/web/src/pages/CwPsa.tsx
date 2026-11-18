import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Unplug } from 'lucide-react';
import type { CwPsaOptions, CwPsaView, ImportJobView } from '@atlas/shared';
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
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { CompanyMapping } from '@/components/CompanyMapping';
import { JobSummary } from './DataTools';
import { useAction } from '@/lib/actions';

/** ConnectWise PSA (Manage): connect with an API member's keys, link companies, and let clients open PSA tickets. */
export function CwPsaSync() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: ['cw-psa'],
    queryFn: () => api<CwPsaView | null>('/integrations/cw-psa'),
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
      void refetchConnection();
    }
  }, [job.data, queryClient, refetchConnection]);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const privateKey = String(form.get('privateKey') ?? '');
    return act('save', async () => {
      const saved = await api<CwPsaView & { companies: number }>('/integrations/cw-psa', {
        method: 'PUT',
        body: {
          site: form.get('site'),
          companyId: form.get('companyId'),
          publicKey: form.get('publicKey'),
          clientId: form.get('clientId'),
          autoSync: form.get('autoSync') === 'on',
          ...(privateKey ? { privateKey } : {}),
        },
      });
      await connection.refetch();
      await queryClient.invalidateQueries({ queryKey: ['cw-psa-companies'] });
      toast(`Connected. ${saved.companies} companies found; link them to clients below.`);
    });
  };
  const setOptions = (options: CwPsaOptions) =>
    act('options', async () => {
      await api('/integrations/cw-psa/options', { method: 'PUT', body: options });
      await connection.refetch();
    });
  const data = connection.data;
  return (
    <Card>
      <CardHeader
        title="ConnectWise PSA"
        description="Connect ConnectWise PSA (Manage) so clients can open real PSA service tickets from Atlas, and see each linked company's PSA tickets on the ticket dashboard. Tickets sync hourly."
      />
      <div className="space-y-5 p-5">
        {connection.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <form onSubmit={save} className="space-y-4" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Site" help="Your PSA API address, such as api-na.myconnectwise.net.">
                {(p) => <Input {...p} name="site" defaultValue={data?.site} autoComplete="off" required />}
              </Field>
              <Field label="Company ID" help="The company ID you sign in to PSA with.">
                {(p) => <Input {...p} name="companyId" defaultValue={data?.companyId} autoComplete="off" required />}
              </Field>
              <Field label="Public key" help="PSA → System → Members → API Members → the member's API Keys tab.">
                {(p) => <Input {...p} name="publicKey" defaultValue={data?.publicKey} autoComplete="off" required />}
              </Field>
              <Field
                label="Private key"
                help={data ? 'Saved and encrypted. Leave empty to keep it.' : 'Shown once, when the key is created.'}
              >
                {(p) => (
                  <Input
                    {...p}
                    name="privateKey"
                    type="password"
                    autoComplete="off"
                    placeholder={data ? '••••••••' : ''}
                  />
                )}
              </Field>
              <Field label="Client ID" help="From the ConnectWise developer portal (developer.connectwise.com).">
                {(p) => <Input {...p} name="clientId" defaultValue={data?.clientId} autoComplete="off" required />}
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
                    const { id } = await api<{ id: string }>('/integrations/cw-psa/sync', { method: 'POST', body: {} });
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
                    await api('/integrations/cw-psa', { method: 'DELETE' });
                    await connection.refetch();
                    toast('ConnectWise PSA disconnected. The private key was deleted from Atlas.');
                  })
                }
              >
                <Unplug /> Disconnect
              </Button>
            </div>
            {job.data && <JobSummary job={job.data} />}
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Client portal tickets</legend>
              <p className="text-xs text-muted">
                This creates tickets in your PSA, so it is off until you turn it on and name a board.
              </p>
              <Checkbox
                label="Client portal tickets"
                description="Lets client accounts open PSA service tickets for their linked client, and read and answer the Discussion notes. Internal notes stay hidden."
                checked={data.options.portalTickets}
                disabled={busy === 'options' || (!data.options.portalTicketBoard && !data.options.portalTickets)}
                onChange={(e) => void setOptions({ ...data.options, portalTickets: e.target.checked })}
              />
              <Field
                label="Portal ticket board"
                help="The service board's name in PSA, such as Help Desk. Name it before turning portal tickets on."
              >
                {(p) => (
                  <Input
                    {...p}
                    className="sm:max-w-sm"
                    key={`portal-board-${data.options.portalTicketBoard}`}
                    defaultValue={data.options.portalTicketBoard}
                    maxLength={100}
                    disabled={busy === 'options'}
                    onBlur={(e) => {
                      const board = e.target.value.trim();
                      if (board === data.options.portalTicketBoard) return;
                      void setOptions({
                        portalTicketBoard: board,
                        portalTickets: board ? data.options.portalTickets : false,
                      });
                    }}
                  />
                )}
              </Field>
            </fieldset>
            <CompanyMapping
              path="/integrations/cw-psa/companies"
              queryKey="cw-psa-companies"
              product="ConnectWise PSA"
            />
          </>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}
