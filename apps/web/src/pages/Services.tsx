import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpCircle,
  CheckCircle2,
  Database,
  Globe,
  Loader2,
  RotateCw,
  Server,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import {
  SERVICE_ACTION_LABELS,
  type ServiceAction,
  type ServiceRun,
  type SystemServiceId,
  type SystemServiceState,
  type SystemServicesView,
} from '@atlas/shared';
import { Badge, Button, Card, CardHeader, Dialog, PageHeader, Skeleton, useToast, type Tone } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';

const ABOUT: Record<SystemServiceId, { icon: LucideIcon; text: string }> = {
  atlas: { icon: Server, text: 'The Atlas application itself.' },
  proxy: { icon: Globe, text: 'Serves Atlas over HTTPS and holds its certificate.' },
  database: { icon: Database, text: 'PostgreSQL, where everything is stored.' },
  updater: { icon: ArrowUpCircle, text: 'Carries out updates and the actions on this page.' },
};
const STATE: Record<SystemServiceState, { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'success' },
  starting: { label: 'Starting', tone: 'info' },
  stopped: { label: 'Stopped', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  missing: { label: 'Not installed', tone: 'neutral' },
  unknown: { label: 'Unknown', tone: 'neutral' },
};
// What each action interrupts, said before it's asked for.
const CONFIRM: Record<ServiceAction, string> = {
  'restart-atlas':
    'Atlas is unavailable for a few seconds while it restarts. Nobody is signed out, but anything unsaved in an open form may be lost, and an import or sync that is running stops.',
  'restart-proxy': 'Everyone’s connection to Atlas drops for a moment. This page reconnects by itself.',
  'restart-database':
    'The database restarts, and Atlas restarts with it. Atlas is unavailable for up to a minute, and an import or sync that is running stops.',
  repair:
    'Puts the owners and permissions of Atlas’s files back as the installer sets them, turns its services back on, and restarts all of them. Atlas is unavailable for up to a minute.',
};
const RUN_TEXT: Record<ServiceRun['state'], string> = {
  idle: '',
  requested: 'Waiting for the server to start on it…',
  running: 'Working. Atlas may be unreachable for a moment, and this page reconnects.',
  succeeded: 'Done.',
  failed: 'That didn’t work.',
};

