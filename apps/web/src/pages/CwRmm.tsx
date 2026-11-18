import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Unplug } from 'lucide-react';
import {
  CW_RMM_REGIONS,
  CW_RMM_REGION_LABELS,
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
import { useLayouts } from '@/lib/queries';
import { CompanyMapping } from '@/components/CompanyMapping';
import { JobSummary } from './DataTools';
import { useAction } from '@/lib/actions';

/** ConnectWise RMM (Asio): connect, link companies to clients, sync devices and tickets. */
export function CwRmmSync() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const connection = useQuery({
    queryKey: ['cw-rmm'],
    queryFn: () => api<CwRmmView | null>('/integrations/cw-rmm'),
  });
  const refetchConnection = connection.refetch;
  const layouts = useLayouts();
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
        description="Sync devices from the ConnectWise platform (Asio) into each client's device assets, sites into Locations, and tickets into the ticket dashboard (read-only). Runs hourly; devices removed from the RMM are archived."
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
                    : 'Needs companies, sites and devices read scopes, and tickets read for tickets.'
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
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">What to sync</legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    ['locations', 'Sites', 'Each linked company’s sites, as locations.'],
                    ['contacts', 'Contacts', 'Each company’s contacts, matched to ones already there by email.'],
                    ['devices', 'Devices', 'As assets: updating same-named ones, or in the layout chosen below.'],
                    ['tickets', 'Tickets', 'Read-only, for the ticket dashboard. Needs the tickets read permission.'],
                    [
                      'inventory',
                      'Software and sign-ins',
                      'Each device’s installed software and who signs in, and which host each virtual machine runs on.',
                    ],
                    [
                      'bitlocker',
                      'BitLocker keys',
                      'Saves recovery keys kept in a device custom field to the client’s vault, linked to the device. Off until you turn it on.',
                    ],
                  ] as const
                ).map(([key, label, help]) => (
                  <Checkbox
                    key={key}
                    label={label}
                    description={help}
                    checked={data.options[key]}
                    disabled={busy === 'options'}
                    onChange={(e) =>
                      act('options', async () => {
                        await api('/integrations/cw-rmm/options', {
                          method: 'PUT',
                          body: { ...data.options, [key]: e.target.checked },
                        });
                        await connection.refetch();
                      })
                    }
                  />
                ))}
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">Write back to ConnectWise</legend>
                <p className="text-xs text-muted">
                  These change data in your ConnectWise tenant, so they are off until you turn them on.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      [
                        'atlasLinks',
                        'Atlas links',
                        'Writes each device’s Atlas address into its “Atlas link” custom field on every sync. Add that device custom field in ConnectWise first. Needs the devices write permission.',
                      ],
                      [
                        'ticketNotes',
                        'Ticket notes',
                        'Lets techs add internal notes to tickets from Atlas, and notes a password reveal on the ticket whose number is in the reason (never the password). Needs the tickets create permission.',
                      ],
                      [
                        'expiryTickets',
                        'Expiry tickets',
                        'Opens one ticket for each domain, certificate, license, or warranty of a linked client coming due, on every sync. Needs the tickets create permission.',
                      ],
                    ] as const
                  ).map(([key, label, help]) => (
                    <Checkbox
                      key={key}
                      label={label}
                      description={help}
                      checked={data.options[key]}
                      disabled={busy === 'options'}
                      onChange={(e) =>
                        act('options', async () => {
                          await api('/integrations/cw-rmm/options', {
                            method: 'PUT',
                            body: { ...data.options, [key]: e.target.checked },
                          });
                          await connection.refetch();
                        })
                      }
                    />
                  ))}
                </div>
                {data.options.expiryTickets && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="Days before it expires" help="Tickets open this many days ahead (1 to 180).">
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min={1}
                          max={180}
                          key={`days-${data.options.expiryTicketDays}`}
                          defaultValue={data.options.expiryTicketDays}
                          disabled={busy === 'options'}
                          onBlur={(e) => {
                            const days = Math.round(Number(e.target.value));
                            if (days === data.options.expiryTicketDays || !(days >= 1 && days <= 180)) return;
                            void act('options', async () => {
                              await api('/integrations/cw-rmm/options', {
                                method: 'PUT',
                                body: { ...data.options, expiryTicketDays: days },
                              });
                              await connection.refetch();
                            });
                          }}
                        />
                      )}
                    </Field>
                    <Field label="Service board" help="The board's name in ConnectWise. Empty uses the first board.">
                      {(p) => (
                        <Input
                          {...p}
                          key={`board-${data.options.expiryTicketBoard}`}
                          defaultValue={data.options.expiryTicketBoard}
                          maxLength={100}
                          disabled={busy === 'options'}
                          onBlur={(e) => {
                            const board = e.target.value.trim();
                            if (board === data.options.expiryTicketBoard) return;
                            void act('options', async () => {
                              await api('/integrations/cw-rmm/options', {
                                method: 'PUT',
                                body: { ...data.options, expiryTicketBoard: board },
                              });
                              await connection.refetch();
                            });
                          }}
                        />
                      )}
                    </Field>
                  </div>
                )}
              </fieldset>
              <Field
                label="Save devices in"
                help="Automatic uses the Endpoints layout (one named Endpoints, Devices or Computer Assets is renamed to Endpoints) when there is one, otherwise Configurations. Devices an earlier sync put in Configurations move on the next sync."
              >
                {(p) => (
                  <Select
                    {...p}
                    value={data.options.layoutId ?? ''}
                    disabled={busy === 'options' || !data.options.devices}
                    onChange={(e) =>
                      act('options', async () => {
                        await api('/integrations/cw-rmm/options', {
                          method: 'PUT',
                          body: { ...data.options, layoutId: e.target.value || null },
                        });
                        await connection.refetch();
                      })
                    }
                  >
                    <option value="">Automatic</option>
                    {(layouts.data ?? [])
                      .filter((l) => !l.archived || l.id === data.options.layoutId)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                  </Select>
                )}
              </Field>
            </fieldset>
            <CompanyMapping
              path="/integrations/cw-rmm/companies"
              queryKey="cw-rmm-companies"
              product="ConnectWise RMM"
            />
          </>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}
