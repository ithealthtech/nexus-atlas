import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Cloud, Loader2, Network, Server, TriangleAlert, Waypoints, type LucideIcon } from 'lucide-react';
import {
  ACCESS_MODE_LABELS,
  ACCESS_MODES,
  type AccessMode,
  type AccessRun,
  type RemoteAccessRequest,
  type RemoteAccessView,
} from '@atlas/shared';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  Field,
  FormError,
  Input,
  PageHeader,
  Skeleton,
  Textarea,
} from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';
import { cn } from '@/lib/cn';

const ABOUT: Record<AccessMode, { icon: LucideIcon; text: string }> = {
  direct: {
    icon: Server,
    text: 'This server serves Atlas itself. A DNS name gets a public certificate; an IP address gets the server’s own.',
  },
  cloudflare: {
    icon: Cloud,
    text: 'A tunnel to Cloudflare carries visitors to Atlas. No ports are opened, and Cloudflare’s certificate is trusted everywhere.',
  },
  tailscale: {
    icon: Waypoints,
    text: 'Atlas is served at this server’s .ts.net name, with Tailscale’s certificate. Only your tailnet, or anyone with Funnel.',
  },
  proxy: {
    icon: Network,
    text: 'Your own nginx, Traefik, IIS or Nginx Proxy Manager handles HTTPS and sends requests to this server.',
  },
};
const RUN_TEXT: Record<AccessRun['state'], string> = {
  idle: '',
  requested: 'Waiting for the server to start on it…',
  running: 'Working. Atlas restarts on its new address.',
  succeeded: 'Done.',
  failed: 'That didn’t work, so nothing was changed.',
};
const code = 'rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs';