export function Services() {
  const client = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState<ServiceAction | null>(null);
  const [sending, setSending] = useState(false);
  const services = useQuery({
    queryKey: ['system-services'],
    queryFn: () => api<SystemServicesView>('/system/services'),
    // Follow an action while it runs. Atlas itself may be what's restarting, so failed requests just retry.
    refetchInterval: (q) => (settling(q.state.data?.run) ? 2000 : 15_000),
    // Keep following it if the administrator looks at another tab meanwhile.
    refetchIntervalInBackground: true,
    retry: true,
  });
  const s = services.data;
  // Nothing new can be asked for while an action runs, or in the few seconds after one (the server refuses).
  const busy = settling(s?.run);
  const updater = s?.services.find((service) => service.id === 'updater');
  const updaterDown = updater ? updater.state === 'stopped' || updater.state === 'failed' : false;
  const send = async () => {
    if (!asking) return;
    setSending(true);
    try {
      const run = await api<ServiceRun>('/system/services/run', { method: 'POST', body: { action: asking } });
      client.setQueryData<SystemServicesView>(['system-services'], (old) => (old ? { ...old, run } : old));
      setAsking(null);
    } catch (error) {
      toast((error as ApiError).message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Services"
        description="The services Atlas runs on, with a way to restart or repair them without signing in to the server."
      />
      {!s ? (
        <div className="space-y-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-28" />
        </div>
      ) : !s.canAct ? (
        <Card>
          <CardHeader
            title="Not available on this server"
            description="This page works on servers set up with the Linux installer, which adds a small helper that restarts services for Atlas."
          />
          <div className="space-y-2 px-5 py-4 text-sm text-text-2">
            <p>
              With Docker, restart the containers from the folder that holds your compose file:{' '}
              <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs">docker compose restart</code>
            </p>
            <p>
              On Windows Server, restart the <strong>MSPAtlas</strong> service in the Services app.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Services"
              description={
                services.failureCount > 0
                  ? 'Reconnecting to Atlas…'
                  : s.databaseReachable
                    ? 'Atlas can reach its database.'
                    : 'Atlas can’t reach its database right now.'
              }
            />
            {s.run.state !== 'idle' && <RunBanner run={s.run} />}
            {updaterDown && (
              <div
                className="flex items-start gap-3 border-t border-border bg-warning-soft px-5 py-3.5 text-sm text-warning"
                role="alert"
              >
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  The updater has stopped, so the actions on this page and updates won’t run. Start it on the server:{' '}
                  <code className="font-mono text-xs">sudo systemctl restart msp-atlas-updater.path</code>
                </p>
              </div>
            )}
            <ul className="divide-y divide-border border-t border-border">
              {s.services.map((service) => {
                const { icon: Icon, text } = ABOUT[service.id];
                const state = STATE[service.state];
                return (
                  <li key={service.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-text-2">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {service.name} <Badge tone={state.tone}>{state.label}</Badge>
                      </p>
                      <p className="text-xs text-muted">
                        {text}
                        {service.since && ` Running since ${formatDateTime(service.since)}.`}{' '}
                        <span className="font-mono">{service.unit}</span>
                      </p>
                    </div>
                    {service.restart && service.state !== 'missing' && (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => setAsking(service.restart)}
                        aria-label={SERVICE_ACTION_LABELS[service.restart]}
                      >
                        <RotateCw /> Restart
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Repair the installation"
              description="For when something is stopped, won’t start, or says it can’t read or write its files."
              actions={
                <Button disabled={busy} onClick={() => setAsking('repair')}>
                  <Wrench /> Repair
                </Button>
              }
            />
            <ul className="list-disc space-y-1 px-5 py-4 pl-10 text-sm text-text-2">
              <li>Puts the owners and permissions of Atlas’s settings, master key, program, and data folders back.</li>
              <li>Hands files that were created as root in the data folder back to Atlas.</li>
              <li>Turns Atlas, the web proxy, the database, and the updater back on at startup.</li>
              <li>Restarts all of them, then checks that Atlas answers.</li>
            </ul>
            <p className="border-t border-border px-5 py-3.5 text-sm text-text-2">
              It doesn’t change your settings, your data, or the version of Atlas. If it doesn’t help, run the installer
              again on the server: that rebuilds everything and keeps your data.
            </p>
          </Card>

          <Card>
            <CardHeader
              title="If you can’t reach this page"
              description="The same things from the server’s own console, for when Atlas itself is down."
            />
            <pre className="overflow-x-auto px-5 py-4 font-mono text-xs leading-6 text-text-2">
              {[
                'sudo systemctl status msp-atlas caddy postgresql',
                'sudo systemctl restart msp-atlas',
                'sudo journalctl -u msp-atlas -n 50',
              ].join('\n')}
            </pre>
          </Card>
        </div>
      )}
      {asking && (
        <Dialog
          open
          onClose={() => setAsking(null)}
          title={`${SERVICE_ACTION_LABELS[asking]}?`}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAsking(null)}>
                Cancel
              </Button>
              <Button loading={sending} onClick={() => void send()}>
                {SERVICE_ACTION_LABELS[asking]}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-2">{CONFIRM[asking]}</p>
          <p className="mt-3 text-sm text-text-2">Atlas asks for your password first, and records who asked.</p>
        </Dialog>
      )}
    </>
  );
}

/** An action is in progress, or one was asked for in the last few seconds. */
function settling(run: ServiceRun | undefined) {
  if (!run) return false;
  if (run.state === 'requested' || run.state === 'running') return true;
  const asked = run.requestedAt ? Date.parse(run.requestedAt) : NaN;
  return !Number.isNaN(asked) && Date.now() - asked < 6000;
}

function RunBanner({ run }: { run: ServiceRun }) {
  const busy = run.state === 'requested' || run.state === 'running';
  const Icon = busy ? Loader2 : run.state === 'failed' ? TriangleAlert : CheckCircle2;
  return (
    <div className="flex items-start gap-3 border-t border-border px-5 py-3.5 text-sm" role="status">
      <Icon className={busy ? 'mt-0.5 size-4 animate-spin' : 'mt-0.5 size-4'} aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">
          {run.action ? SERVICE_ACTION_LABELS[run.action] : 'Last action'} · {RUN_TEXT[run.state]}
        </p>
        <p className="mt-0.5 text-text-2">
          {run.requestedBy && `Requested by ${run.requestedBy}`}
          {run.requestedAt && ` ${relativeTime(run.requestedAt)}`}
          {run.finishedAt && ` · finished ${formatDateTime(run.finishedAt)}`}
        </p>
        {run.message && <p className="mt-1 break-words whitespace-pre-wrap text-text-2">{run.message}</p>}
      </div>
    </div>
  );
}
