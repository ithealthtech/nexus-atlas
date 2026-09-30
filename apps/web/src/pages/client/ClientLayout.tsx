import { AppLink } from '@/components/AppLink';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Outlet, useParams } from '@tanstack/react-router';
import { ArrowLeft, Pencil, Settings2, StickyNote } from 'lucide-react';
import {
  CLIENT_SECTIONS,
  LEVEL_INFO,
  atLeast,
  type ClientCounts,
  type ClientSection,
  type WorkspacePrefs,
} from '@atlas/shared';
import { Badge, Button, Card, Checkbox, Dialog, EmptyState, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useClient, useClientCounts, useWorkspacePrefs } from '@/lib/queries';
import { useActor } from '@/lib/session';
import { ExportButton } from '@/components/ExportButton';
import { FavoriteStar } from '@/components/Favorites';
import { QuickNote } from '@/components/QuickNote';
import { TRACKER, useTrackers } from '@/components/Trackers';
import { ClientForm, accessTone, statusTone } from '../Clients';

const SECTION_LABELS: Record<ClientSection, string> = {
  assets: 'Assets',
  documents: 'Documents',
  passwords: 'Passwords',
  contacts: 'Contacts',
  locations: 'Locations',
  checklists: 'Checklists',
  map: 'Map',
  activity: 'Activity',
};

export function ClientLayout() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const { data: client, isLoading, error } = useClient(clientId);
  const [editing, setEditing] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const actor = useActor();
  const counts = useClientCounts(clientId).data;
  const prefs = useWorkspacePrefs().data;
  const trackers = useTrackers(clientId).data;
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
          <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary-soft text-base font-bold text-primary">
            {client.name.slice(0, 2).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="flex flex-wrap items-center gap-3 text-[26px] leading-tight font-semibold tracking-tight">
                {client.name}
                <Badge tone={statusTone[client.status]} className="capitalize">
                  {client.status}
                </Badge>
              </h1>
              <FavoriteStar type="client" id={client.id} name={client.name} />
            </div>
            <p className="mt-1 text-sm text-muted">
              {client.type} · <Badge tone={accessTone(client.access)}>{LEVEL_INFO[client.access].label}</Badge>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {actor.isStaff && <ExportButton clientId={client.id} canIncludePasswords={actor.isAdmin} />}
          {atLeast(client.access, 'edit') && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil /> Edit client
            </Button>
          )}
        </div>
      </div>
      <QuickNote client={client} />
      <nav aria-label="Client sections" className="mb-7 flex items-center gap-1 border-b border-border">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {(['', ...CLIENT_SECTIONS] as const)
            .filter((s) => s === '' || !prefs?.hiddenSections.includes(s))
            .filter((s) => s !== 'passwords' || client.access === 'edit_passwords' || !actor.isStaff)
            .map((s) => {
              const count = s && s in (counts ?? {}) ? counts?.[s as keyof ClientCounts] : null;
              const label = s ? SECTION_LABELS[s] : 'Overview';
              return (
                <AppLink
                  key={s || 'overview'}
                  aria-label={typeof count === 'number' ? `${label} (${count})` : undefined}
                  to={`/clients/${clientId}${s ? `/${s}` : ''}`}
                  activeOptions={{ exact: s === '' }}
                  className="-mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3.5 py-2.5 text-sm font-medium whitespace-nowrap text-muted hover:text-text data-[status=active]:border-primary data-[status=active]:text-text"
                >
                  {label}
                  {typeof count === 'number' && (
                    <span aria-hidden className="rounded-full bg-surface-3 px-1.5 text-xs text-text-2 tabular-nums">
                      {count}
                    </span>
                  )}
                </AppLink>
              );
            })}
          <div
            role="group"
            aria-labelledby="client-trackers"
            className="ml-2 flex shrink-0 items-center border-l border-border pl-2"
          >
            <span
              id="client-trackers"
              className="px-1.5 text-xs font-semibold tracking-wide whitespace-nowrap text-muted uppercase"
            >
              Trackers
            </span>
            {(['domain', 'ssl'] as const).map((kind) => {
              const tracked = trackers?.[kind];
              const attention = tracked ? tracked.expired + tracked.soon : 0;
              return (
                <AppLink
                  key={kind}
                  to={`/clients/${clientId}/trackers/${TRACKER[kind].path}`}
                  className="relative -mb-px flex items-center gap-1.5 border-b-2 border-transparent px-3.5 py-2.5 text-sm font-medium whitespace-nowrap text-muted hover:text-text data-[status=active]:border-primary data-[status=active]:text-text"
                >
                  {TRACKER[kind].title}
                  {tracked && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 text-xs tabular-nums',
                        attention ? 'bg-warning-soft text-warning' : 'bg-surface-3 text-text-2',
                      )}
                    >
                      {tracked.total}
                      <span className="sr-only">
                        {' '}
                        {tracked.total === 1 ? TRACKER[kind].noun : `${TRACKER[kind].noun}s`}
                        {attention ? `, ${attention} expired or expiring soon` : ''}
                      </span>
                    </span>
                  )}
                </AppLink>
              );
            })}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
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
        body: { widgets: prefs.widgets, hiddenSections: hidden },
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
