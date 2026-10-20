import { AppLink } from '@/components/AppLink';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, FileText, Pencil, Settings2, StickyNote, Trash2 } from 'lucide-react';
import {
  CLIENT_SECTIONS,
  LEVEL_INFO,
  atLeast,
  type ClientCounts,
  type ClientSection,
  type WorkspacePrefs,
} from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  Skeleton,
  useToast,
} from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useClient, useClientCounts, useWorkspacePrefs } from '@/lib/queries';
import { useActor } from '@/lib/session';
import { ExportButton } from '@/components/ExportButton';
import { FavoriteStar } from '@/components/Favorites';
import { QuickNote } from '@/components/QuickNote';
import { TRACKER, useTrackers } from '@/components/Trackers';
import { ClientForm, statusTone } from '../Clients';

const SECTION_LABELS: Record<ClientSection, string> = {
  assets: 'Assets',
  documents: 'Documents',
  passwords: 'Passwords',
  contacts: 'Contacts',
  locations: 'Locations',
  checklists: 'Checklists',
  licenses: 'Licenses',
  reports: 'Reports',
  map: 'Map',
  activity: 'Activity',
};

// The sections a technician opens most stay in the bar; the rest, and the trackers, are under More.
const PRIMARY_SECTIONS = new Set<ClientSection | ''>(['', 'assets', 'documents', 'passwords', 'contacts', 'locations']);
const TAB =
  '-mb-px flex items-baseline gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium whitespace-nowrap text-muted hover:text-text data-[status=active]:border-primary data-[status=active]:text-text';
const MENU_ITEM =
  'flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-3 data-[status=active]:font-semibold data-[status=active]:text-primary';

export function ClientLayout() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const { data: client, isLoading, error } = useClient(clientId);
  const [editing, setEditing] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const actor = useActor();
  const counts = useClientCounts(clientId).data;
  const prefs = useWorkspacePrefs().data;
  const trackers = useTrackers(clientId).data;
  const pathname = useLocation({ select: (l) => l.pathname });
  if (isLoading) return <Skeleton className="h-40" />;
  if (error || !client)
    return (
      <Card>
        <EmptyState
          icon={StickyNote}
          title="Client not found"
          description="It may have been removed, or you don't have access to it."
          action={
            <AppLink to="/clients" className="font-semibold text-primary hover:underline">
              Back to clients
            </AppLink>
          }
        />
      </Card>
    );
  const base = `/clients/${clientId}`;
  const visible = (['', ...CLIENT_SECTIONS] as const)
    .filter((s) => s === '' || !prefs?.hiddenSections.includes(s))
    .filter((s) => s !== 'passwords' || client.access === 'edit_passwords' || !actor.isStaff);
  const primary = visible.filter((s) => PRIMARY_SECTIONS.has(s));
  const more = visible.filter((s): s is ClientSection => !PRIMARY_SECTIONS.has(s));
  const openSection = more.find((s) => pathname === `${base}/${s}` || pathname.startsWith(`${base}/${s}/`));
  const openTracker = (['domain', 'ssl'] as const).find((k) =>
    pathname.startsWith(`${base}/trackers/${TRACKER[k].path}`),
  );
  const inMore = Boolean(openSection || openTracker);
  const moreLabel = openSection ? SECTION_LABELS[openSection] : openTracker ? TRACKER[openTracker].title : 'More';
  // Expired or expiring domains and certificates still show on the bar while their tracker is in the menu.
  const attention = (['domain', 'ssl'] as const).reduce(
    (sum, k) => sum + (trackers?.[k] ? trackers[k].expired + trackers[k].soon : 0),
    0,
  );
  return (
    <>
      <AppLink
        to="/clients"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" /> Clients
      </AppLink>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="flex flex-wrap items-center gap-3 text-[26px] leading-tight font-semibold tracking-tight">
                {client.name}
                {client.status !== 'active' && (
                  <Badge tone={statusTone[client.status]} className="capitalize">
                    {client.status}
                  </Badge>
                )}
              </h1>
              <FavoriteStar type="client" id={client.id} name={client.name} />
            </div>
            <p className="mt-1 text-sm text-muted">
              {client.type} · {LEVEL_INFO[client.access].label}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {actor.isStaff && (
            <AppLink
              to={`/client-report/${client.id}`}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-semibold hover:bg-surface-3"
            >
              <FileText className="size-4" aria-hidden /> Monthly report
            </AppLink>
          )}
          {actor.isStaff && <ExportButton clientId={client.id} canIncludePasswords={actor.isAdmin} />}
          {atLeast(client.access, 'edit') && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil /> Edit client
            </Button>
          )}
          {actor.isAdmin && (
            <Button variant="secondary" onClick={() => setDeleting(true)}>
              <Trash2 /> Delete
            </Button>
          )}
        </div>
      </div>
      <QuickNote client={client} />
      <nav aria-label="Client sections" className="mb-7 flex items-end gap-1 border-b border-border">
        <div className="flex min-w-0 flex-1 items-end gap-x-1 max-sm:overflow-x-auto">
          {primary.map((s) => {
            const count = s && s in (counts ?? {}) ? counts?.[s as keyof ClientCounts] : null;
            const label = s ? SECTION_LABELS[s] : 'Overview';
            return (
              <AppLink
                key={s || 'overview'}
                aria-label={typeof count === 'number' ? `${label} (${count})` : undefined}
                to={`${base}${s ? `/${s}` : ''}`}
                activeOptions={{ exact: s === '' }}
                className={TAB}
              >
                {label}
                {typeof count === 'number' && (
                  <span aria-hidden className="text-xs font-normal text-muted tabular-nums">
                    {count}
                  </span>
                )}
              </AppLink>
            );
          })}
          {/* The rest of the sections and the trackers, in one menu, so the bar stays a single row. The button takes
              the name of the page it leads to while that page is open. */}
          <Menu.Root modal={false}>
            <Menu.Trigger
              className={cn(TAB, 'items-center outline-none', inMore && 'border-primary text-text')}
              aria-label={inMore ? `${moreLabel}, more sections` : 'More sections'}
            >
              {moreLabel}
              {attention > 0 && (
                <span aria-hidden className="text-xs font-semibold text-warning tabular-nums">
                  {attention}
                </span>
              )}
              <ChevronDown className="size-3.5 self-center text-muted" aria-hidden />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                align="start"
                sideOffset={4}
                className="z-50 min-w-56 rounded-md border border-border bg-surface p-1.5 text-text"
              >
                {more.map((s) => {
                  const count = s in (counts ?? {}) ? counts?.[s as keyof ClientCounts] : null;
                  return (
                    <Menu.Item key={s} asChild className={MENU_ITEM}>
                      <AppLink to={`${base}/${s}`}>
                        <span className="flex-1">{SECTION_LABELS[s]}</span>
                        {typeof count === 'number' && <span className="text-xs text-muted tabular-nums">{count}</span>}
                      </AppLink>
                    </Menu.Item>
                  );
                })}
                {more.length > 0 && <Menu.Separator className="my-1 h-px bg-border" />}
                <Menu.Label className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-muted">Trackers</Menu.Label>
                {(['domain', 'ssl'] as const).map((kind) => {
                  const tracked = trackers?.[kind];
                  const due = tracked ? tracked.expired + tracked.soon : 0;
                  return (
                    <Menu.Item key={kind} asChild className={MENU_ITEM}>
                      <AppLink to={`${base}/trackers/${TRACKER[kind].path}`}>
                        <span className="flex-1">{TRACKER[kind].title}</span>
                        {tracked && (
                          <span
                            className={cn('text-xs tabular-nums', due ? 'font-semibold text-warning' : 'text-muted')}
                          >
                            {tracked.total}
                            <span className="sr-only">
                              {' '}
                              {tracked.total === 1 ? TRACKER[kind].noun : `${TRACKER[kind].noun}s`}
                              {due ? `, ${due} expired or expiring soon` : ''}
                            </span>
                          </span>
                        )}
                      </AppLink>
                    </Menu.Item>
                  );
                })}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Choose which sections show"
          title="Choose which sections show"
          onClick={() => setCustomizing(true)}
          disabled={!prefs}
        >
          <Settings2 />
        </Button>
      </nav>
      <Outlet />
      <ClientForm client={client} open={editing} onClose={() => setEditing(false)} />
      {customizing && prefs && <SectionsDialog prefs={prefs} onClose={() => setCustomizing(false)} />}
      {deleting && <DeleteClientDialog id={client.id} name={client.name} onClose={() => setDeleting(false)} />}
    </>
  );
}

