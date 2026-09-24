import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  History,
  KeyRound,
  Link2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Share2,
  ShieldCheck,
  Timer,
  Users,
} from 'lucide-react';
import { STRENGTH_LABELS, passwordStrength, type PasswordKind, type PasswordView, type UserView } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
  type Tone,
} from '@/components/ui';
import { AppLink, useGo } from '@/components/AppLink';
import { RelatedPanel } from '@/components/panels';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime, relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';
import { useClient, useClients, useUsers, useGroups } from '@/lib/queries';
import {
  DEFAULT_GENERATOR,
  copySecret,
  encryptShare,
  generatePassword,
  useAskReason,
  usePassword,
  usePasswordAudit,
  usePasswordHistory,
  usePasswords,
  useReveal,
  useShares,
  type GeneratorOptions,
} from '@/lib/vault';

const strengthTone: Tone[] = ['danger', 'danger', 'warning', 'success', 'success'];
const today = () => new Date().toISOString().slice(0, 10);
export const rotationOverdue = (p: PasswordView) => !!p.rotationDue && p.rotationDue <= today();

function StrengthMeter({ value }: { value: string }) {
  const score = passwordStrength(value);
  return (
    <div className="mt-1.5 flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              'h-1.5 flex-1 rounded-full bg-surface-3',
              value && i < Math.max(score, 1) && (score <= 1 ? 'bg-danger' : score === 2 ? 'bg-warning' : 'bg-success'),
            )}
          />
        ))}
      </div>
      <span className="w-24 text-right text-xs text-muted">{value ? STRENGTH_LABELS[score] : ''}</span>
    </div>
  );
}

