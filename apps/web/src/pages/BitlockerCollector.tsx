import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, HardDrive, Plus } from 'lucide-react';
import type {
  BitlockerDeviceView,
  BitlockerEnrollmentCreated,
  BitlockerEnrollmentView,
  BitlockerVolumeView,
} from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
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
import { ApiError, api } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useClients } from '@/lib/queries';

type Overview = { enrollments: BitlockerEnrollmentView[]; devices: BitlockerDeviceView[] };

const STATUS: Record<BitlockerDeviceView['status'], { tone: Tone; label: string }> = {
  protected: { tone: 'success', label: 'Protected' },
  unprotected: { tone: 'danger', label: 'Not protected' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

/** One volume in a few words: "C: on, XTS-AES-256, 1 key". */
export function volumeSummary(v: BitlockerVolumeView) {
  const parts = [
    v.protection === 'On' ? 'on' : v.protection === 'Off' ? 'off' : 'unknown',
    ...(v.protection === 'On' && v.encryptionMethod !== 'Unknown' ? [v.encryptionMethod] : []),
    ...(v.encryptionPercentage > 0 && v.encryptionPercentage < 100 ? [`${v.encryptionPercentage}% encrypted`] : []),
    ...(v.protection === 'On' ? [v.keys === 1 ? '1 key saved' : `${v.keys} keys saved`] : []),
  ];
  return `${v.mountPoint || 'Volume'} ${parts.join(', ')}`;
}

export function BitlockerStatusBadge({ status }: { status: BitlockerDeviceView['status'] }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

function saveScript(made: BitlockerEnrollmentCreated) {
  const url = URL.createObjectURL(new Blob([made.script], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = made.filename;
  a.click();
  URL.revokeObjectURL(url);
}

function EnrollDialog({
  onClose,
  onMade,
}: {
  onClose: () => void;
  onMade: (made: BitlockerEnrollmentCreated) => void;
}) {
  const clients = useClients();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const made = await api<BitlockerEnrollmentCreated>('/bitlocker/enrollments', {
        method: 'POST',
        body: { clientId: form.get('clientId'), name: form.get('name'), scope: form.get('scope') },
      });
      // Straight to a file: the script holds a token that can't be shown again.
      saveScript(made);
      onMade(made);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="New enrollment"
      description="Makes a script for your RMM to run on this client's Windows machines."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="enroll-form" loading={busy}>
            <Download /> Create and download script
          </Button>
        </>
      }
    >
      <form id="enroll-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Client" error={error?.fields?.clientId}>
          {(p) => (
            <Select {...p} name="clientId" required defaultValue="">
              <option value="" disabled>
                Choose a client…
              </option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Enrollment name"
          help="For your own reference, for example “All workstations”."
          error={error?.fields?.name}
        >
          {(p) => <Input {...p} name="name" defaultValue="All Windows devices" required maxLength={120} />}
        </Field>
        <Field
          label="Used by"
          help="A one-device enrollment is tied to the first machine that reports with it; any other machine is refused."
        >
          {(p) => (
            <Select {...p} name="scope" defaultValue="client">
              <option value="client">All of this client’s devices (one script for the RMM)</option>
              <option value="device">One device only</option>
            </Select>
          )}
        </Field>
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

/** Enrollments of the BitLocker collector script, and what each enrolled machine last reported. */
export function BitlockerCollector() {
  const toast = useToast();
  const overview = useQuery({
    queryKey: ['bitlocker-collector'],
    queryFn: () => api<Overview>('/bitlocker/collector'),
  });
  const [enrolling, setEnrolling] = useState(false);
  const [made, setMade] = useState<BitlockerEnrollmentCreated | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await work();
      await overview.refetch();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const data = overview.data;
  const unprotected = data?.devices.filter((d) => d.status === 'unprotected').length ?? 0;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="BitLocker collector"
        description="A script your RMM runs on each Windows machine. It reads BitLocker status and recovery keys, encrypts the keys on the machine, and sends them here. Keys go to the client's vault; status shows on the device's asset."
        actions={
          <Button onClick={() => setEnrolling(true)}>
            <Plus /> New enrollment
          </Button>
        }
      />
      <div className="grid max-w-5xl gap-6">
        {made && (
          <Card>
            <CardHeader
              title={`Script downloaded: ${made.filename}`}
              description="Keep this file as you would a password. It holds an upload token for this enrollment, and Atlas can't show it again; if it's lost, make a new enrollment and revoke this one."
              actions={
                <Button variant="secondary" onClick={() => saveScript(made)}>
                  <Download /> Download again
                </Button>
              }
            />
            <ol className="list-decimal space-y-1.5 px-5 py-4 pl-10 text-sm text-text-2">
              <li>
                In your RMM, add it as a PowerShell script for <strong>{made.enrollment.clientName}</strong>, set to run
                as <strong>SYSTEM</strong>.
              </li>
              <li>Schedule it every 6 hours, and run it after a recovery key is rotated.</li>
              <li>
                Try it on one machine first. It prints one line with counts, never keys, and exits 0 when the report was
                uploaded.
              </li>
              <li>The machine then appears below, usually within a minute.</li>
            </ol>
            <p className="border-t border-border px-5 py-3 text-xs text-muted">
              The script only reads. It can&rsquo;t turn BitLocker on or off or change a key, it works on Windows
              PowerShell 5.1 and later, and it holds no key that can decrypt what it sends.
            </p>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Enrollments"
            description="Revoking one stops its script from uploading. Keys already saved stay in the vault."
          />
          {!data ? (
            <Skeleton className="m-5 h-16" />
          ) : !data.enrollments.length ? (
            <EmptyState
              icon={HardDrive}
              title="No enrollments yet"
              description="Make one for a client to get the script for your RMM."
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.enrollments.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {e.clientName} · {e.name}
                    </p>
                    <p className="text-xs text-muted">
                      {e.scope === 'device' ? 'One device' : 'All devices'} · {e.devices}{' '}
                      {e.devices === 1 ? 'machine' : 'machines'} reporting ·{' '}
                      {e.lastSeenAt ? `last report ${relativeTime(e.lastSeenAt)}` : 'no reports yet'}
                    </p>
                  </div>
                  {e.revoked ? (
                    <Badge tone="neutral">Revoked</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `revoke-${e.id}`}
                      onClick={() => {
                        if (!window.confirm(`Revoke “${e.name}” for ${e.clientName}? Its script will stop uploading.`))
                          return;
                        void act(`revoke-${e.id}`, () => api(`/bitlocker/enrollments/${e.id}`, { method: 'DELETE' }));
                      }}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Devices"
            description={
              data?.devices.length
                ? `${data.devices.length} reporting${unprotected ? `, ${unprotected} with a volume that isn't protected` : ''}.`
                : 'Machines appear here after their first report.'
            }
          />
          {!data ? (
            <Skeleton className="m-5 h-16" />
          ) : !data.devices.length ? (
            <p className="px-5 py-4 text-sm text-muted">Nothing has reported yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      {d.assetId ? (
                        <AppLink to={`/assets/${d.assetId}`} className="hover:underline">
                          {d.hostname}
                        </AppLink>
                      ) : (
                        d.hostname
                      )}{' '}
                      <span className="font-normal text-muted">· {d.clientName}</span>
                    </p>
                    <p className="text-xs text-text-2">
                      {d.volumes.length ? d.volumes.map(volumeSummary).join(' · ') : 'No volumes reported'}
                    </p>
                    <p className="text-xs text-muted">
                      Reported {formatDateTime(d.collectedAt)}
                      {d.assetId ? '' : ' · no matching asset'}
                    </p>
                  </div>
                  {d.blocked ? <Badge tone="warning">Blocked</Badge> : <BitlockerStatusBadge status={d.status} />}
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === `block-${d.id}`}
                    onClick={() =>
                      act(`block-${d.id}`, () =>
                        api(`/bitlocker/devices/${d.id}/block`, { method: 'POST', body: { blocked: !d.blocked } }),
                      )
                    }
                  >
                    {d.blocked ? 'Unblock' : 'Block'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {enrolling && (
        <EnrollDialog
          onClose={() => setEnrolling(false)}
          onMade={(result) => {
            setEnrolling(false);
            setMade(result);
            void overview.refetch();
            toast('Enrollment created. The script was downloaded.');
          }}
        />
      )}
    </>
  );
}
