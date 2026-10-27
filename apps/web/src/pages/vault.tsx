import { useMemo, useState, type FormEvent } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  ExternalLink,
  Folder,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  Search,
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
  type BulkPasswordInput,
  type BulkPasswordResult,
  type PasswordCategory,
  type PasswordFolderView,
  type PasswordView,
} from '@atlas/shared';
import {
  PASSWORD_TYPE_LABELS,
  PasswordIcon,
  hostOf,
  passwordType,
  passwordTypeLabel,
  type PasswordType,
} from '@/lib/password-categories';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
  Drawer,
} from '@/components/ui';
import { AppLink, useGo } from '@/components/AppLink';
import { BackLink, DetailHeader } from '@/components/DetailHeader';
import { RelatedPanel } from '@/components/panels';
import { WifiJoinCard } from '@/components/WifiJoin';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, relativeTime } from '@/lib/format';
import { useListView } from '@/lib/list-views';
import { useActor } from '@/lib/session';
import { useClient } from '@/lib/queries';
import { copySecret, usePassword, usePasswordFolders, usePasswords, useReveal } from '@/lib/vault';
import { rotationOverdue, expired } from '@/components/vault/status';
import { strengthTone } from '@/components/vault/Generator';
import { PasswordDialog } from '@/components/vault/PasswordDialog';
import { useQuickShare } from '@/components/vault/useQuickShare';
import {
  SecretRow,
  TotpRow,
  HistoryCard,
  AuditCard,
  FilesCard,
  SharesCard,
  AccessCard,
} from '@/components/vault/DetailCards';

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
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-warning aria-pressed:text-warning disabled:opacity-60 print:hidden"
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

/**
 * Copy username / password / one-time code, share, and open the sign-in address, without opening the entry. On a
 * phone only the two copies show, so the name keeps its room; the rest are on the password's page.
 */