export function RemoteAccess() {
  const client = useQueryClient();
  const actor = useActor();
  const view = useQuery({
    queryKey: ['remote-access'],
    queryFn: () => api<RemoteAccessView>('/system/access'),
    // Follow a change while it runs. Atlas restarts during it, so failed requests just retry.
    refetchInterval: (q) => (busy(q.state.data?.run) ? 2000 : false),
    refetchIntervalInBackground: true,
    retry: true,
  });
  const v = view.data;
  const [mode, setMode] = useState<AccessMode | null>(null);
  const [draft, setDraft] = useState<RemoteAccessRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const chosen = mode ?? v?.mode ?? 'direct';
  const isOwner = actor.role === 'owner';

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    setError(null);
    setDraft({
      mode: chosen,
      ...(chosen !== 'tailscale' && { publicUrl: text('publicUrl') }),
      ...(chosen === 'proxy' && {
        trusted: text('trusted')
          .split(/[\s,]+/)
          .filter(Boolean),
      }),
      ...(chosen === 'tailscale' && { funnel: form.get('funnel') === 'on' }),
      ...(chosen === 'cloudflare' && text('token') && { cloudflareToken: text('token') }),
      ...(chosen === 'tailscale' && text('authKey') && { tailscaleAuthKey: text('authKey') }),
    });
  };
  const send = async () => {
    if (!draft) return;
    setSending(true);
    try {
      const run = await api<AccessRun>('/system/access', { method: 'POST', body: draft });
      client.setQueryData<RemoteAccessView>(['remote-access'], (old) => (old ? { ...old, run } : old));
      setDraft(null);
    } catch (err) {
      setError((err as ApiError).message);
      setDraft(null);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Remote access"
        description="How people reach Atlas: from this server directly, through a Cloudflare Tunnel or Tailscale, or behind your own reverse proxy."
      />
      {!v ? (
        <Skeleton className="h-96" />
      ) : !v.canAct ? (
        <NotHere publicUrl={v.publicUrl} />
      ) : (
        <div className="grid max-w-3xl gap-6">
          <Card>
            <CardHeader title="Right now" description={view.failureCount > 0 ? 'Reconnecting to Atlas…' : undefined} />
            <dl className="grid gap-x-6 gap-y-3 px-5 pt-2 pb-5 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[13px] text-muted">Reached through</dt>
                <dd className="mt-0.5 font-medium">{v.mode ? ACCESS_MODE_LABELS[v.mode] : 'Unknown'}</dd>
              </div>
              <div>
                <dt className="text-[13px] text-muted">Address</dt>
                <dd className="mt-0.5 font-mono text-[13px] break-all">{v.publicUrl}</dd>
              </div>
              {v.mode === 'proxy' && (
                <div className="sm:col-span-2">
                  <dt className="text-[13px] text-muted">Trusted proxy addresses</dt>
                  <dd className="mt-0.5 font-mono text-[13px]">{v.trusted.join(', ')}</dd>
                </div>
              )}
              {v.mode === 'tailscale' && (
                <div>
                  <dt className="text-[13px] text-muted">Who can reach it</dt>
                  <dd className="mt-0.5 font-medium">{v.funnel ? 'Anyone (Funnel)' : 'Your tailnet'}</dd>
                </div>
              )}
            </dl>
            {v.run.state !== 'idle' && <RunBanner run={v.run} />}
          </Card>

          <Card>
            <CardHeader
              title="Change how Atlas is reached"
              description={
                isOwner
                  ? 'Atlas has one address. Changing it moves everyone to the new one.'
                  : 'Only the owner can change this.'
              }
            />
            <form onSubmit={submit} className="grid gap-5 px-5 pt-2 pb-5">
              <fieldset disabled={!isOwner || busy(v.run)} className="grid gap-5">
                <legend className="sr-only">How Atlas is reached</legend>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How Atlas is reached">
                  {ACCESS_MODES.map((m) => {
                    const Icon = ABOUT[m].icon;
                    return (
                      <label
                        key={m}
                        className={cn(
                          'flex cursor-pointer gap-3 rounded-md border p-3.5 text-sm',
                          chosen === m ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2',
                        )}
                      >
                        <input
                          type="radio"
                          name="mode"
                          className="sr-only"
                          checked={chosen === m}
                          onChange={() => setMode(m)}
                        />
                        <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
                        <span>
                          <span className="block font-semibold">{ACCESS_MODE_LABELS[m]}</span>
                          <span className="mt-0.5 block text-[13px] text-text-2">{ABOUT[m].text}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>

                <Steps mode={chosen} />

                {chosen !== 'tailscale' && (
                  <Field
                    label="Address people will use"
                    help={
                      chosen === 'direct'
                        ? 'An IP address works, but browsers warn until the server’s certificate is installed.'
                        : 'The name your ' +
                          (chosen === 'cloudflare' ? 'tunnel’s public hostname' : 'reverse proxy') +
                          ' serves.'
                    }
                  >
                    {(p) => (
                      <Input
                        {...p}
                        name="publicUrl"
                        type="url"
                        required
                        placeholder="https://atlas.example.com"
                        defaultValue={v.mode === chosen ? v.publicUrl : ''}
                        key={chosen}
                      />
                    )}
                  </Field>
                )}
                {chosen === 'cloudflare' && (
                  <Field
                    label="Tunnel token"
                    help={
                      v.hasTunnelToken
                        ? 'A token is saved on the server. Leave this empty to keep it.'
                        : 'Kept on the server where only root can read it. It is never shown again or logged.'
                    }
                  >
                    {(p) => (
                      <Input
                        {...p}
                        name="token"
                        type="password"
                        autoComplete="off"
                        required={!v.hasTunnelToken}
                        spellCheck={false}
                      />
                    )}
                  </Field>
                )}
                {chosen === 'tailscale' && (
                  <>
                    <Checkbox
                      name="funnel"
                      defaultChecked={v.funnel}
                      label="Serve Atlas on the internet with Funnel"
                      description="Off: only devices on your tailnet can reach Atlas. On: anyone with the address can reach the sign-in page."
                    />
                    <Field
                      label="Tailscale auth key"
                      help="Only needed the first time, while this server isn't signed in to Tailscale. Used once, never logged."
                    >
                      {(p) => (
                        <Input
                          {...p}
                          name="authKey"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="tskey-auth-…"
                        />
                      )}
                    </Field>
                  </>
                )}
                {chosen === 'proxy' && (
                  <Field
                    label="Your reverse proxy’s addresses"
                    help="IP addresses or ranges, one per line or comma-separated. Only these may send requests to Atlas, and only they are believed about a visitor's address."
                  >
                    {(p) => (
                      <Textarea
                        {...p}
                        name="trusted"
                        rows={3}
                        required
                        placeholder={'10.0.0.5\n10.0.1.0/24'}
                        defaultValue={v.trusted.join('\n')}
                      />
                    )}
                  </Field>
                )}
              </fieldset>
              <FormError message={error} />
              {isOwner && (
                <div className="flex justify-end">
                  <Button type="submit" disabled={busy(v.run)}>
                    Review the change
                  </Button>
                </div>
              )}
            </form>
          </Card>
        </div>
      )}

      <Dialog
        open={!!draft}
        onClose={() => setDraft(null)}
        title="Change how Atlas is reached?"
        description={draft ? ACCESS_MODE_LABELS[draft.mode] : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={() => void send()} loading={sending}>
              Change it
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm text-text-2">
          <p>
            Atlas restarts and moves to{' '}
            <strong className="font-mono text-[13px] break-all text-text">
              {draft?.mode === 'tailscale' ? 'this server’s .ts.net name' : draft?.publicUrl}
            </strong>
            . If it doesn’t answer there, the server puts the current settings back.
          </p>
          <ul className="list-disc space-y-1.5 pl-5">
            <li>Everyone signs in again at the new address. This page stops updating; open Atlas there.</li>
            <li>Passkeys work only at the address they were added on. People add them again.</li>
            <li>
              Microsoft and SAML sign-in, the browser extension and Atlas for Windows need the new address. Update the
              redirect addresses at your identity provider.
            </li>
          </ul>
        </div>
      </Dialog>
    </>
  );
}

/** What to do outside Atlas before applying each way. */
function Steps({ mode }: { mode: AccessMode }) {
  const steps: Record<AccessMode, React.ReactNode[]> = {
    direct: [
      <>For a public certificate, point a DNS name at this server and open ports 80 and 443.</>,
      <>
        Otherwise use the server’s IP address, and install its certificate authority from <strong>Certificate</strong>.
      </>,
    ],
    cloudflare: [
      <>
        In the Cloudflare dashboard, open <strong>Zero Trust → Networks → Tunnels</strong> and create a tunnel with{' '}
        <strong>Cloudflared</strong>. Copy its token.
      </>,
      <>
        Add a <strong>Public hostname</strong> for the tunnel, such as atlas.example.com, with the service{' '}
        <code className={code}>http://localhost:4318</code>.
      </>,
      <>Paste the token below. This server installs cloudflared and runs the tunnel; no ports need to be opened.</>,
    ],
    tailscale: [
      <>
        In the Tailscale admin console, turn on <strong>MagicDNS</strong> and <strong>HTTPS certificates</strong> under{' '}
        <strong>DNS</strong>.
      </>,
      <>
        For Funnel, allow it in the tailnet policy file (the <code className={code}>funnel</code> attribute).
      </>,
      <>
        If this server isn’t on your tailnet yet, make an auth key under <strong>Settings → Keys</strong> and paste it
        below. This server installs Tailscale and joins as <code className={code}>atlas</code>.
      </>,
    ],
    proxy: [
      <>
        Point your reverse proxy at <code className={code}>http://&lt;this server&gt;:80</code>. Atlas listens there
        only for the addresses you list below.
      </>,
      <>
        Keep the original <code className={code}>Host</code> header, and send{' '}
        <code className={code}>X-Forwarded-For</code>. Most proxies do both by default.
      </>,
      <>Serve HTTPS from the proxy, with a certificate for the address below.</>,
    ],
  };
  return (
    <ol className="list-decimal space-y-1.5 rounded-md bg-surface-2 py-3.5 pr-4 pl-9 text-[13px] text-text-2">
      {steps[mode].map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

function NotHere({ publicUrl }: { publicUrl: string }) {
  return (
    <Card className="max-w-3xl">
      <CardHeader
        title="Set this in Atlas’s settings on this server"
        description="This page works on servers set up with the Linux installer. Here, Atlas’s address and the proxies it trusts are settings."
      />
      <div className="space-y-3 px-5 pt-2 pb-5 text-sm text-text-2">
        <p>
          Atlas is reached at <span className="font-mono text-[13px]">{publicUrl}</span>.
        </p>
        <p>
          Set <code className={code}>PUBLIC_URL</code> to the address your tunnel or proxy serves, and{' '}
          <code className={code}>TRUST_PROXY</code> to the addresses of whatever connects to Atlas, for example{' '}
          <code className={code}>127.0.0.1,::1</code> for cloudflared or Tailscale on the same machine. Then restart
          Atlas.
        </p>
      </div>
    </Card>
  );
}

function busy(run: AccessRun | undefined) {
  return run?.state === 'requested' || run?.state === 'running';
}

function RunBanner({ run }: { run: AccessRun }) {
  const working = busy(run);
  const Icon = working ? Loader2 : run.state === 'failed' ? TriangleAlert : CheckCircle2;
  return (
    <div className="flex items-start gap-3 border-t border-border px-5 py-3.5 text-sm" role="status">
      <Icon className={working ? 'mt-0.5 size-4 animate-spin' : 'mt-0.5 size-4'} aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold">{RUN_TEXT[run.state]}</p>
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
