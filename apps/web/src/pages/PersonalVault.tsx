import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Star,
  StickyNote,
  Timer,
  Trash2,
  User,
} from 'lucide-react';
import {
  MAX_NOTE_LENGTH,
  type PersonalKind,
  type PersonalPasswordView,
  type PersonalVaultStatus,
  type RevealResult,
} from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { copySecret } from '@/lib/vault';
import { Generator, StrengthMeter } from '@/pages/vault';

const KEY = ['personal-vault'];
export const usePersonalVaultStatus = (enabled: boolean) =>
  useQuery({
    queryKey: [...KEY, 'status'],
    queryFn: () => api<PersonalVaultStatus>('/personal-vault/status'),
    enabled,
  });
const usePersonalVault = () =>
  useQuery({ queryKey: [...KEY, 'list'], queryFn: () => api<PersonalPasswordView[]>('/personal-vault') });
const revealField = (id: string, field: 'secret' | 'notes' | 'totp') =>
  api<RevealResult>(`/personal-vault/${id}/reveal`, { method: 'POST', body: { field } });

function EntryDialog({ item, onClose }: { item?: PersonalPasswordView; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<PersonalKind>(item?.kind ?? 'login');
  const note = kind === 'note';
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(!item);
  const [generating, setGenerating] = useState(false);
  // On edit, stored text is fetched only when asked for, and sent back only if it changed.
  const [shown, setShown] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(item ? null : '');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (field: 'secret' | 'notes') => {
    if (!item) return;
    try {
      const { value } = await revealField(item.id, field);
      if (field === 'notes') setNotes(value);
      else {
        setShown(value);
        setSecret(value);
        setShowSecret(true);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '');
    const body: Record<string, unknown> = { name: text('name') };
    if (!note) {
      body.username = text('username');
      body.url = text('url');
      if (notes !== null) body.notes = notes;
      if (!item || text('totp')) body.totp = text('totp');
    }
    if (!item || (secret && secret !== shown)) body.secret = secret;
    setBusy(true);
    setError(null);
    try {
      if (item) await api(`/personal-vault/${item.id}`, { method: 'PATCH', body: { ...body, version: item.version } });
      else await api('/personal-vault', { method: 'POST', body: { ...body, kind } });
      await queryClient.invalidateQueries({ queryKey: KEY });
      toast(item ? 'Saved.' : 'Saved to your vault.');
      onClose();
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
      size="lg"
      title={item ? `Edit ${item.name}` : 'Add to your vault'}
      description="Only you can see what you keep here. Administrators can’t open it, and it isn’t in any report or log."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="personal-form" loading={busy}>
            {item ? 'Save changes' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="personal-form" onSubmit={submit} className="space-y-4" noValidate>
        {!item && (
          <div role="group" aria-label="Type" className="flex gap-1 rounded-lg bg-surface-3 p-1">
            {(
              [
                ['login', 'Login', KeyRound],
                ['note', 'Secure note', StickyNote],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className="flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium aria-pressed:bg-surface aria-pressed:shadow-sm"
              >
                <Icon className="size-4" aria-hidden /> {label}
              </button>
            ))}
          </div>
        )}
        <div className={cn('grid gap-4', !note && 'sm:grid-cols-2')}>
          <Field label="Name" error={error?.fields?.name}>
            {(p) => <Input {...p} name="name" defaultValue={item?.name} maxLength={200} required autoFocus={!item} />}
          </Field>
          {!note && (
            <Field label="Username" error={error?.fields?.username}>
              {(p) => <Input {...p} name="username" defaultValue={item?.username} maxLength={254} autoComplete="off" />}
            </Field>
          )}
        </div>
        {note && item && shown === null ? (
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="text-muted">The note is encrypted.</span>
            <Button variant="ghost" size="sm" onClick={() => load('secret')}>
              <Eye /> Show to edit
            </Button>
          </div>
        ) : note ? (
          <Field label="Note (encrypted)" error={error?.fields?.secret}>
            {(p) => (
              <Textarea
                {...p}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                rows={8}
                maxLength={MAX_NOTE_LENGTH}
                spellCheck={false}
                required
              />
            )}
          </Field>
        ) : (
          <Field
            label={item ? 'New password' : 'Password'}
            error={error?.fields?.secret}
            help={item ? 'Leave empty to keep the current one.' : undefined}
          >
            {(p) => (
              <div>
                <div className="flex gap-2">
                  <Input
                    {...p}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    type={showSecret ? 'text' : 'password'}
                    autoComplete="new-password"
                    spellCheck={false}
                    className="font-mono"
                    required={!item}
                  />
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label={showSecret ? 'Hide' : 'Show'}
                    onClick={() => setShowSecret((v) => !v)}
                  >
                    {showSecret ? <EyeOff /> : <Eye />}
                  </Button>
                  <Button variant="secondary" onClick={() => setGenerating((v) => !v)} aria-expanded={generating}>
                    <RefreshCw /> Generate
                  </Button>
                </div>
                <StrengthMeter value={secret} />
              </div>
            )}
          </Field>
        )}
        {generating && !note && (
          <Generator
            onUse={(value) => {
              setSecret(value);
              setShowSecret(true);
              setGenerating(false);
            }}
          />
        )}
        {!note && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Website or address" error={error?.fields?.url}>
              {(p) => (
                <Input {...p} name="url" type="url" defaultValue={item?.url} maxLength={2000} placeholder="https://" />
              )}
            </Field>
            <Field
              label="Authenticator setup key (TOTP)"
              error={error?.fields?.totp}
              help={
                item?.hasTotp
                  ? 'Set. Enter a new key to replace it.'
                  : 'Optional. Atlas will show the current 6-digit code.'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  name="totp"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono uppercase"
                  maxLength={200}
                />
              )}
            </Field>
          </div>
        )}
        {note ? null : notes === null ? (
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="text-muted">{item?.hasNotes ? 'Notes are encrypted.' : 'No notes.'}</span>
            {item?.hasNotes ? (
              <Button variant="ghost" size="sm" onClick={() => load('notes')}>
                <Eye /> Show to edit
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setNotes('')}>
                <Plus /> Add notes
              </Button>
            )}
          </div>
        ) : (
          <Field label="Notes (encrypted)" error={error?.fields?.notes}>
            {(p) => (
              <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={20000} />
            )}
          </Field>
        )}
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

/** Reads one entry: its password or note, notes, and one-time code, each shown only when asked for. */
function ViewDialog({
  item,
  onClose,
  onEdit,
}: {
  item: PersonalPasswordView;
  onClose: () => void;
  onEdit: () => void;
}) {
  const toast = useToast();
  const [secret, setSecret] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [code, setCode] = useState<{ value: string; until: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [code]);
  const left = code ? Math.max(0, Math.ceil((code.until - now) / 1000)) : 0;
  const guard = (work: () => Promise<void>) => () => work().catch((e: Error) => toast(e.message, 'error'));
  const showCode = async () => {
    try {
      const result = await revealField(item.id, 'totp');
      setNow(Date.now());
      setCode({ value: result.value, until: Date.now() + (result.expiresIn ?? 30) * 1000 });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const note = item.kind === 'note';
  const row = 'flex items-center gap-3 px-1 py-3';
  const label = 'text-xs font-medium text-muted';
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={item.name}
      description={`${note ? 'Secure note' : 'Login'} in your vault · changed ${formatDate(item.changedAt)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onEdit}>
            <Pencil /> Edit
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <div className="divide-y divide-border">
        {!note && item.username && (
          <div className={row}>
            <div className="min-w-0 flex-1">
              <p className={label}>Username</p>
              <p className="mt-0.5 truncate text-sm">{item.username}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Copy username"
              onClick={() => navigator.clipboard.writeText(item.username).then(() => toast('Username copied.'))}
            >
              <Copy />
            </Button>
          </div>
        )}
        <div className={row}>
          <div className="min-w-0 flex-1">
            <p className={label}>{note ? 'Note' : 'Password'}</p>
            {secret === null ? (
              <p className="mt-0.5 text-sm text-muted">Hidden</p>
            ) : (
              <p className={cn('mt-0.5 text-sm break-words whitespace-pre-wrap', !note && 'font-mono')}>{secret}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={
              secret === null
                ? guard(async () => setSecret((await revealField(item.id, 'secret')).value))
                : () => setSecret(null)
            }
          >
            {secret === null ? <Eye /> : <EyeOff />} {secret === null ? 'Show' : 'Hide'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={note ? 'Copy note' : 'Copy password'}
            onClick={guard(async () => {
              await copySecret(secret ?? (await revealField(item.id, 'secret')).value);
              toast('Copied. The clipboard clears in 30 seconds.');
            })}
          >
            <Copy />
          </Button>
        </div>
        {item.hasTotp && (
          <div className={row}>
            <div className="min-w-0 flex-1">
              <p className={label}>One-time code</p>
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
            ) : (
              <Button variant="ghost" size="sm" onClick={showCode}>
                <Eye /> Show code
              </Button>
            )}
          </div>
        )}
        {!note && item.url && (
          <div className={row}>
            <div className="min-w-0 flex-1">
              <p className={label}>Website or address</p>
              <p className="mt-0.5 truncate text-sm">{item.url}</p>
            </div>
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="grid size-9 place-items-center rounded-lg text-text-2 hover:bg-surface-3"
              aria-label="Open the website in a new tab"
            >
              <ExternalLink className="size-4" aria-hidden />
            </a>
          </div>
        )}
        {item.hasNotes && (
          <div className={row}>
            <div className="min-w-0 flex-1">
              <p className={label}>Notes</p>
              {notes === null ? (
                <p className="mt-0.5 text-sm text-muted">Hidden</p>
              ) : (
                <p className="mt-0.5 text-sm break-words whitespace-pre-wrap">{notes}</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={
                notes === null
                  ? guard(async () => setNotes((await revealField(item.id, 'notes')).value))
                  : () => setNotes(null)
              }
            >
              {notes === null ? <Eye /> : <EyeOff />} {notes === null ? 'Show' : 'Hide'}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function DeleteDialog({ item, onClose }: { item: PersonalPasswordView; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/personal-vault/${item.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: KEY });
      toast(`${item.name} deleted.`);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Delete ${item.name}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={remove}>
            Delete
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-2">
        It’s removed for good. A personal vault has no archive, and nobody can bring it back.
      </p>
    </Dialog>
  );
}

type Open = { mode: 'add' } | { mode: 'view' | 'edit' | 'delete'; id: string };

export function PersonalVault() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const status = usePersonalVaultStatus(true);
  const off = status.data?.enabled === false;
  const list = usePersonalVault();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Open | null>(null);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data ?? []).filter(
      (p) => !q || [p.name, p.username, p.url].some((text) => text.toLowerCase().includes(q)),
    );
  }, [list.data, query]);
  // Always the freshest copy of the entry, so an edit after a change sends the right version.
  const current = open && open.mode !== 'add' ? list.data?.find((p) => p.id === open.id) : undefined;
  const guard = (work: () => Promise<void>) => () => work().catch((e: Error) => toast(e.message, 'error'));
  const star = (p: PersonalPasswordView) =>
    guard(async () => {
      await api(`/personal-vault/${p.id}`, { method: 'PATCH', body: { favorite: !p.favorite, version: p.version } });
      await queryClient.invalidateQueries({ queryKey: KEY });
    });
  const copy = (p: PersonalPasswordView, field: 'secret' | 'totp') =>
    guard(async () => {
      await copySecret((await revealField(p.id, field)).value);
      toast(field === 'totp' ? 'Code copied.' : 'Copied. The clipboard clears in 30 seconds.');
    });

  return (
    <>
      <PageHeader
        eyebrow="Passwords"
        title="My vault"
        description="Your own logins and notes. Only you can see them: not administrators, not the owner. They stay out of client records, reports, search, and the audit log."
        actions={
          !off && (
            <Button onClick={() => setOpen({ mode: 'add' })}>
              <Plus /> Add
            </Button>
          )
        }
      />
      {off ? (
        <Card>
          <EmptyState
            icon={Lock}
            title="Personal vaults are turned off"
            description="Your organization doesn’t use personal vaults. Anything you saved before is kept and comes back if they’re turned on again."
          />
        </Card>
      ) : !list.data ? (
        <Skeleton className="h-72" />
      ) : !list.data.length ? (
        <Card>
          <EmptyState
            icon={Lock}
            title="Nothing here yet"
            description="Keep the logins that are yours alone, like your own vendor portal or payroll account, so they don’t end up in a client’s vault or a sticky note."
            action={
              <Button onClick={() => setOpen({ mode: 'add' })}>
                <Plus /> Add your first entry
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="relative mb-4 max-w-md">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              aria-label="Search your vault"
              placeholder="Search your vault"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Card>
            {!items.length ? (
              <p className="px-5 py-10 text-center text-sm text-muted">Nothing matches “{query.trim()}”.</p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
                    <button
                      type="button"
                      aria-label={p.favorite ? `Remove ${p.name} from favorites` : `Add ${p.name} to favorites`}
                      aria-pressed={p.favorite}
                      onClick={star(p)}
                      className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 aria-pressed:text-warning"
                    >
                      <Star className={cn('size-4', p.favorite && 'fill-current')} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen({ mode: 'view', id: p.id })}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-surface-3"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-text-2">
                        {p.kind === 'note' ? (
                          <StickyNote className="size-4" aria-hidden />
                        ) : (
                          <KeyRound className="size-4" aria-hidden />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{p.name}</span>
                          {p.kind === 'login' && p.strength !== null && p.strength <= 1 && (
                            <Badge tone="danger">Weak</Badge>
                          )}
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {p.kind === 'note'
                            ? 'Secure note'
                            : [p.username, p.url.replace(/^https?:\/\//i, '')].filter(Boolean).join(' · ') || 'Login'}
                        </span>
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center">
                      {p.kind === 'login' && p.username && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="max-sm:hidden"
                          aria-label={`Copy username for ${p.name}`}
                          onClick={() =>
                            navigator.clipboard.writeText(p.username).then(() => toast('Username copied.'))
                          }
                        >
                          <User />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={p.kind === 'note' ? `Copy ${p.name}` : `Copy password for ${p.name}`}
                        onClick={copy(p, 'secret')}
                      >
                        <Copy />
                      </Button>
                      {p.hasTotp && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="max-sm:hidden"
                          aria-label={`Copy one-time code for ${p.name}`}
                          onClick={copy(p, 'totp')}
                        >
                          <Timer />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${p.name}`}
                        onClick={() => setOpen({ mode: 'edit', id: p.id })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${p.name}`}
                        onClick={() => setOpen({ mode: 'delete', id: p.id })}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p className="mt-3 text-xs text-muted">
            {list.data.length} {list.data.length === 1 ? 'entry' : 'entries'}. The Atlas browser extension offers your
            own logins on matching sites, marked “My vault”.
          </p>
        </>
      )}
      {open?.mode === 'add' && <EntryDialog onClose={() => setOpen(null)} />}
      {open?.mode === 'view' && current && (
        <ViewDialog
          key={current.id}
          item={current}
          onClose={() => setOpen(null)}
          onEdit={() => setOpen({ mode: 'edit', id: current.id })}
        />
      )}
      {open?.mode === 'edit' && current && <EntryDialog item={current} onClose={() => setOpen(null)} />}
      {open?.mode === 'delete' && current && <DeleteDialog item={current} onClose={() => setOpen(null)} />}
    </>
  );
}