function QuickActions({ item }: { item: PasswordView }) {
  const reveal = useReveal();
  const actor = useActor();
  const { share: quickShare, dialog: quickShareDialog } = useQuickShare();
  const bitlocker = item.kind === 'bitlocker';
  const openable = item.kind === 'login' && /^https?:\/\//i.test(item.url);
  const secretName = bitlocker ? 'recovery key' : item.kind === 'note' ? 'note' : 'password';
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
      {item.canReveal ? (
        <QuickAction
          label={`Copy ${secretName} for ${item.name}`}
          icon={Copy}
          action={async () => {
            const result = await reveal(item, { copy: true });
            if (!result) return null;
            await copySecret(result.value);
            return `${secretName.replace(/^./, (c) => c.toUpperCase())} copied. The clipboard clears in 30 seconds.`;
          }}
        />
      ) : (
        <Slot />
      )}
      <span className="hidden sm:contents">
        {item.hasTotp && item.canReveal ? (
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
      </span>
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

// ---------- list sorting and grouping (kept per person, with the rest of their workspace) ----------
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
// Before views were kept per person, this browser remembered one; it's used until a view is saved.
const LIST_VIEW_KEY = 'atlas-password-list';
function legacyListView(): ListView {
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
const typeLabel = passwordTypeLabel;
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
  const [type, setType] = useState<PasswordType | ''>('');
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
  const [saved, saveView] = useListView('passwords');
  const [legacy] = useState(legacyListView);
  const view: ListView = {
    sort: saved.sort && saved.sort in SORT_LABELS ? (saved.sort as ListSort) : legacy.sort,
    group: saved.group === 'none' || saved.group === 'client' || saved.group === 'type' ? saved.group : legacy.group,
  };
  const changeView = (next: Partial<ListView>) => saveView({ ...view, ...next });
  // Grouping by client makes no sense inside one client.
  const groupBy = clientId && view.group === 'client' ? 'none' : view.group;
  // Only offer the types that are actually in the list.
  const types = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of list.data ?? []) counts.set(passwordType(p), (counts.get(passwordType(p)) ?? 0) + 1);
    return counts;
  }, [list.data]);
  const rows = useMemo(
    () =>
      (list.data ?? []).filter(
        (p) =>
          (show !== 'favorites' || p.favorite) &&
          (show !== 'recent' || p.lastUsedAt) &&
          (!type || passwordType(p) === type) &&
          (!folder || (folder === 'none' ? !p.folderId : p.folderId === folder)) &&
          [p.name, p.username, p.url, p.clientName, typeLabel(p), ...p.linkedAssets.map((a) => a.name)]
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
                {[...PASSWORD_CATEGORIES, 'bitlocker' as const, 'note' as const]
                  .filter((c) => types.has(c))
                  .map((c) => (
                    <option key={c} value={c}>
                      {PASSWORD_TYPE_LABELS[c]} ({types.get(c)})
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
                              title={typeLabel(p)}
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
                                  typeLabel(p),
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
                            <Badge tone={p.strength >= 3 ? 'quiet' : strengthTone[p.strength]}>
                              {STRENGTH_LABELS[p.strength]}
                            </Badge>
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
    <Drawer
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
    </Drawer>
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

export function PasswordDetail() {
  const { passwordId } = useParams({ strict: false }) as { passwordId: string };
  const { data: item, isLoading, error, refetch } = usePassword(passwordId);
  const actor = useActor();
  const toast = useToast();
  const queryClient = useQueryClient();
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
  return (
    <>
      <BackLink to={`/clients/${item.clientId}/passwords`}>{item.clientName} · Passwords</BackLink>
      <DetailHeader
        kind={item.kind === 'bitlocker' ? 'BitLocker recovery key' : item.kind === 'note' ? 'Secure note' : 'Password'}
        title={item.name}
        star={actor.isStaff && <FavoriteButton item={item} />}
        status={
          (item.restricted || (actor.isStaff && item.clientVisible) || item.archived) && (
            <>
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
            </>
          )
        }
        meta={
          <>
            Updated {relativeTime(item.updatedAt)}
            {item.updatedByName && ` by ${item.updatedByName}`}
          </>
        }
        actions={
          actor.isStaff && (
            <>
              <Button variant="secondary" onClick={archive}>
                {item.archived ? <ArchiveRestore /> : <Archive />} {item.archived ? 'Restore' : 'Archive'}
              </Button>
              {!item.archived && (
                <Button onClick={() => setEditing(true)}>
                  <Pencil /> Edit
                </Button>
              )}
            </>
          )
        }
      />
      {actor.isStaff &&
        (item.reused > 0 || rotationOverdue(item) || expired(item) || (item.kind === 'login' && item.strength < 2)) && (
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
              {expired(item) && <p>This account expired on {formatDate(`${item.expiresOn}T12:00:00`)}.</p>}
            </div>
          </div>
        )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={item.kind === 'note' ? 'Note' : 'Credentials'}
              description={
                !item.canReveal
                  ? 'Your organization doesn’t let read-only accounts reveal passwords.'
                  : item.requireReason
                    ? 'A reason is asked for each time a secret is viewed.'
                    : 'Views and copies are recorded in the access history.'
              }
            />
            <div className="divide-y divide-border">
              {item.username && (
                <div className="flex items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-muted">
                      {item.kind === 'bitlocker'
                        ? 'Recovery key ID'
                        : item.category === 'wifi'
                          ? 'Network name'
                          : 'Username'}
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
              {item.kind === 'note' ? (
                <SecretRow label="Note" item={item} field="secret" mono={false} multiline />
              ) : (
                <SecretRow label={item.kind === 'bitlocker' ? 'Recovery key' : 'Password'} item={item} field="secret" />
              )}
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
              {item.customFields.map((f) =>
                f.secret ? (
                  <SecretRow key={f.id} label={f.label} item={item} field="custom" fieldId={f.id} />
                ) : (
                  <div key={f.id} className="flex items-center gap-3 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-muted">{f.label}</p>
                      <p className="mt-0.5 text-sm break-all whitespace-pre-wrap">{f.value}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Copy ${f.label}`}
                      onClick={() =>
                        navigator.clipboard.writeText(f.value ?? '').then(() => toast(`${f.label} copied.`))
                      }
                    >
                      <Copy />
                    </Button>
                  </div>
                ),
              )}
              {item.hasNotes && <SecretRow label="Notes" item={item} field="notes" mono={false} />}
            </div>
          </Card>
          {item.kind === 'login' && item.category === 'wifi' && !item.archived && <WifiJoinCard item={item} />}
          {actor.isStaff && item.kind !== 'note' && (
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
                <div>
                  <dt className="text-xs text-muted">Account expires</dt>
                  <dd className="mt-1">
                    {item.expiresOn ? (
                      <span className={cn(expired(item) && 'font-semibold text-danger')}>
                        {formatDate(`${item.expiresOn}T12:00:00`)}
                      </span>
                    ) : (
                      <span className="text-muted">Never</span>
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
          {actor.isStaff && <FilesCard item={item} />}
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
