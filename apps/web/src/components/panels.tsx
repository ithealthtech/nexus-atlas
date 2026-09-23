import { useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { diffLines } from 'diff';
import { Download, FileText, History, Paperclip, Plus, RotateCcw, Search, Trash2, Upload, X } from 'lucide-react';
import type { ActivityView, ItemType, RevisionView } from '@atlas/shared';
import { Button, Card, CardHeader, Dialog, Input, Skeleton, useToast } from '@/components/ui';
import { ItemIcon, itemHref } from '@/components/ItemIcon';
import { api, getCsrf } from '@/lib/api';
import { AppLink } from '@/components/AppLink';
import { cn } from '@/lib/cn';
import { formatDateTime, relativeTime } from '@/lib/format';
import { uploadFile, useActivity, useAttachments, useRelations, useRevisions, useSearch } from '@/lib/queries';

// ---------------------------------------------------------------- related items
export function RelatedPanel({
  type,
  id,
  clientId,
  canEdit,
}: {
  type: ItemType;
  id: string;
  clientId: string | null;
  canEdit: boolean;
}) {
  const { data, isLoading } = useRelations(type, id);
  const client = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const refresh = (next: unknown) => client.setQueryData(['relations', type, id], next);
  return (
    <Card>
      <CardHeader
        title="Related"
        actions={
          canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
              <Plus /> Link
            </Button>
          )
        }
      />
      {isLoading ? (
        <Skeleton className="m-4 h-10" />
      ) : !data?.length ? (
        <p className="px-5 py-4 text-sm text-muted">
          {canEdit ? 'Link the assets, runbooks, and contacts that go with this.' : 'Nothing linked yet.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((r) => (
            <li key={r.relationId} className="group flex items-center gap-3 px-4 py-2.5">
              <ItemIcon type={r.type} />
              <AppLink to={itemHref(r)} className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium hover:underline">{r.title}</span>
                <span className="block truncate text-xs text-muted">{r.subtitle}</span>
              </AppLink>
              {canEdit && (
                <button
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                  aria-label={`Unlink ${r.title}`}
                  onClick={async () => {
                    refresh(await api(`/items/${type}/${id}/relations/${r.relationId}`, { method: 'DELETE' }));
                    toast('Link removed.');
                  }}
                >
                  <X className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <LinkPicker
          clientId={clientId}
          exclude={[id, ...(data ?? []).map((r) => r.id)]}
          onClose={() => setAdding(false)}
          onPick={async (target) => {
            refresh(await api(`/items/${type}/${id}/relations`, { method: 'POST', body: target }));
            setAdding(false);
            toast(`Linked ${target.title}.`);
          }}
        />
      )}
    </Card>
  );
}

function LinkPicker({
  clientId,
  exclude,
  onClose,
  onPick,
}: {
  clientId: string | null;
  exclude: string[];
  onClose: () => void;
  onPick: (t: { type: ItemType; id: string; title: string }) => void;
}) {
  const [q, setQ] = useState('');
  const results = useSearch(q, clientId ?? undefined);
  const items = (results.data ?? []).filter((r) => r.type !== 'client' && !exclude.includes(r.id));
  return (
    <Dialog
      open
      onClose={onClose}
      title="Link an item"
      description={
        clientId
          ? 'Search this client’s assets, documents, contacts, and locations.'
          : 'Search across the clients you can access.'
      }
    >
      <label className="relative block">
        <span className="sr-only">Search</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name…" className="pl-9" />
      </label>
      <ul className="mt-3 max-h-80 overflow-y-auto">
        {items.map((r) => (
          <li key={r.id}>
            <button
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface-3"
              onClick={() => onPick({ type: r.type as ItemType, id: r.id, title: r.title })}
            >
              <ItemIcon type={r.type} />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{r.title}</span>
                <span className="block truncate text-xs text-muted">
                  {r.subtitle}
                  {r.clientName && ` · ${r.clientName}`}
                </span>
              </span>
            </button>
          </li>
        ))}
        {q && !results.isFetching && !items.length && (
          <li className="px-2 py-6 text-center text-sm text-muted">No matches.</li>
        )}
      </ul>
    </Dialog>
  );
}

// ---------------------------------------------------------------- attachments
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / 1048576).toFixed(1)} MB`;

export function AttachmentsPanel({ type, id, canEdit }: { type: ItemType; id: string; canEdit: boolean }) {
  const { data, isLoading } = useAttachments(type, id);
  const client = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files))
        client.setQueryData(['attachments', type, id], await uploadFile(type, id, file, getCsrf()));
      toast(files.length === 1 ? `${files[0]!.name} uploaded.` : `${files.length} files uploaded.`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canEdit) upload(e.dataTransfer.files);
  };
  return (
    <Card
      onDragOver={(e) => {
        if (canEdit) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(dragging && 'ring-2 ring-primary')}
    >
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
                aria-label="Choose files to upload"
                onChange={(e) => upload(e.target.files)}
              />
              <Button variant="ghost" size="sm" loading={busy} onClick={() => input.current?.click()}>
                <Upload /> Upload
              </Button>
            </>
          )
        }
      />
      {isLoading ? (
        <Skeleton className="m-4 h-10" />
      ) : !data?.length ? (
        <p className="px-5 py-4 text-sm text-muted">
          {canEdit ? 'Drop diagrams, exports, or photos here.' : 'No files.'}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((f) => (
            <li key={f.id} className="group flex items-center gap-3 px-4 py-2.5">
              {f.previewable ? (
                <img
                  src={`/api/attachments/${f.id}/content?inline=1`}
                  alt=""
                  className="size-8 shrink-0 rounded-md border border-border object-cover"
                />
              ) : (
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-text-2">
                  <FileText className="size-4" aria-hidden />
                </span>
              )}
              <a
                href={`/api/attachments/${f.id}/content${f.previewable ? '?inline=1' : ''}`}
                target={f.previewable ? '_blank' : undefined}
                rel="noopener"
                className="min-w-0 flex-1"
              >
                <span className="block truncate text-sm font-medium hover:underline">{f.filename}</span>
                <span className="block text-xs text-muted">
                  {size(f.size)} · {relativeTime(f.createdAt)}
                </span>
              </a>
              <a
                href={`/api/attachments/${f.id}/content`}
                className="rounded p-1 text-muted hover:text-text"
                aria-label={`Download ${f.filename}`}
              >
                <Download className="size-4" />
              </a>
              {canEdit && (
                <button
                  className="rounded p-1 text-muted opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100"
                  aria-label={`Delete ${f.filename}`}
                  onClick={async () => {
                    if (!confirm(`Delete ${f.filename}? This can't be undone.`)) return;
                    await api(`/attachments/${f.id}`, { method: 'DELETE' });
                    await client.invalidateQueries({ queryKey: ['attachments', type, id] });
                    toast('File deleted.');
                  }}
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && data && data.length > 0 && (
        <p className="flex items-center gap-1.5 border-t border-border px-4 py-2 text-xs text-muted">
          <Paperclip className="size-3" aria-hidden /> Drag files here to add more.
        </p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- revisions
/**
 * Version history with a line diff against the current version. `toText` turns a stored snapshot into comparable text.
 */
export function RevisionsPanel({
  kind,
  id,
  currentVersion,
  canEdit,
  toText,
  onRestored,
}: {
  kind: 'assets' | 'documents';
  id: string;
  currentVersion: number;
  canEdit: boolean;
  toText: (snapshot: unknown) => string;
  onRestored: () => void;
}) {
  const { data } = useRevisions(kind, id);
  const [viewing, setViewing] = useState<RevisionView | null>(null);
  return (
    <Card>
      <CardHeader title="Version history" description={`Version ${currentVersion}`} />
      <ul className="max-h-72 divide-y divide-border overflow-y-auto">
        {data?.map((r) => (
          <li key={r.version} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <History className="size-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium">Version {r.version}</span>
              <span className="block truncate text-xs text-muted">
                {r.authorName} · {formatDateTime(r.createdAt)}
              </span>
            </span>
            {r.version === currentVersion ? (
              <span className="text-xs font-medium text-success">Current</span>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setViewing(r)}>
                Compare
              </Button>
            )}
          </li>
        ))}
      </ul>
      {viewing && (
        <DiffDialog
          kind={kind}
          id={id}
          revision={viewing}
          current={currentVersion}
          canEdit={canEdit}
          toText={toText}
          onClose={() => setViewing(null)}
          onRestored={onRestored}
        />
      )}
    </Card>
  );
}

