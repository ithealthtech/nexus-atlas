import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Download, ListChecks, Pencil, Plus, Printer, Trash2, X } from 'lucide-react';
import type { ChecklistView, RunView } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
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
  Textarea,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/lib/format';
import { useClient } from '@/lib/queries';
import { useActor } from '@/lib/session';

const useChecklists = (client?: string) =>
  useQuery({
    queryKey: ['checklists', client ?? 'all'],
    queryFn: () => api<ChecklistView[]>(`/checklists${client ? `?client=${client}` : ''}`),
  });
const useRuns = (query: string) =>
  useQuery({ queryKey: ['checklist-runs', query], queryFn: () => api<RunView[]>(`/checklist-runs?${query}`) });
/** Staff who can work on this client's runs: the only people a run for it can be assigned to. */
const useTeam = (clientId: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ['checklist-team', clientId],
    queryFn: () => api<{ id: string; name: string }[]>(`/checklists/team?client=${clientId}`),
    enabled: enabled && !!clientId,
  });

// Today in the viewer's own time zone, as YYYY-MM-DD.
const today = () => new Date().toLocaleDateString('en-CA');
const overdue = (run: RunView) => !run.completedAt && !!run.dueDate && run.dueDate < today();

/** The run as Markdown, built in the browser so it also works offline and in the demo. */
function runMarkdown(run: RunView) {
  const lines = [
    `# ${run.title}`,
    '',
    `- Client: ${run.clientName}`,
    `- Started: ${run.createdAt.slice(0, 10)}${run.createdByName ? ` by ${run.createdByName}` : ''}`,
    ...(run.assigneeName ? [`- Assigned to: ${run.assigneeName}`] : []),
    ...(run.dueDate ? [`- Due: ${run.dueDate}`] : []),
    `- Progress: ${run.done} of ${run.total} steps${run.completedAt ? `, completed ${run.completedAt.slice(0, 10)}` : ''}`,
    '',
    ...run.steps.flatMap((s) => [
      `- [${s.doneAt ? 'x' : ' '}] ${s.text}${s.doneAt ? ` — ${s.doneByName ?? 'someone'}, ${s.doneAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`,
      ...(s.note ? [`  - Note: ${s.note}`] : []),
    ]),
    '',
  ];
  return lines.join('\n');
}

function Progress({ run }: { run: RunView }) {
  const pct = run.total ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3"
        role="progressbar"
        aria-valuenow={run.done}
        aria-valuemin={0}
        aria-valuemax={run.total}
        aria-label={`${run.done} of ${run.total} steps done`}
      >
        <div className={cn('h-full', run.completedAt ? 'bg-success' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted">
        {run.done}/{run.total}
      </span>
    </div>
  );
}

function RunList({ runs, showClient, empty }: { runs: RunView[] | undefined; showClient: boolean; empty: string }) {
  if (!runs) return <Skeleton className="m-4 h-24" />;
  if (!runs.length) return <p className="px-5 py-4 text-sm text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {runs.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm">
          <div className="min-w-0 flex-1">
            <AppLink to={`/checklist-runs/${r.id}`} className="font-medium hover:underline">
              {r.title}
            </AppLink>
            <p className="text-xs text-muted">
              {showClient && `${r.clientName} · `}
              {r.assigneeName ? `Assigned to ${r.assigneeName}` : 'Unassigned'}
              {r.dueDate && ` · due ${formatDate(`${r.dueDate}T12:00:00`)}`}
            </p>
          </div>
          {r.completedAt ? (
            <Badge tone="success">Done {formatDate(r.completedAt)}</Badge>
          ) : overdue(r) ? (
            <Badge tone="danger">Overdue</Badge>
          ) : null}
          <Progress run={r} />
        </li>
      ))}
    </ul>
  );
}

/** Create or edit a checklist template. */
function ChecklistDialog({
  open,
  onClose,
  checklist,
  clientId,
}: {
  open: boolean;
  onClose: () => void;
  checklist?: ChecklistView;
  clientId: string | null;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [steps, setSteps] = useState<{ id?: string; text: string }[]>(
    checklist?.steps ?? [{ text: '' }, { text: '' }, { text: '' }],
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = {
      title: form.get('title'),
      description: form.get('description'),
      steps: steps.filter((s) => s.text.trim()),
    };
    setBusy(true);
    setError(null);
    try {
      if (checklist) await api(`/checklists/${checklist.id}`, { method: 'PATCH', body });
      else await api('/checklists', { method: 'POST', body: { ...body, clientId } });
      await queryClient.invalidateQueries({ queryKey: ['checklists'] });
      toast(checklist ? 'Checklist saved.' : 'Checklist created.');
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={checklist ? `Edit ${checklist.title}` : 'New checklist'}
      description="Steps are copied into each run, so changing them later doesn't affect work already under way."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="checklist-form" loading={busy}>
            {checklist ? 'Save checklist' : 'Create checklist'}
          </Button>
        </>
      }
    >
      <form id="checklist-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Title" error={error?.fields?.title}>
          {(p) => <Input {...p} name="title" defaultValue={checklist?.title} required maxLength={200} autoFocus />}
        </Field>
        <Field label="Description" help="Optional: when to use it." error={error?.fields?.description}>
          {(p) => <Textarea {...p} name="description" defaultValue={checklist?.description} rows={2} />}
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-semibold">Steps</legend>
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-6 text-right text-xs text-muted" aria-hidden>
                {i + 1}.
              </span>
              <Input
                aria-label={`Step ${i + 1}`}
                value={s.text}
                maxLength={500}
                onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Remove step ${i + 1}`}
                onClick={() => setSteps(steps.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={() => setSteps([...steps, { text: '' }])}>
            <Plus /> Add a step
          </Button>
          {error?.fields?.steps && <p className="text-xs text-danger">{error.fields.steps}</p>}
        </fieldset>
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

/** Start a run for a client: from a checklist, or a one-off list. */
function StartRunDialog({ open, onClose, clientId }: { open: boolean; onClose: () => void; clientId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const actor = useActor();
  const templates = useChecklists(clientId).data ?? [];
  const team = useTeam(clientId, open && actor.isStaff).data ?? [];
  const [checklistId, setChecklistId] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const oneOff = !checklistId;
    const body = {
      ...(oneOff
        ? {
            title: form.get('title'),
            steps: String(form.get('steps') ?? '')
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : { checklistId }),
      assigneeId: form.get('assigneeId') || null,
      dueDate: form.get('dueDate') || null,
    };
    setBusy(true);
    setError(null);
    try {
      const run = await api<RunView>(`/clients/${clientId}/checklist-runs`, { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: ['checklist-runs'] });
      onClose();
      await navigate({ to: `/checklist-runs/${run.id}` });
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Start a checklist"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="run-form" loading={busy}>
            Start
          </Button>
        </>
      }
    >
      <form id="run-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Checklist" error={error?.fields?.checklistId}>
          {(p) => (
            <Select {...p} value={checklistId} onChange={(e) => setChecklistId(e.target.value)}>
              <option value="">A one-off list…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {t.clientId ? '' : ' (all clients)'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!checklistId && (
          <>
            <Field label="Title" error={error?.fields?.title}>
              {(p) => <Input {...p} name="title" maxLength={200} />}
            </Field>
            <Field label="Steps" help="One per line." error={error?.fields?.steps}>
              {(p) => <Textarea {...p} name="steps" rows={5} />}
            </Field>
          </>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assign to" error={error?.fields?.assigneeId}>
            {(p) => (
              <Select {...p} name="assigneeId" defaultValue={actor.id}>
                <option value="">Nobody yet</option>
                {team.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Due" error={error?.fields?.dueDate}>
            {(p) => <Input {...p} name="dueDate" type="date" />}
          </Field>
        </div>
        <FormError message={error && (!error.fields || error.fields.body) ? error.message : null} />
      </form>
    </Dialog>
  );
}

function TemplateList({
  templates,
  clientId,
  canEditClient,
}: {
  templates: ChecklistView[] | undefined;
  clientId: string | null;
  /** On a client's page: whether the viewer can edit that client, as creating a checklist there needs. */
  canEditClient?: boolean;
}) {
  const [editing, setEditing] = useState<ChecklistView | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const actor = useActor();
  const canCreate = clientId ? !!canEditClient : actor.isStaff && actor.role !== 'readonly_technician';
  // Archived checklists stay restorable: the same list, archived ones only, each with Restore.
  const archived = useQuery({
    queryKey: ['checklists', clientId ?? 'global', 'archived'],
    queryFn: () => api<ChecklistView[]>(`/checklists?client=${clientId ?? 'global'}&archived=true`),
    enabled: showArchived,
  }).data?.filter((t) => t.clientId === clientId);
  const setArchived = async (t: ChecklistView, value: boolean) => {
    await api(`/checklists/${t.id}/archive`, { method: 'POST', body: { archived: value } });
    await queryClient.invalidateQueries({ queryKey: ['checklists'] });
    toast(value ? `${t.title} archived.` : `${t.title} restored.`);
  };
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <h2 className="font-semibold">{clientId ? 'This client’s checklists' : 'Checklists'}</h2>
          <p className="text-sm text-muted">
            {clientId ? 'Only for this client.' : 'Reusable steps you can run for any client.'}
          </p>
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> New checklist
          </Button>
        )}
      </div>
      {!templates ? (
        <Skeleton className="m-4 h-20" />
      ) : !templates.length ? (
        <p className="px-5 py-4 text-sm text-muted">No checklists yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t.title}</p>
                <p className="truncate text-xs text-muted">
                  {t.steps.length} {t.steps.length === 1 ? 'step' : 'steps'}
                  {t.description && ` · ${t.description}`}
                </p>
              </div>
              {t.canEdit && (
                <>
                  <Button variant="ghost" size="icon" aria-label={`Edit ${t.title}`} onClick={() => setEditing(t)}>
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Archive ${t.title}`}
                    onClick={() => setArchived(t, true)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border px-5 py-3">
        <button
          type="button"
          aria-expanded={showArchived}
          onClick={() => setShowArchived(!showArchived)}
          className="text-sm font-semibold text-primary hover:underline"
        >
          {showArchived ? 'Hide archived checklists' : 'Show archived checklists'}
        </button>
        {showArchived &&
          (!archived ? (
            <Skeleton className="mt-3 h-10" />
          ) : !archived.length ? (
            <p className="mt-2 text-sm text-muted">Nothing is archived.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {archived.map((t) => (
                <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate text-muted">{t.title}</span>
                  {t.canEdit && (
                    <Button variant="secondary" size="sm" onClick={() => setArchived(t, false)}>
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </div>
      {editing && (
        <ChecklistDialog
          open
          onClose={() => setEditing(null)}
          checklist={editing === 'new' ? undefined : editing}
          clientId={clientId}
        />
      )}
    </Card>
  );
}

/** Sidebar page: my open runs, every open run, and the MSP's checklists. */
export function ChecklistsPage() {
  const mine = useRuns('assignee=me&state=open').data;
  const open = useRuns('state=open').data;
  const templates = useChecklists().data?.filter((t) => !t.clientId);
  return (
    <>
      <PageHeader
        title="Checklists"
        description="Runnable procedures: onboarding, offboarding, maintenance. Start one from a client’s Checklists tab."
      />
      <div className="space-y-5">
        <Card>
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-semibold">Assigned to me</h2>
          </div>
          <RunList runs={mine} showClient empty="Nothing assigned to you is open." />
        </Card>
        <Card>
          <div className="border-b border-border px-5 py-4">
            <h2 className="font-semibold">All open runs</h2>
          </div>
          <RunList runs={open} showClient empty="No checklists are under way." />
        </Card>
        <TemplateList templates={templates} clientId={null} />
      </div>
    </>
  );
}

/** A client's Checklists tab. */
export function ClientChecklists() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId).data;
  const canEdit = client?.access === 'edit' || client?.access === 'edit_passwords';
  const runs = useRuns(`client=${clientId}`).data;
  const templates = useChecklists(clientId).data?.filter((t) => t.clientId === clientId);
  const [starting, setStarting] = useState(false);
  const actor = useActor();
  return (
    <div className="space-y-5">
      <Card>
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="font-semibold">Runs</h2>
          {canEdit && (
            <Button size="sm" onClick={() => setStarting(true)}>
              <ListChecks /> Start a checklist
            </Button>
          )}
        </div>
        {runs && !runs.length ? (
          <EmptyState
            icon={ListChecks}
            title="No checklists run yet"
            description="Start one to work through a procedure step by step, with a record of who did what and when."
          />
        ) : (
          <RunList runs={runs} showClient={false} empty="" />
        )}
      </Card>
      {actor.isStaff && <TemplateList templates={templates} clientId={clientId} canEditClient={canEdit} />}
      {starting && <StartRunDialog open onClose={() => setStarting(false)} clientId={clientId} />}
    </div>
  );
}

/** One run: tick steps, add notes, change who it's assigned to and when it's due, and export it. */
export function RunPage() {
  const { runId } = useParams({ strict: false }) as { runId: string };
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const actor = useActor();
  const {
    data: run,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['checklist-runs', 'one', runId],
    queryFn: () => api<RunView>(`/checklist-runs/${runId}`),
  });
  const team = useTeam(run?.clientId, !!run?.canEdit && actor.isStaff).data ?? [];
  const [noting, setNoting] = useState<string | null>(null);
  const [note, setNote] = useState('');

  if (isLoading) return <Skeleton className="h-80" />;
  if (error || !run)
    return (
      <Card>
        <EmptyState
          icon={ListChecks}
          title="Checklist not found"
          description="It may have been deleted, or you don't have access to it."
        />
      </Card>
    );

  const saved = (next: RunView) => {
    queryClient.setQueryData(['checklist-runs', 'one', runId], next);
    void queryClient.invalidateQueries({ queryKey: ['checklist-runs'], exact: false });
  };
  const tick = async (stepId: string, done: boolean, stepNote?: string) => {
    try {
      saved(
        await api<RunView>(`/checklist-runs/${run.id}/steps/${stepId}`, {
          method: 'POST',
          body: { done, ...(stepNote !== undefined && { note: stepNote }) },
        }),
      );
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const patch = async (body: Record<string, unknown>) => {
    try {
      saved(await api<RunView>(`/checklist-runs/${run.id}`, { method: 'PATCH', body }));
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([runMarkdown(run)], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${run.title.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'checklist'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <AppLink
        to={`/clients/${run.clientId}/checklists`}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text print:hidden"
      >
        <ArrowLeft className="size-4" /> {run.clientName}
      </AppLink>
      <PageHeader
        eyebrow={run.clientName}
        title={run.title}
        description={
          <>
            Started {formatDate(run.createdAt)}
            {run.createdByName && ` by ${run.createdByName}`}.{' '}
            {run.completedAt ? `Completed ${formatDate(run.completedAt)}.` : `${run.done} of ${run.total} steps done.`}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button variant="secondary" onClick={download}>
              <Download /> Markdown
            </Button>
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer /> Print or PDF
            </Button>
            {run.canEdit && (
              <Button
                variant="ghost"
                aria-label="Delete this run"
                onClick={async () => {
                  if (!window.confirm(`Delete “${run.title}”? Its record of who did what goes with it.`)) return;
                  await api(`/checklist-runs/${run.id}`, { method: 'DELETE' });
                  await queryClient.invalidateQueries({ queryKey: ['checklist-runs'] });
                  toast('Checklist run deleted.');
                  await navigate({ to: `/clients/${run.clientId}/checklists` });
                }}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <Card>
          <ol className="divide-y divide-border">
            {run.steps.map((s, i) => (
              <li key={s.id} className="flex items-start gap-3 px-5 py-3.5">
                <input
                  type="checkbox"
                  id={`step-${s.id}`}
                  className="mt-0.5 size-5 shrink-0 rounded accent-(--primary)"
                  checked={!!s.doneAt}
                  disabled={!run.canEdit}
                  onChange={(e) => tick(s.id, e.target.checked)}
                />
                <div className="min-w-0 flex-1">
                  <label
                    htmlFor={`step-${s.id}`}
                    className={cn('block text-sm', s.doneAt && 'text-muted line-through')}
                  >
                    <span className="sr-only">Step {i + 1}: </span>
                    {s.text}
                  </label>
                  {s.doneAt && (
                    <p className="text-xs text-muted">
                      {s.doneByName ?? 'Someone'} · {formatDateTime(s.doneAt)}
                    </p>
                  )}
                  {s.note && noting !== s.id && <p className="mt-1 text-xs text-text-2">Note: {s.note}</p>}
                  {noting === s.id ? (
                    <form
                      className="mt-2 flex gap-2 print:hidden"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await tick(s.id, !!s.doneAt, note);
                        setNoting(null);
                      }}
                    >
                      <Input
                        aria-label={`Note for step ${i + 1}`}
                        value={note}
                        maxLength={1000}
                        onChange={(e) => setNote(e.target.value)}
                        autoFocus
                      />
                      <Button type="submit" size="sm">
                        Save
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setNoting(null)}>
                        Cancel
                      </Button>
                    </form>
                  ) : (
                    run.canEdit && (
                      <Button
                        variant="link"
                        className="mt-1 text-xs print:hidden"
                        onClick={() => {
                          setNote(s.note);
                          setNoting(s.id);
                        }}
                      >
                        {s.note ? 'Edit note' : 'Add a note'}
                      </Button>
                    )
                  )}
                </div>
              </li>
            ))}
          </ol>
        </Card>
        <Card className="h-fit space-y-4 p-5">
          <Progress run={run} />
          {run.canEdit && actor.isStaff ? (
            <>
              <Field label="Assigned to">
                {(p) => (
                  <Select
                    {...p}
                    value={run.assigneeId ?? ''}
                    onChange={(e) => patch({ assigneeId: e.target.value || null })}
                  >
                    <option value="">Nobody</option>
                    {run.assigneeId && !team.some((u) => u.id === run.assigneeId) && (
                      <option value={run.assigneeId}>{run.assigneeName}</option>
                    )}
                    {team.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Due">
                {(p) => (
                  <Input
                    {...p}
                    type="date"
                    value={run.dueDate ?? ''}
                    onChange={(e) => patch({ dueDate: e.target.value || null })}
                  />
                )}
              </Field>
            </>
          ) : (
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs text-muted">Assigned to</dt>
                <dd>{run.assigneeName ?? 'Nobody'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Due</dt>
                <dd>{run.dueDate ? formatDate(`${run.dueDate}T12:00:00`) : 'No date'}</dd>
              </div>
            </dl>
          )}
          {overdue(run) && <Badge tone="danger">Overdue</Badge>}
        </Card>
      </div>
    </>
  );
}
