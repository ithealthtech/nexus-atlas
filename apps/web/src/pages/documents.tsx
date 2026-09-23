import { useMemo, useState } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  BookOpen,
  Folder,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import {
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  atLeast,
  type DocumentStatus,
  type DocumentView,
  type RichText,
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
  Select,
  Skeleton,
  useToast,
  type Tone,
} from '@/components/ui';
import { AppLink, useGo } from '@/components/AppLink';
import { AttachmentsPanel, ItemActivity, RelatedPanel, RevisionsPanel } from '@/components/panels';
import { RichTextEditor, RichTextView } from '@/components/RichText';
import { ApiError, api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { useClient, useDocument, useDocuments, useFolders } from '@/lib/queries';
import { formatDate, relativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export const docTone: Record<DocumentStatus, Tone> = { current: 'success', needs_review: 'warning', draft: 'neutral' };
const EMPTY: RichText = { type: 'doc', content: [{ type: 'paragraph' }] };
const TEMPLATES: { name: string; description: string; content: RichText }[] = [
  { name: 'Blank', description: 'Start from scratch.', content: EMPTY },
  {
    name: 'Runbook / SOP',
    description: 'Purpose, prerequisites, steps, and verification.',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Purpose' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'When to use this procedure and what it achieves.' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Before you start' }] },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Approvals, access, and maintenance window' }] },
              ],
            },
          ],
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First step' }] }],
            },
            {
              type: 'taskItem',
              attrs: { checked: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second step' }] }],
            },
          ],
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Verify' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'How to confirm it worked, and who to tell.' }] },
      ],
    },
  },
  {
    name: 'Onboarding checklist',
    description: 'New-user setup across accounts, devices, and access.',
    content: {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Accounts' }] },
        {
          type: 'taskList',
          content: [
            'Create the user account',
            'Assign licenses',
            'Enroll MFA',
            'Add to groups and shared mailboxes',
          ].map((t) => ({
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
          })),
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Device' }] },
        {
          type: 'taskList',
          content: [
            'Enroll the device',
            'Install line-of-business apps',
            'Map printers',
            'Confirm backup and endpoint protection',
          ].map((t) => ({
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
          })),
        },
      ],
    },
  },
];

