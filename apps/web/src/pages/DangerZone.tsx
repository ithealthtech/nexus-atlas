import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ShieldAlert, Trash2 } from 'lucide-react';
import type { EraseStatus } from '@atlas/shared';
import { Button, Card, CardHeader, Dialog, Field, FormError, Input, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useActor } from '@/lib/session';

const ERASED = [
  'Every client, and everything in it: contacts, locations, assets, documents, and passwords with their history',
  'The knowledge base, folders, links, attachments, activity, and custom asset layouts',
  'Import history, and ConnectWise RMM company links',
];
const KEPT = [
  'People and their sign-ins, groups, and settings',
  'Hudu and ConnectWise RMM connections, and backups',
  'The security log, which records this',
];

/** Ticks once a second while something is counting down. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const left = (until: string, now: number) => {
  const s = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Step one: password, a fresh authenticator code, and the organization's name typed exactly. */
function RequestDialog({ orgName, onClose, onDone }: { orgName: string; onClose: () => void; onDone: () => void }) {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [understood, setUnderstood] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/org/erase/request', {
        method: 'POST',
        body: { password: form.get('password'), code: form.get('code'), confirmName: typed },
      });
      onDone();
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
      title="Erase all data"
      description="This starts a 10-minute wait. Every administrator is emailed and can cancel it. After the wait you confirm once more, and a full backup is taken before anything is erased."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep my data
          </Button>
          <Button
            type="submit"
            form="erase-request"
            variant="danger"
            loading={busy}
            disabled={!understood || typed.trim() !== orgName.trim()}
          >
            <Trash2 /> Request erase
          </Button>
        </>
      }
    >
      <form id="erase-request" onSubmit={submit} className="space-y-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">
            <p className="mb-1 font-semibold">Erased</p>
            <ul className="list-disc space-y-1 pl-4">
              {ERASED.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
            <p className="mb-1 font-semibold">Kept</p>
            <ul className="list-disc space-y-1 pl-4 text-text-2">
              {KEPT.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-(--danger)"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          I understand this erases all documentation for everyone in this organization.
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Your password" error={error?.fields?.password}>
            {(p) => <Input {...p} name="password" type="password" autoComplete="current-password" required />}
          </Field>
          <Field label="Authenticator code" error={error?.fields?.code}>
            {(p) => (
              <Input
                {...p}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="font-mono"
                required
              />
            )}
          </Field>
        </div>
        <Field label={`Type the organization name: ${orgName}`} error={error?.fields?.confirmName}>
          {(p) => (
            <Input
              {...p}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

/** Owner-only erase of all documentation, behind a request, a wait any administrator can cancel, and a backup. */
export function DangerZone() {
  const actor = useActor();
  const toast = useToast();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['org-erase'],
    queryFn: () => api<EraseStatus>('/org/erase'),
    refetchInterval: (q) => (q.state.data?.pending ? 15_000 : false),
  });
  const pending = status.data?.pending ?? null;
  const now = useNow(!!pending);
  const [requesting, setRequesting] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOwner = actor.role === 'owner';
  const orgName = actor.organization.name;
  const confirmable = !!pending && Date.parse(pending.confirmableAt) <= now;

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

  return (
    <Card className="border-danger/40">
      <CardHeader
        title="Danger zone"
        description="Erase all documentation to start again from scratch. Only the owner can do this."
      />
      <div className="space-y-4 p-5">
        {!pending ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="mr-auto max-w-prose text-sm text-text-2">
              Erases every client, asset, document, and password. People, settings, integrations, backups, and the
              security log are kept. Takes at least 10 minutes and a final confirmation, with a backup first.
            </p>
            {isOwner && (
              <Button variant="danger" onClick={() => setRequesting(true)}>
                <Trash2 /> Erase all data…
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-danger">
              <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div>
                <p className="font-semibold">
                  {pending.requestedByName} asked to erase all data on {formatDateTime(pending.requestedAt)}.
                </p>
                <p aria-live="polite">
                  {confirmable
                    ? `The owner can confirm until ${formatDateTime(pending.expiresAt)}; after that the request lapses.`
                    : `Nothing can be erased for ${left(pending.confirmableAt, now)} more. Any administrator can cancel.`}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <Button
                variant="secondary"
                loading={busy === 'cancel'}
                onClick={() =>
                  act('cancel', async () => {
                    await api('/org/erase', { method: 'DELETE' });
                    await status.refetch();
                    toast('Erase cancelled. Nothing was erased.');
                  })
                }
              >
                Cancel the erase
              </Button>
              {isOwner && confirmable && (
                <>
                  <label className="min-w-56 flex-1">
                    <span className="mb-1 block text-xs font-medium text-muted">
                      Type the organization name to confirm: {orgName}
                    </span>
                    <Input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <Button
                    variant="danger"
                    loading={busy === 'confirm'}
                    disabled={typed.trim() !== orgName.trim()}
                    onClick={() =>
                      act('confirm', async () => {
                        const result = await api<{ clients: number; backup: string }>('/org/erase/confirm', {
                          method: 'POST',
                          body: { confirmName: typed },
                        });
                        await queryClient.invalidateQueries();
                        toast(`All data erased (${result.clients} clients). Backup: ${result.backup}.`);
                      })
                    }
                  >
                    <AlertTriangle /> Back up, then erase everything
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
        <FormError message={error} />
      </div>
      {requesting && (
        <RequestDialog
          orgName={orgName}
          onClose={() => setRequesting(false)}
          onDone={() => {
            setRequesting(false);
            void status.refetch();
            toast('Erase requested. Every administrator has been emailed; you can confirm in 10 minutes.');
          }}
        />
      )}
    </Card>
  );
}