/** Hide client sections this person doesn't use. Applies to every client, for this person only. */
function SectionsDialog({ prefs, onClose }: { prefs: WorkspacePrefs; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [hidden, setHidden] = useState<ClientSection[]>(prefs.hiddenSections);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const saved = await api<WorkspacePrefs>('/account/workspace', {
        method: 'PUT',
        body: { ...prefs, hiddenSections: hidden },
      });
      queryClient.setQueryData(['workspace'], saved);
      toast('Sections saved.');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="Client sections"
      description="Choose the sections you see on every client. This changes nothing for anyone else."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {CLIENT_SECTIONS.map((s) => (
          <Checkbox
            key={s}
            label={SECTION_LABELS[s]}
            checked={!hidden.includes(s)}
            onChange={(e) =>
              setHidden((list) => (e.currentTarget.checked ? list.filter((x) => x !== s) : [...list, s]))
            }
          />
        ))}
      </div>
    </Dialog>
  );
}

/** Administrators only: the client's name typed exactly, then the client and everything in it are gone. */
function DeleteClientDialog({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/clients/${id}`, { method: 'DELETE', body: { confirmName: typed } });
      toast(`Deleted ${name}.`);
      await navigate({ to: '/clients' });
      void qc.invalidateQueries();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${name}`}
      description="This permanently deletes the client and everything in it: assets, passwords, documents, contacts, locations, checklists and files. It can't be undone. To combine two copies of a client instead, use Duplicates."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="delete-client"
            variant="danger"
            loading={busy}
            disabled={typed.trim() !== name.trim()}
          >
            <Trash2 /> Delete client
          </Button>
        </>
      }
    >
      <form id="delete-client" onSubmit={submit} className="space-y-4" noValidate>
        <Field label={`Type the client name: ${name}`} error={error?.fields?.confirmName}>
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