// ---------------------------------------------------------------- list
export function DocumentsView({ clientId }: { clientId: string | null }) {
  const search = useSearch({ strict: false }) as { folder?: string; archived?: boolean };
  const go = useGo();
  const actor = useActor();
  const toast = useToast();
  const queryClient = useQueryClient();
  const client = useClient(clientId ?? '');
  const canEdit = clientId
    ? atLeast(client.data?.access ?? 'none', 'edit')
    : actor.isStaff && actor.role !== 'readonly_technician';
  const docs = useDocuments({ client: clientId ?? 'global', archived: search.archived });
  const folders = useFolders(clientId);
  const [query, setQuery] = useState('');
  const [naming, setNaming] = useState(false);
  const base = clientId ? `/clients/${clientId}/documents` : '/documents';
  const rows = useMemo(
    () =>
      (docs.data ?? []).filter(
        (d) =>
          (!search.folder || d.folderId === search.folder) &&
          d.title.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [docs.data, search.folder, query],
  );
  const folderName = folders.data?.find((f) => f.id === search.folder)?.name;
  const newDoc = () => go('/documents/new', { client: clientId ?? undefined, folder: search.folder });
  return (
    <>
      {!clientId && (
        <PageHeader
          eyebrow="Knowledge base"
          title="MSP knowledge base"
          description="Internal standards, procedures, and references for your team. Client contacts never see these."
          actions={
            canEdit && (
              <Button onClick={newDoc}>
                <Plus /> New document
              </Button>
            )
          }
        />
      )}
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Folders" className="flex gap-1 overflow-x-auto lg:flex-col">
          <AppLink
            to={base}
            search={{}}
            aria-current={!search.folder}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-text-2 hover:bg-surface-3 aria-[current=true]:bg-primary-soft aria-[current=true]:font-semibold aria-[current=true]:text-primary"
          >
            <BookOpen className="size-4" aria-hidden /> All documents
          </AppLink>
          {folders.data?.map((f) => (
            <div key={f.id} className="group flex items-center">
              <AppLink
                to={base}
                search={{ folder: f.id }}
                aria-current={search.folder === f.id}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-text-2 hover:bg-surface-3 aria-[current=true]:bg-primary-soft aria-[current=true]:font-semibold aria-[current=true]:text-primary"
              >
                <Folder className="size-4 shrink-0" aria-hidden /> <span className="truncate">{f.name}</span>
                <span className="ml-auto text-xs text-muted">{f.documentCount}</span>
              </AppLink>
              {canEdit && (
                <button
                  className="hidden rounded p-1 text-muted group-hover:block hover:text-danger lg:block lg:opacity-0 lg:group-hover:opacity-100"
                  aria-label={`Delete folder ${f.name}`}
                  onClick={async () => {
                    if (!confirm(`Delete the folder "${f.name}"? Its documents move to the top level.`)) return;
                    await api(`/folders/${f.id}`, { method: 'DELETE' });
                    await Promise.all([
                      queryClient.invalidateQueries({ queryKey: ['folders'] }),
                      queryClient.invalidateQueries({ queryKey: ['documents'] }),
                    ]);
                    toast('Folder deleted.');
                    if (search.folder === f.id) go(base);
                  }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </div>
          ))}
          {canEdit && (
            <button
              onClick={() => setNaming(true)}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm whitespace-nowrap text-primary hover:bg-surface-3"
            >
              <FolderPlus className="size-4" aria-hidden /> New folder
            </button>
          )}
        </nav>
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
            <label className="relative min-w-48 flex-1">
              <span className="sr-only">Filter documents</span>
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Filter ${folderName ?? 'documents'}…`}
                className="pl-9"
              />
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => go(base, { ...search, archived: search.archived ? undefined : true })}
            >
              {search.archived ? <ArchiveRestore /> : <Archive />} {search.archived ? 'Show active' : 'Show archived'}
            </Button>
            {canEdit && clientId && (
              <Button onClick={newDoc}>
                <Plus /> New document
              </Button>
            )}
          </div>
          {docs.isLoading ? (
            <div className="space-y-3 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-11" />
              ))}
            </div>
          ) : rows.length ? (
            <ul className="divide-y divide-border">
              {rows.map((d) => (
                <li key={d.id}>
                  <AppLink to={`/documents/${d.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-2">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary">
                      <BookOpen className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{d.title}</span>
                      <span className="block truncate text-xs text-muted">
                        Updated {relativeTime(d.updatedAt)}
                        {d.updatedByName && ` by ${d.updatedByName}`}
                        {d.reviewDate && ` · Review ${formatDate(`${d.reviewDate}T12:00:00`)}`}
                      </span>
                    </span>
                    <Badge tone={docTone[d.status]}>{DOCUMENT_STATUS_LABELS[d.status]}</Badge>
                  </AppLink>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={BookOpen}
              title={
                search.archived ? 'No archived documents' : query || search.folder ? 'Nothing here' : 'No documents yet'
              }
              description={
                canEdit
                  ? 'Write runbooks, checklists, and references your team can rely on.'
                  : 'Nothing has been written here yet.'
              }
              action={
                canEdit && !search.archived ? (
                  <Button onClick={newDoc}>
                    <Plus /> New document
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      </div>
      {naming && <FolderDialog clientId={clientId} onClose={() => setNaming(false)} />}
    </>
  );
}

function FolderDialog({ clientId, onClose }: { clientId: string | null; onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const save = async () => {
    try {
      await api('/folders', { method: 'POST', body: { name, clientId } });
      await queryClient.invalidateQueries({ queryKey: ['folders'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="New folder"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!name.trim()}>
            Create folder
          </Button>
        </>
      }
    >
      <Field label="Folder name">
        {(p) => (
          <Input
            {...p}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()}
          />
        )}
      </Field>
      <FormError message={error} />
    </Dialog>
  );
}

export function ClientDocuments() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  return <DocumentsView clientId={clientId} />;
}
export function KnowledgeBase() {
  return <DocumentsView clientId={null} />;
}

// ---------------------------------------------------------------- editor
function DocumentForm({
  initial,
  clientId,
  onSave,
  onCancel,
}: {
  initial: {
    title: string;
    content: RichText;
    status: DocumentStatus;
    reviewDate: string | null;
    folderId: string | null;
  };
  clientId: string | null;
  onSave: (values: typeof initial) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const folders = useFolders(clientId).data ?? [];
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(values);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="space-y-4"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') {
          e.preventDefault();
          save();
        }
      }}
    >
      <Field label="Title" error={error?.fields?.title}>
        {(p) => (
          <Input
            {...p}
            value={values.title}
            onChange={(e) => setValues({ ...values, title: e.target.value })}
            className="h-12 text-lg font-semibold"
            maxLength={200}
            autoFocus={!initial.title}
            placeholder="Document title"
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Status">
          {(p) => (
            <Select
              {...p}
              value={values.status}
              onChange={(e) => setValues({ ...values, status: e.target.value as DocumentStatus })}
            >
              {DOCUMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {DOCUMENT_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Review by" help="Shows in review lists when due.">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={values.reviewDate ?? ''}
              onChange={(e) => setValues({ ...values, reviewDate: e.target.value || null })}
            />
          )}
        </Field>
        <Field label="Folder">
          {(p) => (
            <Select
              {...p}
              value={values.folderId ?? ''}
              onChange={(e) => setValues({ ...values, folderId: e.target.value || null })}
            >
              <option value="">No folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <RichTextEditor
        label="Document content"
        content={values.content}
        onChange={(content) => setValues((v) => ({ ...v, content }))}
        placeholder="Write the procedure… Keep passwords out; they belong in the vault."
      />
      <FormError message={error?.message ?? null} />
      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t border-border bg-bg/95 px-1 py-3 backdrop-blur">
        <span className="mr-auto hidden text-xs text-muted sm:block">Ctrl+S to save</span>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={save} loading={busy} disabled={!values.title.trim()}>
          Save document
        </Button>
      </div>
    </div>
  );
}

export function NewDocument() {
  const search = useSearch({ strict: false }) as { client?: string; folder?: string };
  const go = useGo();
  const toast = useToast();
  const queryClient = useQueryClient();
  const clientId = search.client ?? null;
  const client = useClient(clientId ?? '');
  const [template, setTemplate] = useState<RichText | null>(null);
  const back = clientId ? `/clients/${clientId}/documents` : '/documents';
  return (
    <>
      <AppLink
        to={back}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" /> {clientId ? `${client.data?.name ?? 'Client'} · Documents` : 'Knowledge base'}
      </AppLink>
      <PageHeader eyebrow={clientId ? (client.data?.name ?? 'Client') : 'MSP knowledge base'} title="New document" />
      {!template ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {TEMPLATES.map((t) => (
            <button
              key={t.name}
              onClick={() => setTemplate(t.content)}
              className="rounded-xl border border-border bg-surface p-5 text-left shadow-card hover:border-primary hover:bg-primary-soft/40"
            >
              <BookOpen className="mb-3 size-5 text-primary" aria-hidden />
              <span className="block font-semibold">{t.name}</span>
              <span className="mt-1 block text-sm text-muted">{t.description}</span>
            </button>
          ))}
        </div>
      ) : (
        <DocumentForm
          clientId={clientId}
          initial={{
            title: '',
            content: template,
            status: 'current',
            reviewDate: null,
            folderId: search.folder ?? null,
          }}
          onCancel={() => go(back)}
          onSave={async (values) => {
            const saved = await api<DocumentView>('/documents', { method: 'POST', body: { ...values, clientId } });
            await queryClient.invalidateQueries({ queryKey: ['documents'] });
            toast('Document created.');
            go(`/documents/${saved.id}`);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- detail
export function DocumentPage() {
  const { documentId } = useParams({ strict: false }) as { documentId: string };
  const { data: doc, isLoading, error, refetch } = useDocument(documentId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  if (isLoading) return <Skeleton className="h-96" />;
  if (error || !doc)
    return (
      <Card>
        <EmptyState
          icon={BookOpen}
          title="Document not found"
          description="It may have been removed, or you don't have access to it."
        />
      </Card>
    );
  const back = doc.clientId ? `/clients/${doc.clientId}/documents` : '/documents';
  const archive = async () => {
    await api(`/documents/${doc.id}/archive`, { method: 'POST', body: { archived: !doc.archived } });
    await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: ['documents'] })]);
    toast(doc.archived ? 'Document restored.' : 'Document archived. You can restore it from the archived list.');
  };
  return (
    <>
      <AppLink
        to={back}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
      >
        <ArrowLeft className="size-4" /> {doc.clientName ? `${doc.clientName} · Documents` : 'Knowledge base'}
      </AppLink>
      {editing ? (
        <DocumentForm
          clientId={doc.clientId}
          initial={{
            title: doc.title,
            content: doc.content,
            status: doc.status,
            reviewDate: doc.reviewDate,
            folderId: doc.folderId,
          }}
          onCancel={() => setEditing(false)}
          onSave={async (values) => {
            try {
              const saved = await api<DocumentView>(`/documents/${doc.id}`, {
                method: 'PATCH',
                body: { ...values, version: doc.version },
              });
              queryClient.setQueryData(['document', doc.id], saved);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['documents'] }),
                queryClient.invalidateQueries({ queryKey: ['revisions', 'documents', doc.id] }),
              ]);
              setEditing(false);
              toast('Document saved.');
            } catch (e) {
              if (e instanceof ApiError && e.code === 'conflict')
                throw new ApiError(
                  409,
                  'Someone saved a newer version while you were editing. Copy your changes, reload the page, and apply them again.',
                );
              throw e;
            }
          }}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="mb-2 text-xs font-bold tracking-[0.14em] text-muted uppercase">
                  {doc.clientName ?? 'MSP knowledge base'}
                </p>
                <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{doc.title}</h1>
                <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                  <Badge tone={docTone[doc.status]}>{DOCUMENT_STATUS_LABELS[doc.status]}</Badge>
                  {doc.archived && <Badge tone="warning">Archived</Badge>}
                  Updated {relativeTime(doc.updatedAt)}
                  {doc.updatedByName && ` by ${doc.updatedByName}`}
                  {doc.reviewDate && (
                    <span
                      className={cn(
                        doc.reviewDate < new Date().toISOString().slice(0, 10) && 'font-semibold text-warning',
                      )}
                    >
                      · Review by {formatDate(`${doc.reviewDate}T12:00:00`)}
                    </span>
                  )}
                </p>
              </div>
              {doc.canEdit && (
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={archive}>
                    {doc.archived ? <ArchiveRestore /> : <Archive />} {doc.archived ? 'Restore' : 'Archive'}
                  </Button>
                  {!doc.archived && (
                    <Button onClick={() => setEditing(true)}>
                      <Pencil /> Edit
                    </Button>
                  )}
                </div>
              )}
            </div>
            <Card className="px-6 py-6 sm:px-8">
              <RichTextView content={doc.content} />
            </Card>
            <ItemActivity id={doc.id} />
          </div>
          <div className="space-y-6">
            <RelatedPanel type="document" id={doc.id} clientId={doc.clientId} canEdit={doc.canEdit} />
            <AttachmentsPanel type="document" id={doc.id} canEdit={doc.canEdit} />
            <RevisionsPanel
              kind="documents"
              id={doc.id}
              currentVersion={doc.version}
              canEdit={doc.canEdit && !doc.archived}
              onRestored={() => refetch()}
              toText={(s) => {
                const snap = s as { title: string; text: string; status: DocumentStatus };
                return `# ${snap.title}\nStatus: ${DOCUMENT_STATUS_LABELS[snap.status]}\n\n${snap.text}`;
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