function DiffDialog({
  kind,
  id,
  revision,
  current,
  canEdit,
  toText,
  onClose,
  onRestored,
}: {
  kind: 'assets' | 'documents';
  id: string;
  revision: RevisionView;
  current: number;
  canEdit: boolean;
  toText: (s: unknown) => string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const client = useQueryClient();
  const older = useQuery({
    queryKey: ['revision', kind, id, revision.version],
    queryFn: () => api(`/${kind}/${id}/revisions/${revision.version}`),
    staleTime: Infinity,
  });
  const latest = useQuery({
    queryKey: ['revision', kind, id, current],
    queryFn: () => api(`/${kind}/${id}/revisions/${current}`),
    staleTime: Infinity,
  });
  const texts = older.data && latest.data ? ([toText(older.data), toText(latest.data)] as const) : null;
  const parts = texts ? diffLines(texts[0], texts[1]) : [];
  const restore = async () => {
    setBusy(true);
    try {
      await api(`/${kind}/${id}/restore`, {
        method: 'POST',
        body: { version: revision.version, expectedVersion: current },
      });
      await client.invalidateQueries({ queryKey: ['revisions', kind, id] });
      toast(`Version ${revision.version} restored as version ${current + 1}.`);
      onRestored();
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Version ${revision.version} → current (${current})`}
      description={`${revision.authorName} · ${formatDateTime(revision.createdAt)}. Red lines were removed since, green lines were added.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          {canEdit && (
            <Button onClick={restore} loading={busy}>
              <RotateCcw /> Restore version {revision.version}
            </Button>
          )}
        </>
      }
    >
      {!texts ? (
        <Skeleton className="h-40" />
      ) : (
        <pre className="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">
          {parts.map((part, i) => (
            <span
              key={i}
              className={cn(
                'block',
                part.added && 'bg-success-soft text-success',
                part.removed && 'bg-danger-soft text-danger line-through decoration-danger/40',
              )}
            >
              {part.value
                .replace(/\n$/, '')
                .split('\n')
                .map((line) => `${part.added ? '+ ' : part.removed ? '− ' : '  '}${line}`)
                .join('\n')}
            </span>
          ))}
          {parts.length === 1 && !parts[0]!.added && !parts[0]!.removed && (
            <span className="mt-2 block font-sans text-muted">
              No text differences. Only formatting or metadata changed.
            </span>
          )}
        </pre>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- activity
export function ActivityFeed({
  items,
  showClient = true,
  empty = 'Nothing has happened here yet.',
}: {
  items: ActivityView[] | undefined;
  showClient?: boolean;
  empty?: string;
}) {
  if (!items) return <Skeleton className="m-4 h-24" />;
  if (!items.length) return <p className="px-5 py-4 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.map((a) => {
        const href =
          a.entityId && ['asset', 'document'].includes(a.entityType)
            ? itemHref({ type: a.entityType as ItemType, id: a.entityId, clientId: a.clientId })
            : null;
        return (
          <li key={a.id} className="flex items-start gap-3 px-5 py-3 text-sm">
            <ItemIcon
              type={
                (['asset', 'document', 'contact', 'location'].includes(a.entityType)
                  ? a.entityType
                  : 'client') as ItemType
              }
              className="mt-0.5 size-7"
            />
            <div className="min-w-0 flex-1">
              <p className="text-text-2">
                <span className="font-medium text-text">{a.actorName}</span> {a.action.toLowerCase()}{' '}
                {href ? (
                  <AppLink to={href} className="font-medium text-text hover:underline">
                    {a.title}
                  </AppLink>
                ) : (
                  <span className="font-medium text-text">{a.title}</span>
                )}
              </p>
              <p className="text-xs text-muted">
                {relativeTime(a.createdAt)}
                {showClient && a.clientName && ` · ${a.clientName}`}
                {showClient && !a.clientId && ' · Knowledge base'}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ItemActivity({ id }: { id: string }) {
  const { data } = useActivity({ item: id, limit: '10' });
  return (
    <Card>
      <CardHeader title="Activity" />
      <ActivityFeed items={data} showClient={false} />
    </Card>
  );
}
