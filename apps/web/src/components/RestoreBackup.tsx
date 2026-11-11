import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArchiveRestore, RotateCcw, SearchCheck, Upload } from 'lucide-react';
import type { RestoreCheck, RestoreOutcome, RestoreSource, RestoreStatus } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmNameField,
  Dialog,
  Field,
  FormError,
  Input,
  Select,
} from '@/components/ui';
import { ApiError, api, getCsrf } from '@/lib/api';
import { DEMO } from '@/lib/demo';
import { formatBytes, formatDateTime } from '@/lib/format';
import { useActor } from '@/lib/session';

const OUTCOME: Record<RestoreOutcome['state'], { tone: 'info' | 'success' | 'warning' | 'danger'; label: string }> = {
  running: { tone: 'info', label: 'Restoring' },
  done: { tone: 'success', label: 'Restored' },
  'rolled-back': { tone: 'warning', label: 'Put back as it was' },
  failed: { tone: 'danger', label: 'Failed' },
};

/** Uploads a backup file with fetch + FormData (the JSON helper doesn't send files). */
async function uploadBackup(file: File): Promise<{ upload: string; name: string }> {
  if (DEMO) throw new ApiError(400, "Uploading a backup isn't available in the demo.");
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/backups/restore/upload', {
    method: 'POST',
    body: form,
    headers: { 'X-CSRF-Token': getCsrf() },
    credentials: 'same-origin',
  });
  const data = (await response.json().catch(() => null)) as { error?: string; upload: string; name: string } | null;
  if (!response.ok || !data) throw new ApiError(response.status, data?.error ?? 'The upload failed.');
  return data;
}

/**
 * Administration → Status → Restore from a backup. Owner only. Atlas checks the backup with its master key, takes a
 * safety backup, and restarts to install it; "Overwrite current values" replaces the database, after a confirmation.
 */
export function RestoreBackup() {
  const actor = useActor();
  const isOwner = actor.role === 'owner';
  const [restarting, setRestarting] = useState(false);
  const status = useQuery({
    queryKey: ['backup-restore'],
    queryFn: () => api<RestoreStatus>('/backups/restore'),
    // While Atlas restarts, keep asking until it answers again with the outcome.
    refetchInterval: restarting ? 5_000 : false,
    retry: restarting,
  });
  const last = status.data?.last ?? null;
  return (
    <Card>
      <CardHeader
        title="Restore from a backup"
        description="Put this installation's data back from an Atlas backup. Atlas checks the whole backup first, backs up the database as it is now, then restarts to install it."
      />
      <div className="space-y-5 p-5">
        {last && <LastRestore last={last} />}
        {restarting ? (
          <div role="status" className="rounded-xl border border-info/40 bg-info-soft px-4 py-3 text-sm text-info">
            <p className="font-semibold">Atlas is restarting to install the backup.</p>
            <p>
              This usually takes under a minute, longer for a large backup. The result appears here when Atlas is back.
              If you're asked to sign in, sign in again; an overwrite signs everyone out.
            </p>
          </div>
        ) : isOwner ? (
          <RestoreForm files={status.data?.files ?? []} onStaged={() => setRestarting(true)} />
        ) : (
          <p className="text-sm text-muted">Only the owner can restore a backup.</p>
        )}
      </div>
    </Card>
  );
}

function LastRestore({ last }: { last: RestoreOutcome }) {
  const style = OUTCOME[last.state];
  return (
    <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">Last restore</span>
        <Badge tone={style.tone}>{style.label}</Badge>
        <span className="text-text-2">
          {last.mode === 'overwrite' ? 'Overwrite' : 'Add back missing'} · backup of{' '}
          {formatDateTime(last.backupCreatedAt)} · asked for by {last.requestedByName}{' '}
          {formatDateTime(last.requestedAt)}
        </span>
      </p>
      <p className="mt-1 text-text-2">{last.message}</p>
      {last.safetyBackup && <p className="mt-1 text-xs text-muted">Safety backup taken first: {last.safetyBackup}</p>}
    </div>
  );
}