function Generator({ onUse }: { onUse: (value: string) => void }) {
  const [options, setOptions] = useState<GeneratorOptions>(DEFAULT_GENERATOR);
  const [value, setValue] = useState(() => generatePassword(DEFAULT_GENERATOR));
  const update = (patch: Partial<GeneratorOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    setValue(generatePassword(next));
  };
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md bg-surface px-3 py-2 font-mono text-sm"
          aria-label="Generated password"
        >
          {value}
        </code>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Generate another"
          onClick={() => setValue(generatePassword(options))}
        >
          <RefreshCw />
        </Button>
        <Button size="sm" onClick={() => onUse(value)}>
          Use
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <div role="group" aria-label="Generator type" className="flex gap-1 rounded-lg bg-surface-3 p-1">
          {(['characters', 'passphrase'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={options.mode === mode}
              onClick={() => update({ mode })}
              className="rounded-md px-2.5 py-1 text-xs font-medium capitalize aria-pressed:bg-surface aria-pressed:shadow-sm"
            >
              {mode}
            </button>
          ))}
        </div>
        {options.mode === 'characters' ? (
          <>
            <label className="flex items-center gap-2">
              Length
              <input
                type="range"
                min={12}
                max={64}
                value={options.length}
                onChange={(e) => update({ length: Number(e.target.value) })}
                className="accent-(--primary)"
              />
              <span className="w-6 tabular-nums">{options.length}</span>
            </label>
            <Checkbox label="Numbers" checked={options.digits} onChange={(e) => update({ digits: e.target.checked })} />
            <Checkbox
              label="Symbols"
              checked={options.symbols}
              onChange={(e) => update({ symbols: e.target.checked })}
            />
          </>
        ) : (
          <label className="flex items-center gap-2">
            Words
            <input
              type="range"
              min={4}
              max={10}
              value={options.words}
              onChange={(e) => update({ words: Number(e.target.value) })}
              className="accent-(--primary)"
            />
            <span className="w-6 tabular-nums">{options.words}</span>
          </label>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- form
export function PasswordDialog({
  clientId,
  item,
  onClose,
}: {
  clientId: string;
  item?: PasswordView;
  onClose: () => void;
}) {
  const actor = useActor();
  const toast = useToast();
  const go = useGo();
  const queryClient = useQueryClient();
  const reveal = useReveal();
  const [kind, setKind] = useState<PasswordKind>(item?.kind ?? 'login');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(!item);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '');
    const rotation = text('rotationDays');
    const body: Record<string, unknown> = {
      name: text('name'),
      username: text('username'),
      url: kind === 'login' ? text('url') : '',
      rotationDays: rotation ? Number(rotation) : null,
      ...(actor.isAdmin ? { restricted: form.get('restricted') === 'on' } : {}),
      clientVisible: form.get('clientVisible') === 'on',
    };
    // On edit, secrets are sent only when changed, so unrevealed values are never round-tripped.
    if (!item || secret) body.secret = secret;
    if (!item || form.get('notes') !== null) body.notes = text('notes');
    if (kind === 'login' && (!item || text('totp'))) body.totp = text('totp');
    setBusy(true);
    setError(null);
    try {
      const saved = item
        ? await api<PasswordView>(`/passwords/${item.id}`, {
            method: 'PATCH',
            body: { ...body, version: item.version },
          })
        : await api<PasswordView>(`/clients/${clientId}/passwords`, { method: 'POST', body: { ...body, kind } });
      queryClient.setQueryData(['password', saved.id], saved);
      await Promise.all(
        ['passwords', 'password-history', 'password-audit', 'activity'].map((k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
      toast(item ? 'Saved.' : `${saved.name} saved to the vault.`);
      onClose();
      if (!item) go(`/passwords/${saved.id}`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const [notes, setNotes] = useState<string | null>(item ? null : '');
  const loadNotes = async () => {
    const result = item && (await reveal(item, { field: 'notes' }, 'Why do you need to see these notes?'));
    if (result) setNotes(result.value);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={item ? `Edit ${item.name}` : 'Add to the vault'}
      description="Secrets are encrypted before they're stored. Every view and copy is recorded."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="password-form" loading={busy}>
            {item ? 'Save changes' : 'Save to vault'}
          </Button>
        </>
      }
    >
      <form id="password-form" onSubmit={submit} className="space-y-4" noValidate>
        {!item && (
          <div role="group" aria-label="Type" className="flex gap-1 rounded-lg bg-surface-3 p-1">
            {(
              [
                ['login', 'Login', KeyRound],
                ['bitlocker', 'BitLocker recovery key', HardDrive],
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={error?.fields?.name}>
            {(p) => (
              <Input
                {...p}
                name="name"
                defaultValue={item?.name}
                required
                maxLength={200}
                autoFocus
                placeholder={kind === 'bitlocker' ? 'e.g. HDG-DC-01 · C:' : 'e.g. Firewall admin'}
              />
            )}
          </Field>
          <Field label={kind === 'bitlocker' ? 'Recovery key ID' : 'Username'} error={error?.fields?.username}>
            {(p) => (
              <Input
                {...p}
                name="username"
                defaultValue={item?.username}
                maxLength={254}
                autoComplete="off"
                className={kind === 'bitlocker' ? 'font-mono' : undefined}
              />
            )}
          </Field>
        </div>
        <Field
          label={kind === 'bitlocker' ? 'Recovery key' : item ? 'New password' : 'Password'}
          error={error?.fields?.secret}
          help={item ? 'Leave empty to keep the current one. Changing it keeps the old one in history.' : undefined}
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
                  placeholder={
                    kind === 'bitlocker' ? '000000-000000-000000-000000-000000-000000-000000-000000' : undefined
                  }
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
                {kind === 'login' && (
                  <Button variant="secondary" onClick={() => setGenerating((v) => !v)} aria-expanded={generating}>
                    <RefreshCw /> Generate
                  </Button>
                )}
              </div>
              {kind === 'login' && <StrengthMeter value={secret} />}
            </div>
          )}
        </Field>
        {generating && (
          <Generator
            onUse={(value) => {
              setSecret(value);
              setShowSecret(true);
              setGenerating(false);
            }}
          />
        )}
        {kind === 'login' && (
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
        {notes === null ? (
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="text-muted">{item?.hasNotes ? 'Notes are encrypted.' : 'No notes.'}</span>
            {item?.hasNotes ? (
              <Button variant="ghost" size="sm" onClick={loadNotes}>
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
              <Textarea
                {...p}
                name="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={20000}
              />
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Rotate every" help="Flags it for change when due.">
            {(p) => (
              <Select {...p} name="rotationDays" defaultValue={item?.rotationDays ? String(item.rotationDays) : ''}>
                <option value="">Don&rsquo;t remind me</option>
                {[30, 60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {actor.isAdmin && (
            <div className="pt-6">
              <Checkbox
                name="restricted"
                defaultChecked={item?.restricted}
                label="Restrict to specific people"
                description="Only administrators and the people you list can see it."
              />
            </div>
          )}
        </div>
        <Checkbox
          name="clientVisible"
          defaultChecked={item?.clientVisible}
          label="Share with the client's own accounts"
          description="Client contacts with access to this client can view it (read-only) in their portal. Not used for restricted entries."
        />
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- list
function QuickCopy({ item }: { item: PasswordView }) {
  const reveal = useReveal();
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={`Copy password for ${item.name}`}
      onClick={async () => {
        try {
          const result = await reveal(item, { copy: true });
          if (!result) return;
          await copySecret(result.value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
          toast('Password copied. The clipboard clears in 30 seconds.');
        } catch (e) {
          toast((e as Error).message, 'error');
        }
      }}
    >
      {done ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}

export function PasswordsView({ clientId }: { clientId?: string }) {
  const search = useSearch({ strict: false }) as { archived?: boolean };
  const go = useGo();
  const client = useClient(clientId ?? '');
  const actor = useActor();
  // Client accounts (the portal) see the entries shared with them.
  const canUse = clientId ? client.data?.access === 'edit_passwords' || !actor.isStaff : true;
  const list = usePasswords({ client: clientId, archived: search.archived });
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const rows = useMemo(
    () =>
      (list.data ?? []).filter((p) =>
        `${p.name} ${p.username} ${p.url} ${p.clientName}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [list.data, query],
  );
  if (clientId && client.data && !canUse)
    return (
      <Card>
        <EmptyState
          icon={Lock}
          title="No password access"
          description="Your access to this client doesn't include passwords. Ask an administrator for “Edit + passwords” access."
        />
      </Card>
    );
  const base = clientId ? `/clients/${clientId}/passwords` : '/passwords';
  return (
    <>
      {!clientId && (
        <PageHeader
          eyebrow="Vault"
          title="Passwords"
          description="Credentials for the clients where you have password access. Every view and copy is recorded."
        />
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <label className="relative min-w-48 flex-1">
            <span className="sr-only">Filter passwords</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name, username, or address…"
              className="pl-9"
            />
          </label>
          {actor.isStaff && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go(base, { archived: search.archived ? undefined : true })}
            >
              {search.archived ? <ArchiveRestore /> : <Archive />} {search.archived ? 'Show active' : 'Show archived'}
            </Button>
          )}
          {clientId && actor.isStaff && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add password
            </Button>
          )}
        </div>
        {list.isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-11" />
            ))}
          </div>
        ) : rows.length ? (
          <div className="relative overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Name</th>
                  {!clientId && <th className="hidden px-5 py-3 font-medium md:table-cell">Client</th>}
                  <th className="hidden px-5 py-3 font-medium sm:table-cell">Username</th>
                  <th className="px-5 py-3 font-medium">Health</th>
                  <th className="px-5 py-3">
                    <span className="sr-only">Copy</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-2">
                    <td className="px-5 py-3">
                      <AppLink to={`/passwords/${p.id}`} className="flex items-center gap-3">
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
                          {p.kind === 'bitlocker' ? (
                            <HardDrive className="size-4" aria-hidden />
                          ) : (
                            <KeyRound className="size-4" aria-hidden />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 font-semibold hover:underline">
                            {p.name}
                            {p.restricted && <Lock className="size-3.5 text-muted" aria-label="Restricted" />}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {p.kind === 'bitlocker' ? 'BitLocker recovery key' : p.url || 'Login'}
                          </span>
                        </span>
                      </AppLink>
                    </td>
                    {!clientId && <td className="hidden px-5 py-3 text-text-2 md:table-cell">{p.clientName}</td>}
                    <td className="hidden max-w-48 truncate px-5 py-3 font-mono text-[13px] text-text-2 sm:table-cell">
                      {p.username || <span className="font-sans text-muted">—</span>}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {p.kind === 'login' && (
                          <Badge tone={strengthTone[p.strength]}>{STRENGTH_LABELS[p.strength]}</Badge>
                        )}
                        {p.reused > 0 && <Badge tone="warning">Reused</Badge>}
                        {rotationOverdue(p) && <Badge tone="danger">Rotate</Badge>}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">{!p.archived && <QuickCopy item={p} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={KeyRound}
            title={
              !actor.isStaff
                ? 'Nothing has been shared with you yet'
                : search.archived
                  ? 'No archived passwords'
                  : query
                    ? 'Nothing matches'
                    : 'The vault is empty'
            }
            description={
              !actor.isStaff
                ? 'Passwords your IT team shares with you will appear here.'
                : clientId
                  ? 'Store admin logins, service accounts, Wi-Fi keys, and BitLocker recovery keys here, encrypted.'
                  : 'Open a client to add passwords. Only clients where you have password access are listed.'
            }
            action={
              clientId && !search.archived && actor.isStaff ? (
                <Button onClick={() => setAdding(true)}>
                  <Plus /> Add password
                </Button>
              ) : undefined
            }
          />
        )}
      </Card>
      {adding && clientId && <PasswordDialog clientId={clientId} onClose={() => setAdding(false)} />}
    </>
  );
}
export function ClientPasswords() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  return <PasswordsView clientId={clientId} />;
}
export function AllPasswords() {
  return <PasswordsView />;
}

// ---------------------------------------------------------------- detail
function SecretRow({
  label,
  item,
  field,
  mono = true,
}: {
  label: string;
  item: PasswordView;
  field: 'secret' | 'notes';
  mono?: boolean;
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
      const result = await reveal(item, { field, copy });
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
            field === 'notes' && value && 'font-sans whitespace-pre-wrap',
          )}
          aria-live="polite"
        >
          {value ?? '••••••••••••'}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label={value ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        onClick={() => (value ? setValue(null) : run(false))}
      >
        {value ? <EyeOff /> : <Eye />}
      </Button>
      {field === 'secret' && (
        <Button variant="ghost" size="icon" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => run(true)}>
          <Copy />
        </Button>
      )}
    </div>
  );
}

function TotpRow({ item }: { item: PasswordView }) {
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
      ) : (
        <Button variant="ghost" size="sm" onClick={show}>
          <Eye /> Show code
        </Button>
      )}
    </div>
  );
}

function HistoryCard({ item }: { item: PasswordView }) {
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

function AuditCard({ item }: { item: PasswordView }) {
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

function SharesCard({ item }: { item: PasswordView }) {
  const { data } = useShares(item.id);
  const [sharing, setSharing] = useState(false);
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
          <Button variant="ghost" size="sm" onClick={() => setSharing(true)}>
            <Share2 /> Share
          </Button>
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
      const { value } = await api<{ value: string }>(`/passwords/${item.id}/reveal`, {
        method: 'POST',
        body: { reason: reason || 'Creating a share link' },
      });
      // Encrypted here; the server only ever sees ciphertext. The key goes after # and never reaches the server.
      const { ciphertext, key } = await encryptShare({
        name: item.name,
        username: item.username,
        url: item.url,
        secret: value,
        kind: item.kind,
      });
      const share = await api<{ token: string }>(`/passwords/${item.id}/shares`, {
        method: 'POST',
        body: { ciphertext, maxViews, expiresHours: hours, reason },
      });
      setLink(`${location.origin}/share/${share.token}#${key}`);
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
    <Dialog
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
    </Dialog>
  );
}

function AccessCard({ item }: { item: PasswordView }) {
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
                <legend className="mb-1 text-xs font-bold tracking-wide text-muted uppercase">Groups</legend>
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
              <legend className="mb-1 text-xs font-bold tracking-wide text-muted uppercase">People</legend>
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

export function PasswordDetail() {
  const { passwordId } = useParams({ strict: false }) as { passwordId: string };
  const { data: item, isLoading, error, refetch } = usePassword(passwordId);
  const actor = useActor();
  const toast = useToast();
  const queryClient = useQueryClient();
  const clients = useClients();
  const [editing, setEditing] = useState(false);
  if (isLoading) return <Skeleton className="h-72" />;
  if (error || !item)
    return (
      <Card>
        <EmptyState
          icon={Lock}
          title="Password not found"
          description="It may have been removed, or it's restricted to other people."
        />
      </Card>
    );
  const archive = async () => {
    await api(`/passwords/${item.id}/archive`, { method: 'POST', body: { archived: !item.archived } });
    await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: ['passwords'] })]);
    toast(item.archived ? 'Restored.' : 'Archived. You can restore it from the archived list.');
  };
  const requireReason = clients.data?.find((c) => c.id === item.clientId)?.requireRevealReason;
  return (
    <>
      <AppLink
        to={`/clients/${item.clientId}/passwords`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" /> {item.clientName} · Passwords
      </AppLink>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-warning-soft text-warning">
            {item.kind === 'bitlocker' ? (
              <HardDrive className="size-6" aria-hidden />
            ) : (
              <KeyRound className="size-6" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-xs font-bold tracking-[0.14em] text-muted uppercase">
              {item.kind === 'bitlocker' ? 'BitLocker recovery key' : 'Password'}
            </p>
            <h1 className="flex flex-wrap items-center gap-3 text-[26px] leading-tight font-semibold tracking-tight">
              {item.name}
              {item.restricted && (
                <Badge>
                  <Lock /> Restricted
                </Badge>
              )}
              {actor.isStaff && item.clientVisible && !item.restricted && (
                <Badge tone="info">
                  <Users /> Shared with client
                </Badge>
              )}
              {item.archived && <Badge tone="warning">Archived</Badge>}
            </h1>
            <p className="mt-1 text-sm text-muted">
              Updated {relativeTime(item.updatedAt)}
              {item.updatedByName && ` by ${item.updatedByName}`}
            </p>
          </div>
        </div>
        {actor.isStaff && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={archive}>
              {item.archived ? <ArchiveRestore /> : <Archive />} {item.archived ? 'Restore' : 'Archive'}
            </Button>
            {!item.archived && (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
          </div>
        )}
      </div>
      {actor.isStaff && (item.reused > 0 || rotationOverdue(item) || (item.kind === 'login' && item.strength < 2)) && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            {item.kind === 'login' && item.strength < 2 && <p>This password is weak. Generate a longer one.</p>}
            {item.reused > 0 && (
              <p>
                The same password is used in {item.reused} other place{item.reused === 1 ? '' : 's'}.
              </p>
            )}
            {rotationOverdue(item) && <p>Due for rotation since {formatDate(`${item.rotationDue}T12:00:00`)}.</p>}
          </div>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title="Credentials"
              description={
                requireReason
                  ? 'This client asks for a reason each time a secret is viewed.'
                  : 'Views and copies are recorded in the access history.'
              }
            />
            <div className="divide-y divide-border">
              {item.username && (
                <div className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-muted">
                      {item.kind === 'bitlocker' ? 'Recovery key ID' : 'Username'}
                    </p>
                    <p className="mt-0.5 font-mono text-sm break-all">{item.username}</p>
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
              <SecretRow label={item.kind === 'bitlocker' ? 'Recovery key' : 'Password'} item={item} field="secret" />
              {item.hasTotp && <TotpRow item={item} />}
              {item.url && (
                <div className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-muted">Website or address</p>
                    <p className="mt-0.5 text-sm break-all">{item.url}</p>
                  </div>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="grid size-9 place-items-center rounded-lg text-text-2 hover:bg-surface-3"
                    aria-label="Open website"
                  >
                    <ExternalLink className="size-4" />
                  </a>
                </div>
              )}
              {item.hasNotes && <SecretRow label="Notes" item={item} field="notes" mono={false} />}
            </div>
          </Card>
          {actor.isStaff && (
            <Card>
              <CardHeader title="Health" />
              <dl className="grid gap-4 px-5 py-4 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted">Strength</dt>
                  <dd className="mt-1">
                    {item.kind === 'login' ? (
                      <Badge tone={strengthTone[item.strength]}>{STRENGTH_LABELS[item.strength]}</Badge>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Reuse</dt>
                  <dd className="mt-1">
                    {item.reused ? (
                      <Badge tone="warning">Used {item.reused + 1} times</Badge>
                    ) : (
                      <Badge tone="success">Unique</Badge>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Rotation</dt>
                  <dd className="mt-1">
                    {item.rotationDue ? (
                      <span className={cn(rotationOverdue(item) && 'font-semibold text-danger')}>
                        Due {formatDate(`${item.rotationDue}T12:00:00`)}
                      </span>
                    ) : (
                      <span className="text-muted">No reminder</span>
                    )}
                  </dd>
                </div>
              </dl>
            </Card>
          )}
          {actor.isStaff && <AuditCard item={item} />}
        </div>
        <div className="space-y-6">
          {actor.isStaff && (
            <RelatedPanel type="password" id={item.id} clientId={item.clientId} canEdit={!item.archived} />
          )}
          {actor.isStaff && !item.archived && <SharesCard item={item} />}
          {actor.isStaff && item.kind === 'login' && <HistoryCard item={item} />}
          {actor.isAdmin && item.restricted && <AccessCard item={item} />}
          <div className="flex gap-3 rounded-xl border border-border bg-surface-2 p-4 text-xs text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            Encrypted with this workspace&rsquo;s vault key. Copied passwords clear from the clipboard after 30 seconds.
          </div>
        </div>
      </div>
      {editing && <PasswordDialog clientId={item.clientId} item={item} onClose={() => setEditing(false)} />}
    </>
  );
}
