import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, History, Link2, Share2, Upload, Download, FileLock, Timer, Trash2 } from 'lucide-react';
import { type PasswordView, type UserView } from '@atlas/shared';
import {
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
  Drawer,
} from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useUsers, useGroups } from '@/lib/queries';
import {
  copySecret,
  createShareLink,
  useAskReason,
  usePasswordAudit,
  usePasswordHistory,
  useReveal,
  useShares,
  useDownloadPasswordFile,
  usePasswordFiles,
  uploadPasswordFile,
} from '@/lib/vault';

import { useQuickShare } from '@/components/vault/useQuickShare';

// The cards on a password page: the secret and one-time code, history, access log, files, links, and access.
export function SecretRow({
  label,
  item,
  field,
  fieldId,
  mono = true,
  multiline = field === 'notes',
}: {
  label: string;
  item: PasswordView;
  field: 'secret' | 'notes' | 'custom';
  fieldId?: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  const reveal = useReveal();
  const toast = useToast();
  const [value, setValue] = useState<string | null>(null);
  // Revealed values hide again after a minute.
  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setValue(null), 60_000);
    return () => clearTimeout(timer);
  }, [value]);
  const run = async (copy: boolean) => {
    try {
      const result = await reveal(item, { field, fieldId, copy });
      if (!result) return;
      if (copy) {
        await copySecret(result.value);
        toast(`${label} copied. The clipboard clears in 30 seconds.`);
      } else setValue(result.value);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted">{label}</p>
        <p
          className={cn(
            'mt-0.5 text-sm break-all',
            mono && 'font-mono',
            multiline && value && 'font-sans whitespace-pre-wrap',
          )}
          aria-live="polite"
        >
          {value ?? '••••••••••••'}
        </p>
      </div>
      {item.canReveal && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={value ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          onClick={() => (value ? setValue(null) : run(false))}
        >
          {value ? <EyeOff /> : <Eye />}
        </Button>
      )}
      {item.canReveal && field !== 'notes' && (
        <Button variant="ghost" size="icon" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => run(true)}>
          <Copy />
        </Button>
      )}
    </div>
  );
}