function RestoreForm({ files, onStaged }: { files: RestoreStatus['files']; onStaged: () => void }) {
  const actor = useActor();
  const orgName = actor.organization.name;
  const [chosen, setChosen] = useState('');
  const [uploaded, setUploaded] = useState<{ upload: string; name: string } | null>(null);
  const [masterKey, setMasterKey] = useState('');
  const [checked, setChecked] = useState<RestoreCheck | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [password, setPassword] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'upload' | 'check' | 'restore' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const source: RestoreSource | null = uploaded ? { upload: uploaded.upload } : chosen ? { file: chosen } : null;
  const key = masterKey.trim() || undefined;
  // Changing the backup or the key means checking again.
  const reset = () => {
    setChecked(null);
    setError(null);
  };
  const run = async (name: NonNullable<typeof busy>, work: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, (err as Error).message));
    } finally {
      setBusy(null);
    }
  };
  const mustOverwrite = !!checked && !checked.canMerge;
  const overwriting = overwrite || mustOverwrite;

  const check = (e: FormEvent) => {
    e.preventDefault();
    if (!source) return;
    void run('check', async () => {
      setChecked(
        await api<RestoreCheck>('/backups/restore/check', { method: 'POST', body: { source, masterKey: key } }),
      );
    });
  };
  const restore = (confirmName?: string) =>
    run('restore', async () => {
      await api('/backups/restore', {
        method: 'POST',
        body: { source, masterKey: key, overwrite: overwriting, password, confirmName },
      });
      setConfirming(false);
      onStaged();
    });

  return (
    <form onSubmit={check} className="space-y-5" noValidate>
      <fieldset className="space-y-4">
        <legend className="mb-2 text-[13px] font-semibold text-text">1. Choose the backup</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Backup in the backup folder"
            help={files.length ? 'Newest first. Includes backups made before the last restore.' : 'There are none yet.'}
          >
            {(p) => (
              <Select
                {...p}
                value={uploaded ? '' : chosen}
                disabled={!files.length}
                onChange={(e) => {
                  setChosen(e.target.value);
                  setUploaded(null);
                  reset();
                }}
              >
                <option value="">Choose a backup…</option>
                {files.map((f) => (
                  <option key={f.name} value={f.name}>
                    {formatDateTime(f.modifiedAt)} · {formatBytes(f.size)} · {f.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Or upload a backup file"
            help={
              uploaded ? `Uploaded: ${uploaded.name}` : 'An .atlasbak file from this or another Atlas, up to 20 GB.'
            }
          >
            {(p) => (
              <Input
                {...p}
                type="file"
                accept=".atlasbak"
                disabled={busy === 'upload'}
                className="py-1.5"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  reset();
                  void run('upload', async () => {
                    setUploaded(await uploadBackup(file));
                    setChosen('');
                  });
                }}
              />
            )}
          </Field>
        </div>
        {busy === 'upload' && (
          <p role="status" className="flex items-center gap-2 text-sm text-text-2">
            <Upload className="size-4" aria-hidden /> Uploading the backup…
          </p>
        )}
        <Field
          label="Master key for this backup"
          error={error?.fields?.masterKey}
          help="Leave blank when this installation made the backup with its current key. For a backup from another installation, or from before the key was changed, paste that key: the 43-character line from its key file (atlas-master.key) or its ATLAS_MASTER_KEY setting."
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              value={masterKey}
              onChange={(e) => {
                setMasterKey(e.target.value);
                reset();
              }}
            />
          )}
        </Field>
        <Button type="submit" variant="secondary" loading={busy === 'check'} disabled={!source || busy !== null}>
          <SearchCheck /> Check backup
        </Button>
      </fieldset>

      {checked && (
        <fieldset className="space-y-4 border-t border-border pt-5">
          <legend className="mb-2 text-[13px] font-semibold text-text">2. Install it</legend>
          <div
            role="status"
            className="rounded-xl border border-success/40 bg-success-soft px-4 py-3 text-sm text-success"
          >
            <p className="font-semibold">The backup is complete and unchanged.</p>
            <p>
              Made {formatDateTime(checked.createdAt)} by Atlas {checked.appVersion}: {checked.rows.toLocaleString()}{' '}
              rows in {checked.tables} tables and {checked.files.toLocaleString()} files. Master key {checked.keyId}
              {checked.keyLoaded
                ? ', already loaded here.'
                : '. Atlas moves what it restores onto its own key, so this key isn’t needed afterwards.'}
            </p>
          </div>
          <Checkbox
            label="Overwrite current values"
            checked={overwriting}
            disabled={mustOverwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            description={
              mustOverwrite
                ? `${checked.mergeBlocked} Overwriting replaces the whole database and all attachments with the backup.`
                : 'Off: adds back only what this installation is missing (for example a deleted client or password) and keeps everything here as it is now, including anything changed since the backup. On: replaces the whole database and all attachments with the backup; anything added or changed since it was made is lost, and everyone signs in again.'
            }
          />
          <Field label="Your password" error={error?.fields?.password}>
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          <Button
            type="button"
            variant={overwriting ? 'danger' : 'primary'}
            loading={busy === 'restore' && !confirming}
            disabled={!password || busy !== null}
            onClick={() => (overwriting ? setConfirming(true) : void restore())}
          >
            {overwriting ? <AlertTriangle /> : <RotateCcw />}{' '}
            {overwriting ? 'Overwrite and restore…' : 'Restore backup'}
          </Button>
        </fieldset>
      )}
      {!confirming && <FormError message={error && !error.fields ? error.message : null} />}
      {confirming && (
        <ConfirmOverwrite
          orgName={orgName}
          busy={busy === 'restore'}
          error={error}
          onClose={() => setConfirming(false)}
          onConfirm={(name) => void restore(name)}
        />
      )}
    </form>
  );
}

function ConfirmOverwrite({
  orgName,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  orgName: string;
  busy: boolean;
  error: ApiError | null;
  onClose: () => void;
  onConfirm: (confirmName: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [understood, setUnderstood] = useState(false);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Overwrite the database?"
      description="Everything in Atlas is replaced with the backup: every organization, person, client, document, password, setting, and attachment."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep current data
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!understood || typed.trim() !== orgName.trim()}
            onClick={() => onConfirm(typed)}
          >
            <ArchiveRestore /> Overwrite and restore
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-text-2">
          <li>Anything added or changed since the backup was made is lost.</li>
          <li>Atlas backs up the database as it is now first, and puts it back automatically if the restore fails.</li>
          <li>Atlas restarts to install the backup, and everyone signs in again.</li>
        </ul>
        <Checkbox
          label="I understand this overwrites the current database for everyone"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
        />
        <ConfirmNameField
          label={`Type the organization name: ${orgName}`}
          value={typed}
          onChange={setTyped}
          error={error?.fields?.confirmName}
        />
        <FormError message={error && !error.fields ? error.message : null} />
      </div>
    </Dialog>
  );
}
