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
  Folder,
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
  X,
  Share2,
  ShieldCheck,
  Star,
  Timer,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import {
  PASSWORD_CATEGORIES,
  PASSWORD_CATEGORY_LABELS,
  STRENGTH_LABELS,
  passwordStrength,
  type BulkPasswordInput,
  type BulkPasswordResult,
  type PasswordCategory,
  type PasswordFolderView,
  type PasswordKind,
  type PasswordView,
  type RelationView,
  type UserView,
} from '@atlas/shared';
import { PasswordIcon, hostOf } from '@/lib/password-categories';
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
import { useAssets, useClient, useClients, useUsers, useGroups } from '@/lib/queries';
import {
  DEFAULT_GENERATOR,
  copySecret,
  createShareLink,
  generatePassword,
  useAskReason,
  usePassword,
  usePasswordAudit,
  usePasswordFolders,
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
/** Adds and removes asset links so they match `next`; returns a message if any link couldn't be changed. */
async function syncAssetLinks(passwordId: string, before: string[], next: string[]): Promise<string | null> {
  const add = next.filter((id) => !before.includes(id));
  const remove = before.filter((id) => !next.includes(id));
  if (!add.length && !remove.length) return null;
  const base = `/items/password/${passwordId}/relations`;
  const failed: string[] = [];
  for (const id of add)
    await api(base, { method: 'POST', body: { type: 'asset', id } }).catch((e: Error) => failed.push(e.message));
  if (remove.length) {
    const links = await api<RelationView[]>(base);
    for (const link of links.filter((l) => l.type === 'asset' && remove.includes(l.id)))
      await api(`${base}/${link.relationId}`, { method: 'DELETE' }).catch((e: Error) => failed.push(e.message));
  }
  return failed.length ? `Saved, but some asset links didn't change: ${[...new Set(failed)].join(' ')}` : null;
}

/** Pick the client's assets this password belongs to (a firewall, a server, a tenant…). */
function AssetLinksField({
  clientId,
  value,
  onChange,
}: {
  clientId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const assets = useAssets({ client: clientId });
  const [query, setQuery] = useState('');
  const all = assets.data ?? [];
  const chosen = value.map((id) => all.find((a) => a.id === id) ?? { id, name: 'Asset', layoutName: '' });
  const q = query.trim().toLowerCase();
  const matches = q
    ? all.filter((a) => !value.includes(a.id) && `${a.name} ${a.layoutName}`.toLowerCase().includes(q)).slice(0, 8)
    : [];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Linked assets</legend>
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Linked assets">
          {chosen.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-1 rounded-full bg-surface-3 py-0.5 pr-1 pl-2.5 text-xs font-medium"
            >
              {a.name}
              <button
                type="button"
                className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-text"
                aria-label={`Unlink ${a.name}`}
                onClick={() => onChange(value.filter((id) => id !== a.id))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="relative block">
        <span className="sr-only">Find an asset to link</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={all.length ? 'Find an asset to link…' : 'This client has no assets yet'}
          disabled={!all.length}
          className="pl-9"
          autoComplete="off"
        />
      </label>
      {q && (
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-border" aria-label="Matching assets">
          {matches.length ? (
            matches.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2"
                  onClick={() => {
                    onChange([...value, a.id]);
                    setQuery('');
                  }}
                >
                  <span className="truncate font-medium">{a.name}</span>
                  <span className="shrink-0 text-xs text-muted">{a.layoutName}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-sm text-muted">No matching assets.</li>
          )}
        </ul>
      )}
    </fieldset>
  );
}

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
  const folders = usePasswordFolders(clientId).data ?? [];
  const [folderId, setFolderId] = useState(item?.folderId ?? '');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(!item);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [assetIds, setAssetIds] = useState<string[]>(item?.linkedAssets.map((a) => a.id) ?? []);
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
      ...(kind === 'login' ? { category: text('category') || null } : {}),
      folderId: text('folderId') || null,
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
      const linkFailed = await syncAssetLinks(saved.id, item?.linkedAssets.map((a) => a.id) ?? [], assetIds);
      if (linkFailed) toast(linkFailed, 'error');
      queryClient.setQueryData(['password', saved.id], saved);
      await Promise.all(
        [
          'passwords',
          'password',
          'password-history',
          'password-audit',
          'password-folders',
          'activity',
          'relations',
        ].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
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
        {kind === 'login' && (
          <Field
            label="Type"
            help="What this login is for. Left on automatic, Atlas guesses from the name, username, and address."
            error={error?.fields?.category}
          >
            {(p) => (
              <Select {...p} name="category" defaultValue={item && !item.categoryGuessed ? item.category : ''}>
                <option value="">
                  Automatic
                  {item?.categoryGuessed ? ` (${PASSWORD_CATEGORY_LABELS[item.category]})` : ''}
                </option>
                {PASSWORD_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {PASSWORD_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field
          label="Folder"
          help={
            folders.length ? undefined : 'This client has no folders yet. Add them with Folders in the password list.'
          }
          error={error?.fields?.folderId}
        >
          {(p) => (
            // Controlled, and the current folder is always an option, so a slow folder list can't unfile it.
            <Select {...p} name="folderId" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">No folder</option>
              {item?.folderId && !folders.some((f) => f.id === item.folderId) && (
                <option value={item.folderId}>{item.folderName}</option>
              )}
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
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
        <AssetLinksField clientId={item?.clientId ?? clientId} value={assetIds} onChange={setAssetIds} />
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
/** A personal star: pins the password to your Favorites (nobody else sees it). */
export function FavoriteButton({ item }: { item: PasswordView }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      const saved = await api<PasswordView>(`/passwords/${item.id}/favorite`, {
        method: item.favorite ? 'DELETE' : 'PUT',
        ...(item.favorite ? {} : { body: {} }),
      });
      queryClient.setQueryData(['password', item.id], saved);
      await queryClient.invalidateQueries({ queryKey: ['passwords'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const label = item.favorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`;
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={item.favorite}
      aria-label={label}
      title={item.favorite ? 'Favorite' : 'Add to favorites'}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-warning aria-pressed:text-warning disabled:opacity-60"
    >
      <Star className={cn('size-4', item.favorite && 'fill-current')} aria-hidden />
    </button>
  );
}

/** One icon button that runs `action` and briefly shows a check mark when it succeeds. */
function QuickAction({
  label,
  icon: Icon,
  action,
}: {
  label: string;
  icon: typeof Copy;
  action: () => Promise<string | null>;
}) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          const message = await action();
          if (message === null) return;
          setDone(true);
          setTimeout(() => setDone(false), 1500);
          toast(message);
        } catch (e) {
          toast(
            (e as Error).name === 'NotAllowedError'
              ? 'The browser blocked copying. Click the page and try again, or allow clipboard access for this site.'
              : (e as Error).message,
            'error',
          );
        }
      }}
    >
      {done ? <Check className="text-success" /> : <Icon />}
    </Button>
  );
}

// Keeps each action in the same column on every row, even when a row doesn't have it.
const Slot = () => <span className="inline-block size-9" aria-hidden />;

/** Copy username / password / one-time code, and open the sign-in address, without opening the entry. */
/**
 * Quick share: one click makes a one-time link (one view, 24 hours) and copies it, for sending to someone who
 * doesn't sign in to Atlas. The full Share dialog on the password page offers other limits.
 */
function useQuickShare() {
  const ask = useAskReason();
  const queryClient = useQueryClient();
  // Shown when the browser won't let us copy: the link's key exists nowhere else, so it must not be lost.
  const [manual, setManual] = useState<string | null>(null);
  const share = async (item: PasswordView): Promise<string | null> => {
    let reason = '';
    if (item.requireReason) {
      const given = await ask('Why are you sharing this password?');
      if (given === null) return null;
      reason = given;
    }
    const link = await createShareLink(item, { maxViews: 1, hours: 24, reason });
    await Promise.all(
      ['password-shares', 'password-audit'].map((k) => queryClient.invalidateQueries({ queryKey: [k, item.id] })),
    );
    try {
      // The link is the secret now; copy it as-is (not auto-cleared) so it can be pasted into an email or ticket.
      await navigator.clipboard.writeText(link);
    } catch {
      setManual(link);
      return null;
    }
    return 'One-time link copied. It opens once and expires in 24 hours.';
  };
  const dialog = manual && (
    <Dialog
      open
      onClose={() => setManual(null)}
      title="Copy the one-time link"
      description="Your browser didn't allow copying automatically. Copy this link now: it can't be shown again. It opens once and expires in 24 hours."
      footer={<Button onClick={() => setManual(null)}>Done</Button>}
    >
      <Field label="Share link">
        {(p) => <Input {...p} readOnly value={manual} onFocus={(e) => e.currentTarget.select()} autoFocus />}
      </Field>
    </Dialog>
  );
  return { share, dialog };
}

function QuickActions({ item }: { item: PasswordView }) {
  const reveal = useReveal();
  const actor = useActor();
  const { share: quickShare, dialog: quickShareDialog } = useQuickShare();
  const bitlocker = item.kind === 'bitlocker';
  const openable = !bitlocker && /^https?:\/\//i.test(item.url);
  return (
    <div className="flex items-center justify-end">
      {quickShareDialog}
      {item.username ? (
        <QuickAction
          label={`Copy ${bitlocker ? 'recovery key ID' : 'username'} for ${item.name}`}
          icon={UserRound}
          action={async () => {
            // Usernames aren't secret: copied as-is, not cleared, not audited.
            await navigator.clipboard.writeText(item.username);
            return `${bitlocker ? 'Recovery key ID' : 'Username'} copied.`;
          }}
        />
      ) : (
        <Slot />
      )}
      <QuickAction
        label={`Copy ${bitlocker ? 'recovery key' : 'password'} for ${item.name}`}
        icon={Copy}
        action={async () => {
          const result = await reveal(item, { copy: true });
          if (!result) return null;
          await copySecret(result.value);
          return `${bitlocker ? 'Recovery key' : 'Password'} copied. The clipboard clears in 30 seconds.`;
        }}
      />
      {item.hasTotp ? (
        <QuickAction
          label={`Copy one-time code for ${item.name}`}
          icon={Timer}
          action={async () => {
            const result = await reveal(item, { field: 'totp', copy: true }, 'Why do you need this one-time code?');
            if (!result) return null;
            await copySecret(result.value);
            return `One-time code copied. It's valid for ${result.expiresIn ?? 30} more seconds.`;
          }}
        />
      ) : (
        <Slot />
      )}
      {actor.isStaff ? (
        <QuickAction
          label={`Quick share ${item.name}: copy a one-time link`}
          icon={Share2}
          action={() => quickShare(item)}
        />
      ) : (
        <Slot />
      )}
      {openable ? (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${hostOf(item.url)} in a new tab`}
          title={`Open ${hostOf(item.url)}`}
          className="inline-grid size-9 place-items-center rounded-lg text-text-2 hover:bg-surface-3 hover:text-text [&_svg]:size-4"
        >
          <ExternalLink />
        </a>
      ) : (
        <Slot />
      )}
    </div>
  );
}

const ROTATION_CHOICES = [30, 60, 90, 180, 365];
type BulkChange = BulkPasswordInput extends infer T ? (T extends unknown ? Omit<T, 'ids'> : never) : never;

/** Actions for the selected rows. Each password is checked on the server; any it skips are listed. */
function BulkBar({
  items,
  archivedView,
  onDone,
}: {
  items: PasswordView[];
  archivedView: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (change: BulkChange, verb: string) => {
    setBusy(true);
    try {
      const res = await api<BulkPasswordResult>('/passwords/bulk', {
        method: 'POST',
        body: { ...change, ids: items.map((p) => p.id) },
      });
      await queryClient.invalidateQueries({ queryKey: ['passwords'] });
      await queryClient.invalidateQueries({ queryKey: ['password'] });
      const noun = (k: number) => (k === 1 ? '1 password' : `${k} passwords`);
      if (res.failed.length)
        toast(
          `${verb} ${noun(res.updated)}. Skipped ${noun(res.failed.length)}: ${res.failed
            .map((f) => `${f.name ?? 'unavailable'} (${f.error})`)
            .join('; ')}`,
          'error',
        );
      else toast(`${verb} ${noun(res.updated)}.`);
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const logins = items.filter((p) => p.kind === 'login').length;
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-2 border-b border-border bg-primary-soft px-4 py-2.5 text-sm"
    >
      <span className="mr-auto font-medium">{items.length} selected</span>
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onClick={() =>
          void run({ action: archivedView ? 'restore' : 'archive' }, archivedView ? 'Restored' : 'Archived')
        }
      >
        {archivedView ? <ArchiveRestore /> : <Archive />} {archivedView ? 'Restore' : 'Archive'}
      </Button>
      <label>
        <span className="sr-only">Change rotation</span>
        <Select
          value=""
          disabled={busy}
          className="h-8 w-auto"
          onChange={(e) =>
            void run(
              { action: 'rotation', rotationDays: e.target.value === 'off' ? null : Number(e.target.value) },
              'Updated rotation for',
            )
          }
        >
          <option value="" disabled>
            Rotation…
          </option>
          {ROTATION_CHOICES.map((d) => (
            <option key={d} value={d}>
              Every {d} days
            </option>
          ))}
          <option value="off">No rotation</option>
        </Select>
      </label>
      <label>
        <span className="sr-only">Change client portal sharing</span>
        <Select
          value=""
          disabled={busy}
          className="h-8 w-auto"
          onChange={(e) =>
            void run(
              { action: 'clientVisible', clientVisible: e.target.value === 'share' },
              e.target.value === 'share' ? 'Shared' : 'Stopped sharing',
            )
          }
        >
          <option value="" disabled>
            Client portal…
          </option>
          <option value="share">Share with client</option>
          <option value="hide">Stop sharing</option>
        </Select>
      </label>
      {logins > 0 && (
        <label>
          <span className="sr-only">Change type</span>
          <Select
            value=""
            disabled={busy}
            className="h-8 w-auto"
            onChange={(e) =>
              void run({ action: 'category', category: e.target.value as PasswordCategory }, 'Changed the type of')
            }
          >
            <option value="" disabled>
              Type…
            </option>
            {PASSWORD_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PASSWORD_CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </label>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onDone}>
        Clear
      </Button>
    </div>
  );
}

// ---------- list sorting and grouping (remembered per browser) ----------
type ListSort = 'name' | 'client' | 'type' | 'recent' | 'attention';
type ListGroup = 'none' | 'client' | 'type';
type ListView = { sort: ListSort; group: ListGroup };
const SORT_LABELS: Record<ListSort, string> = {
  name: 'Name',
  client: 'Client',
  type: 'Type',
  recent: 'Recently changed',
  attention: 'Needs attention first',
};
const LIST_VIEW_KEY = 'atlas-password-list';
function loadListView(): ListView {
  try {
    const saved = JSON.parse(localStorage.getItem(LIST_VIEW_KEY) ?? '{}') as Partial<ListView>;
    return {
      sort: saved.sort && saved.sort in SORT_LABELS ? saved.sort : 'name',
      group: saved.group === 'client' || saved.group === 'type' ? saved.group : 'none',
    };
  } catch {
    return { sort: 'name', group: 'none' };
  }
}
function saveListView(view: ListView) {
  try {
    localStorage.setItem(LIST_VIEW_KEY, JSON.stringify(view));
  } catch {
    /* Storage can be blocked; the choice still applies until the page reloads. */
  }
}
const typeLabel = (p: PasswordView) =>
  p.kind === 'bitlocker' ? 'BitLocker recovery key' : PASSWORD_CATEGORY_LABELS[p.category];
/** Higher is worse: rotation overdue, then reused, then weak. */
const attention = (p: PasswordView) =>
  (rotationOverdue(p) ? 4 : 0) + (p.reused > 0 ? 2 : 0) + (p.kind === 'login' && p.strength < 2 ? 1 : 0);
const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
function sortPasswords(items: PasswordView[], sort: ListSort) {
  const name = (a: PasswordView, b: PasswordView) => byText(a.name, b.name);
  const compare: Record<ListSort, (a: PasswordView, b: PasswordView) => number> = {
    name,
    client: (a, b) => byText(a.clientName, b.clientName) || name(a, b),
    type: (a, b) => byText(typeLabel(a), typeLabel(b)) || name(a, b),
    recent: (a, b) => b.updatedAt.localeCompare(a.updatedAt) || name(a, b),
    attention: (a, b) => attention(b) - attention(a) || name(a, b),
  };
  return [...items].sort(compare[sort]);
}
/** Keeps the sort order inside each group; groups themselves are alphabetical. */
function groupPasswords(items: PasswordView[], group: ListGroup) {
  if (group === 'none') return [{ key: 'all', label: null as string | null, items }];
  const map = new Map<string, PasswordView[]>();
  for (const p of items) {
    const label = group === 'client' ? p.clientName : typeLabel(p);
    map.set(label, [...(map.get(label) ?? []), p]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => byText(a, b))
    .map(([label, groupItems]) => ({ key: label, label: label as string | null, items: groupItems }));
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
  const [type, setType] = useState<PasswordCategory | 'bitlocker' | ''>('');
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<'all' | 'favorites' | 'recent'>('all');
  // Folders belong to one client, so they're offered inside a client (to staff with password access).
  const folderQuery = usePasswordFolders(clientId && actor.isStaff ? clientId : undefined);
  const folders = folderQuery.data ?? [];
  const [chosenFolder, setFolder] = useState(''); // '' all, 'none' unfiled, or a folder id
  // A folder deleted while it's the filter drops back to all, so the list never looks empty for no reason.
  const folder =
    chosenFolder && chosenFolder !== 'none' && folderQuery.isSuccess && !folders.some((f) => f.id === chosenFolder)
      ? ''
      : chosenFolder;
  const [managingFolders, setManagingFolders] = useState(false);
  const [view, setView] = useState<ListView>(loadListView);
  const changeView = (next: Partial<ListView>) => {
    const merged = { ...view, ...next };
    setView(merged);
    saveListView(merged);
  };
  // Grouping by client makes no sense inside one client.
  const groupBy = clientId && view.group === 'client' ? 'none' : view.group;
  const typeOf = (p: PasswordView) => (p.kind === 'bitlocker' ? 'bitlocker' : p.category);
  // Only offer the types that are actually in the list.
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of list.data ?? []) counts.set(typeOf(p), (counts.get(typeOf(p)) ?? 0) + 1);
    return counts;
  }, [list.data]);
  const rows = useMemo(
    () =>
      (list.data ?? []).filter(
        (p) =>
          (show !== 'favorites' || p.favorite) &&
          (show !== 'recent' || p.lastUsedAt) &&
          (!type || typeOf(p) === type) &&
          (!folder || (folder === 'none' ? !p.folderId : p.folderId === folder)) &&
          [
            p.name,
            p.username,
            p.url,
            p.clientName,
            PASSWORD_CATEGORY_LABELS[p.category],
            ...p.linkedAssets.map((a) => a.name),
          ]
            .join(' ')
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [list.data, query, type, folder, show],
  );
  // Recently used: most recent first, up to 25, whatever the chosen sort.
  const groups = useMemo(
    () =>
      groupPasswords(
        show === 'recent'
          ? [...rows].sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!)).slice(0, 25)
          : sortPasswords(rows, view.sort),
        groupBy,
      ),
    [rows, view.sort, groupBy, show],
  );
  // Only what's on screen can be selected, so a filter change quietly narrows the selection.
  const chosen = rows.filter((p) => selected.has(p.id));
  const allChosen = rows.length > 0 && chosen.length === rows.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
              placeholder="Filter by name, username, address, or asset…"
              className="pl-9"
            />
          </label>
          {actor.isStaff && (
            <label className="w-full sm:w-auto">
              <span className="sr-only">Show</span>
              <Select value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
                <option value="all">All passwords</option>
                <option value="favorites">Favorites</option>
                <option value="recent">Recently used by me</option>
              </Select>
            </label>
          )}
          {types.size > 1 && (
            <label className="w-full sm:w-auto">
              <span className="sr-only">Type</span>
              <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
                <option value="">All types</option>
                {[...PASSWORD_CATEGORIES, 'bitlocker' as const]
                  .filter((c) => types.has(c))
                  .map((c) => (
                    <option key={c} value={c}>
                      {c === 'bitlocker' ? 'BitLocker recovery key' : PASSWORD_CATEGORY_LABELS[c]} ({types.get(c)})
                    </option>
                  ))}
              </Select>
            </label>
          )}
          {folders.length > 0 && (
            <label className="w-full sm:w-auto">
              <span className="sr-only">Folder</span>
              <Select value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="">All folders</option>
                <option value="none">No folder</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.count})
                  </option>
                ))}
              </Select>
            </label>
          )}
          {clientId && canUse && actor.isStaff && (
            <Button variant="ghost" size="sm" onClick={() => setManagingFolders(true)}>
              <Folder /> Folders
            </Button>
          )}
          <label className="w-full sm:w-auto">
            <span className="sr-only">Sort</span>
            <Select value={view.sort} onChange={(e) => changeView({ sort: e.target.value as ListSort })}>
              {Object.entries(SORT_LABELS)
                .filter(([k]) => !(clientId && k === 'client'))
                .map(([k, label]) => (
                  <option key={k} value={k}>
                    Sort: {label}
                  </option>
                ))}
            </Select>
          </label>
          <label className="w-full sm:w-auto">
            <span className="sr-only">Group by</span>
            <Select value={groupBy} onChange={(e) => changeView({ group: e.target.value as ListGroup })}>
              <option value="none">No grouping</option>
              {!clientId && <option value="client">Group by client</option>}
              <option value="type">Group by type</option>
            </Select>
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
        {actor.isStaff && chosen.length > 0 && (
          <BulkBar items={chosen} archivedView={!!search.archived} onDone={() => setSelected(new Set())} />
        )}
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
                  {actor.isStaff && (
                    <th className="w-0 py-3 pl-4">
                      <input
                        type="checkbox"
                        className="size-4 rounded accent-(--primary)"
                        aria-label="Select all shown passwords"
                        checked={allChosen}
                        ref={(el) => {
                          if (el) el.indeterminate = chosen.length > 0 && !allChosen;
                        }}
                        onChange={() => setSelected(allChosen ? new Set() : new Set(rows.map((p) => p.id)))}
                      />
                    </th>
                  )}
                  <th className="px-5 py-3 font-medium">Name</th>
                  {!clientId && <th className="hidden px-5 py-3 font-medium md:table-cell">Client</th>}
                  <th className="hidden px-5 py-3 font-medium sm:table-cell">Username</th>
                  {/* On phones, health gives way so the quick actions fit without scrolling sideways. */}
                  <th className="hidden px-5 py-3 font-medium sm:table-cell">Health</th>
                  <th className="px-3 py-3 text-right font-medium">Quick actions</th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.key} className="divide-y divide-border border-b border-border last:border-b-0">
                  {g.label !== null && (
                    <tr className="bg-surface-2/60">
                      <th colSpan={6} scope="rowgroup" className="px-5 py-2 text-xs font-semibold text-text-2">
                        {g.label} <span className="font-normal text-muted">({g.items.length})</span>
                      </th>
                    </tr>
                  )}
                  {g.items.map((p) => (
                    <tr key={p.id} className={cn('hover:bg-surface-2', selected.has(p.id) && 'bg-surface-2')}>
                      {actor.isStaff && (
                        <td className="w-0 py-3 pl-4">
                          <input
                            type="checkbox"
                            className="size-4 rounded accent-(--primary)"
                            aria-label={`Select ${p.name}`}
                            checked={selected.has(p.id)}
                            onChange={() => toggle(p.id)}
                          />
                        </td>
                      )}
                      {/* On phones the name takes whatever width the actions leave, and truncates. */}
                      <td className="w-full max-w-0 py-3 pr-2 pl-2 sm:w-auto sm:max-w-none sm:pr-5 sm:pl-3">
                        <div className="flex items-center gap-1">
                          {actor.isStaff && <FavoriteButton item={p} />}
                          <AppLink to={`/passwords/${p.id}`} className="flex min-w-0 items-center gap-3">
                            <span
                              className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning"
                              title={
                                p.kind === 'bitlocker' ? 'BitLocker recovery key' : PASSWORD_CATEGORY_LABELS[p.category]
                              }
                            >
                              <PasswordIcon item={p} className="size-4" />
                            </span>
                            <span className="min-w-0">
                              <span className="flex items-center gap-1.5 font-semibold hover:underline">
                                <span className="truncate">{p.name}</span>
                                {p.restricted && <Lock className="size-3.5 text-muted" aria-label="Restricted" />}
                              </span>
                              {/* What tells similar logins apart: its type, where it signs in, and what it's for. */}
                              <span className="block truncate text-xs text-muted">
                                {[
                                  p.folderName ? `${p.folderName} folder` : '',
                                  p.kind === 'bitlocker'
                                    ? 'BitLocker recovery key'
                                    : PASSWORD_CATEGORY_LABELS[p.category],
                                  p.kind === 'login' && p.url ? hostOf(p.url) : '',
                                  p.linkedAssets.length
                                    ? `on ${p.linkedAssets
                                        .slice(0, 2)
                                        .map((a) => a.name)
                                        .join(
                                          ', ',
                                        )}${p.linkedAssets.length > 2 ? ` +${p.linkedAssets.length - 2}` : ''}`
                                    : '',
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            </span>
                          </AppLink>
                        </div>
                      </td>
                      {!clientId && <td className="hidden px-5 py-3 text-text-2 md:table-cell">{p.clientName}</td>}
                      <td className="hidden max-w-48 truncate px-5 py-3 font-mono text-[13px] text-text-2 sm:table-cell">
                        {p.username || <span className="font-sans text-muted">—</span>}
                      </td>
                      <td className="hidden px-5 py-3 sm:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {p.kind === 'login' && (
                            <Badge tone={strengthTone[p.strength]}>{STRENGTH_LABELS[p.strength]}</Badge>
                          )}
                          {p.reused > 0 && <Badge tone="warning">Reused</Badge>}
                          {rotationOverdue(p) && <Badge tone="danger">Rotate</Badge>}
                        </div>
                      </td>
                      <td className="px-3 py-1.5">{!p.archived && <QuickActions item={p} />}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
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
      {managingFolders && clientId && (
        <FoldersDialog clientId={clientId} folders={folders} onClose={() => setManagingFolders(false)} />
      )}
    </>
  );
}
/** Create, rename, and delete one client's password folders. Deleting a folder unfiles its passwords. */
function FoldersDialog({
  clientId,
  folders,
  onClose,
}: {
  clientId: string;
  folders: PasswordFolderView[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all(['password-folders', 'passwords'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      toast(done);
      return true;
    } catch (e) {
      setError((e as ApiError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    if (
      await run(
        () => api(`/clients/${clientId}/password-folders`, { method: 'POST', body: { name: value } }),
        `${value} added.`,
      )
    )
      setName('');
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Folders"
      description="Folders organize this client's passwords. Deleting one keeps its passwords; they just have no folder."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <form onSubmit={add} className="mb-4 flex gap-2">
        <label className="flex-1">
          <span className="sr-only">New folder name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="New folder name" />
        </label>
        <Button type="submit" loading={busy && !editing} disabled={!name.trim()}>
          <Plus /> Add
        </Button>
      </form>
      {folders.length ? (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {folders.map((f) => (
            <li key={f.id} className="flex items-center gap-2 px-3 py-2">
              <Folder className="size-4 shrink-0 text-muted" aria-hidden />
              {editing?.id === f.id ? (
                <form
                  className="flex flex-1 gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (
                      await run(
                        () => api(`/password-folders/${f.id}`, { method: 'PATCH', body: { name: editing.name } }),
                        'Folder renamed.',
                      )
                    )
                      setEditing(null);
                  }}
                >
                  <label className="flex-1">
                    <span className="sr-only">Folder name</span>
                    <Input
                      autoFocus
                      value={editing.name}
                      maxLength={80}
                      onChange={(e) => setEditing({ id: f.id, name: e.target.value })}
                    />
                  </label>
                  <Button type="submit" size="sm" loading={busy}>
                    Save
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {f.name} <span className="text-muted">({f.count})</span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Rename ${f.name}`}
                    title="Rename"
                    onClick={() => setEditing({ id: f.id, name: f.name })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${f.name}`}
                    title="Delete"
                    onClick={() =>
                      confirm(`Delete the folder ${f.name}? Its ${f.count} password(s) stay, without a folder.`) &&
                      void run(() => api(`/password-folders/${f.id}`, { method: 'DELETE' }), `${f.name} deleted.`)
                    }
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No folders yet.</p>
      )}
      <FormError message={error} />
    </Dialog>
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
              {actor.isStaff && <FavoriteButton item={item} />}
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