export function TotpRow({ item }: { item: PasswordView }) {
  const reveal = useReveal();
  const toast = useToast();
  const [code, setCode] = useState<{ value: string; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);
  const left = code ? Math.max(0, Math.ceil((code.until - now) / 1000)) : 0;
  const show = async () => {
    try {
      const result = await reveal(item, { field: 'totp' }, 'Why do you need this one-time code?');
      if (result) setCode({ value: result.value, until: Date.now() + (result.expiresIn ?? 30) * 1000 });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-muted">One-time code</p>
        {code && left > 0 ? (
          <p className="mt-0.5 flex items-center gap-3 font-mono text-lg tracking-[0.3em]" aria-live="polite">
            {code.value.slice(0, 3)} {code.value.slice(3)}
            <span className="flex items-center gap-1 font-sans text-xs tracking-normal text-muted">
              <Timer className="size-3.5" aria-hidden /> {left}s
            </span>
          </p>
        ) : (
          <p className="mt-0.5 text-sm text-muted">Hidden</p>
        )}
      </div>
      {code && left > 0 ? (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Copy one-time code"
          onClick={() => copySecret(code.value).then(() => toast('Code copied.'))}
        >
          <Copy />
        </Button>
      ) : item.canReveal ? (
        <Button variant="ghost" size="sm" onClick={show}>
          <Eye /> Show code
        </Button>
      ) : null}
    </div>
  );
}

export function HistoryCard({ item }: { item: PasswordView }) {
  const { data } = usePasswordHistory(item.id);
  const reveal = useReveal();
  const toast = useToast();
  const [shown, setShown] = useState<Record<string, string>>({});
  return (
    <Card>
      <CardHeader title="Previous passwords" description={`Changed ${relativeTime(item.changedAt)}`} />
      {!data?.length ? (
        <p className="px-5 py-4 text-sm text-muted">No earlier passwords.</p>
      ) : (
        <ul className="max-h-64 divide-y divide-border overflow-y-auto">
          {data.map((h) => (
            <li key={h.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <History className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-[13px]">{shown[h.id] ?? '••••••••'}</span>
                <span className="block text-xs text-muted">
                  Replaced by {h.changedByName} · {formatDateTime(h.createdAt)}
                </span>
              </span>
              {!shown[h.id] && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      const result = await reveal(item, { historyId: h.id });
                      if (result) setShown((s) => ({ ...s, [h.id]: result.value }));
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  }}
                >
                  Show
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AuditCard({ item }: { item: PasswordView }) {
  const { data } = usePasswordAudit(item.id);
  return (
    <Card>
      <CardHeader title="Access history" description="Who viewed, copied, or changed this, and why." />
      <ul className="max-h-80 divide-y divide-border overflow-y-auto">
        {data?.map((a) => (
          <li key={a.id} className="px-5 py-2.5 text-sm">
            <p>
              <span className="font-medium">{a.actorName}</span>{' '}
              <span className="text-text-2">{a.action.toLowerCase()}</span>
            </p>
            <p className="text-xs text-muted">
              {formatDateTime(a.createdAt)}
              {a.ip && ` · ${a.ip}`}
              {a.reason && <span className="block text-text-2">Reason: {a.reason}</span>}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const fileSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

/** License files, certificates, SSH keys: encrypted like the entry, and each download is recorded. */
export function FilesCard({ item }: { item: PasswordView }) {
  const { data, isLoading } = usePasswordFiles(item.id);
  const downloadFile = useDownloadPasswordFile();
  const queryClient = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = !item.archived;
  const refresh = () =>
    Promise.all(
      ['password-files', 'password-audit'].map((k) => queryClient.invalidateQueries({ queryKey: [k, item.id] })),
    );
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files))
        queryClient.setQueryData(['password-files', item.id], await uploadPasswordFile(item.id, file));
      await refresh();
      toast(
        files.length === 1 ? `${files[0]!.name} encrypted and saved.` : `${files.length} files encrypted and saved.`,
      );
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <Card>
      <CardHeader
        title="Files"
        actions={
          canEdit && (
            <>
              <input
                ref={input}
                type="file"
                multiple
                className="sr-only"
                aria-label="Choose files to add to this entry"
                onChange={(e) => upload(e.target.files)}
              />
              <Button variant="ghost" size="sm" loading={busy} onClick={() => input.current?.click()}>
                <Upload /> Add
              </Button>
            </>
          )
        }
      />
      {isLoading ? (
        <Skeleton className="m-4 h-10" />
      ) : !data?.length ? (
        <p className="px-5 py-4 text-sm text-muted">
          Keep license files, certificates, or SSH keys with this entry. They&rsquo;re encrypted, and every download is
          recorded.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-text-2">
                <FileLock className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{f.filename}</span>
                <span className="block text-xs text-muted">
                  {fileSize(f.size)} · {f.uploadedByName ?? 'Someone'} · {relativeTime(f.createdAt)}
                </span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Download ${f.filename}`}
                onClick={async () => {
                  try {
                    await downloadFile(item, f);
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              >
                <Download />
              </Button>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Delete ${f.filename}`}
                  onClick={async () => {
                    if (!confirm(`Delete ${f.filename}? This can't be undone.`)) return;
                    try {
                      await api(`/passwords/${item.id}/attachments/${f.id}`, { method: 'DELETE' });
                      await refresh();
                      toast('File deleted.');
                    } catch (e) {
                      toast((e as Error).message, 'error');
                    }
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SharesCard({ item }: { item: PasswordView }) {
  const { data } = useShares(item.id);
  const [sharing, setSharing] = useState(false);
  const { share: quickShare, dialog: quickShareDialog } = useQuickShare();
  const [quickBusy, setQuickBusy] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const active = (data ?? []).filter(
    (s) => !s.revoked && s.views < s.maxViews && s.expiresAt > new Date().toISOString(),
  );
  return (
    <Card>
      <CardHeader
        title="Share links"
        actions={
          <div className="flex gap-1">
            <Button
              size="sm"
              loading={quickBusy}
              onClick={async () => {
                setQuickBusy(true);
                try {
                  const done = await quickShare(item);
                  if (done) toast(done);
                } catch (e) {
                  toast((e as Error).message, 'error');
                } finally {
                  setQuickBusy(false);
                }
              }}
            >
              <Share2 /> Quick share
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSharing(true)}>
              More options
            </Button>
          </div>
        }
      />
      {!active.length ? (
        <p className="px-5 py-4 text-sm text-muted">
          Send a one-time link instead of pasting passwords into email or chat.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {active.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <Link2 className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block">
                  {s.views} of {s.maxViews} view{s.maxViews === 1 ? '' : 's'} used
                </span>
                <span className="block text-xs text-muted">
                  By {s.createdByName} · expires {formatDateTime(s.expiresAt)}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  await api(`/passwords/${item.id}/shares/${s.id}`, { method: 'DELETE' });
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ['password-shares', item.id] }),
                    queryClient.invalidateQueries({ queryKey: ['password-audit', item.id] }),
                  ]);
                  toast('Link revoked.');
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {sharing && <ShareDialog item={item} onClose={() => setSharing(false)} />}
      {quickShareDialog}
    </Card>
  );
}

function ShareDialog({ item, onClose }: { item: PasswordView; onClose: () => void }) {
  const ask = useAskReason();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [maxViews, setMaxViews] = useState(1);
  const [hours, setHours] = useState(24);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      let reason = '';
      if (item.requireReason) {
        const given = await ask('Why are you sharing this password?');
        if (given === null) return;
        reason = given;
      }
      setLink(await createShareLink(item, { maxViews, hours, reason }));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['password-shares', item.id] }),
        queryClient.invalidateQueries({ queryKey: ['password-audit', item.id] }),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title="Share with a one-time link"
      description="The password is encrypted in your browser. Atlas stores only the encrypted copy; the key is part of the link."
      footer={
        link ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy}>
              Create link
            </Button>
          </>
        )
      }
    >
      {link ? (
        <div className="space-y-3">
          <Field
            label="Share link"
            help="Copy it now. It isn't shown again, and anyone with it can open it until it's used up or expires."
          >
            {(p) => (
              <div className="flex gap-2">
                <Input {...p} readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
                <Button
                  variant="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(link);
                    toast('Link copied.');
                  }}
                >
                  <Copy /> Copy
                </Button>
              </div>
            )}
          </Field>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Can be opened">
            {(p) => (
              <Select {...p} value={maxViews} onChange={(e) => setMaxViews(Number(e.target.value))}>
                {[1, 2, 3, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Once' : `${n} times`}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Expires after">
            {(p) => (
              <Select {...p} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                {[
                  [1, '1 hour'],
                  [24, '1 day'],
                  [72, '3 days'],
                  [168, '7 days'],
                ].map(([h, label]) => (
                  <option key={h} value={h}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <FormError message={error} />
        </div>
      )}
    </Drawer>
  );
}

export function AccessCard({ item }: { item: PasswordView }) {
  const users = useUsers(true);
  const groups = useGroups(true);
  const toast = useToast();
  const [selected, setSelected] = useState<{ users: Set<string>; groups: Set<string> } | null>(null);
  useEffect(() => {
    api<{ userIds: string[]; groupIds: string[] }>(`/passwords/${item.id}/access`).then((r) =>
      setSelected({ users: new Set(r.userIds), groups: new Set(r.groupIds) }),
    );
  }, [item.id]);
  const staff = (users.data ?? []).filter((u: UserView) => !['owner', 'admin'].includes(u.role) && !u.disabled);
  const toggle = async (kind: 'users' | 'groups', id: string, on: boolean) => {
    const next = { users: new Set(selected!.users), groups: new Set(selected!.groups) };
    if (on) next[kind].add(id);
    else next[kind].delete(id);
    setSelected(next);
    try {
      await api(`/passwords/${item.id}/access`, {
        method: 'PUT',
        body: { userIds: [...next.users], groupIds: [...next.groups] },
      });
      toast('Access updated.');
    } catch (err) {
      setSelected(selected);
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Card>
      <CardHeader
        title="Who can use it"
        description="Restricted: administrators plus the people and groups ticked here."
      />
      <div className="space-y-4 px-5 py-4">
        {!selected ? (
          <Skeleton className="h-16" />
        ) : (
          <>
            {!!groups.data?.length && (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-[13px] font-medium text-muted">Groups</legend>
                {groups.data.map((g) => (
                  <Checkbox
                    key={g.id}
                    label={g.name}
                    description={`${g.memberIds.length} member${g.memberIds.length === 1 ? '' : 's'}`}
                    checked={selected.groups.has(g.id)}
                    onChange={(e) => toggle('groups', g.id, e.target.checked)}
                  />
                ))}
              </fieldset>
            )}
            <fieldset className="space-y-2">
              <legend className="mb-1 text-[13px] font-medium text-muted">People</legend>
              {!staff.length ? (
                <p className="text-sm text-muted">There are no other staff accounts yet.</p>
              ) : (
                staff.map((u) => (
                  <Checkbox
                    key={u.id}
                    label={u.name}
                    description={u.email}
                    checked={selected.users.has(u.id)}
                    onChange={(e) => toggle('users', u.id, e.target.checked)}
                  />
                ))
              )}
            </fieldset>
          </>
        )}
      </div>
    </Card>
  );
}
