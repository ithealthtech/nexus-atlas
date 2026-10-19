import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import {
  Activity,
  Archive,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Download,
  FileCheck2,
  FileText,
  History,
  ListFilter,
  Play,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  REPORT_INFO,
  REPORT_KINDS,
  reportNeedsAttention,
  selectReportSection,
  type ReportDefinition,
  type ReportKind,
  type ReportRunDetail,
  type ReportRunView,
  type ReportSelection,
  type ReportTemplateView,
} from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { api, download } from '@/lib/api';
import { useClients } from '@/lib/queries';
import { DEMO } from '@/lib/demo';

const ICONS = {
  executive: ChartNoAxesCombined,
  assets: Archive,
  licenses: ShieldCheck,
  renewals: CalendarDays,
  documentation: FileCheck2,
  endpoints: Activity,
};
const initialSelection = (): ReportSelection => ({ section: 0, query: '', attention: false });
export function Reports() {
  const { clientId } = useParams({ strict: false }) as { clientId?: string };
  return <ReportWorkspace key={clientId ?? 'all'} clientId={clientId} />;
}
function ReportWorkspace({ clientId }: { clientId?: string }) {
  const clients = useClients();
  const qc = useQueryClient();
  const toast = useToast();
  const [definition, setDefinition] = useState<ReportDefinition>({
    kind: 'executive',
    title: REPORT_INFO.executive.name,
    clientIds: clientId ? [clientId] : [],
    withinDays: 90,
    includeMicrosoft: true,
  });
  const [run, setRun] = useState<ReportRunDetail | null>(null);
  const [selection, setSelection] = useState<ReportSelection>(initialSelection);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [template, setTemplate] = useState<ReportTemplateView | null>(null);
  const [libraryTab, setLibraryTab] = useState<'library' | 'templates' | 'history'>('library');
  const templates = useQuery({
    queryKey: ['report-templates'],
    queryFn: () => api<ReportTemplateView[]>('/reports/templates'),
  });
  const history = useQuery({ queryKey: ['report-history'], queryFn: () => api<ReportRunView[]>('/reports/runs') });
  const currentSection = run?.snapshot.sections[selection.section];
  const visible = run ? selectReportSection(run.snapshot, selection) : null;
  const attention = currentSection?.rows.filter((row) => reportNeedsAttention(currentSection, row)).length ?? 0;
  const selectKind = (kind: ReportKind) => {
    setDefinition((d) => ({ ...d, kind, title: REPORT_INFO[kind].name }));
    setRun(null);
    setTemplate(null);
    setSelection(initialSelection());
    setError(null);
  };
  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ReportRunDetail>('/reports/runs', { method: 'POST', body: definition });
      setRun(result);
      setSelection(initialSelection());
      void qc.invalidateQueries({ queryKey: ['report-history'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openRun = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ReportRunDetail>(`/reports/runs/${id}`);
      setRun(result);
      setDefinition(result.snapshot.definition);
      setTemplate(null);
      setSelection(initialSelection());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const saveTemplate = async (copy = false) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<ReportTemplateView>(`/reports/templates${template && !copy ? `/${template.id}` : ''}`, {
        method: template && !copy ? 'PUT' : 'POST',
        body: { name: templateName, definition, ...(template && !copy ? { version: template.version } : {}) },
      });
      setTemplate(result);
      setSaving(false);
      toast('Report template saved.');
      void qc.invalidateQueries({ queryKey: ['report-templates'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (path: string, body?: unknown) => {
    try {
      await api(path, { method: 'DELETE', body });
      void qc.invalidateQueries({ queryKey: ['report-templates'] });
      void qc.invalidateQueries({ queryKey: ['report-history'] });
      toast('Removed.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const exportReport = async (format: 'csv' | 'pdf') => {
    if (!run) return;
    setExporting(true);
    setError(null);
    try {
      await download(
        `/reports/runs/${run.id}/export?format=${format}&selection=${encodeURIComponent(JSON.stringify(selection))}`,
        `atlas-report.${format}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  };
  const scoped = (ids: string[]) => !clientId || (ids.length === 1 && ids[0] === clientId);
  return (
    <>
      <PageHeader
        eyebrow="Insights & reporting"
        title="Reports"
        description="Turn client records into clear, actionable reports. Capture a snapshot, review the details, and export your selection."
      />
      <FormError message={error} />
      {DEMO && (
        <p className="mb-4 rounded-md border border-border bg-surface p-3 text-sm text-muted">
          Report generation and PDF export require a connected Atlas server. The live application includes six report
          types, private templates, and snapshot history.
        </p>
      )}
      <div className="mt-4 grid min-w-0 items-start gap-4 xl:grid-cols-[210px_minmax(0,1fr)] 2xl:grid-cols-[220px_minmax(0,1fr)_230px]">
        <Card className="min-w-0 overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Report library</h2>
            <p className="mt-1 text-xs text-muted">Choose what to review</p>
          </div>
          <div className="flex border-b border-border p-1" aria-label="Report collections">
            {(['library', 'templates', 'history'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setLibraryTab(tab)}
                aria-pressed={libraryTab === tab}
                className="min-h-9 flex-1 rounded px-1 text-xs font-medium text-muted capitalize aria-pressed:bg-primary-soft aria-pressed:text-primary"
              >
                {tab === 'library' ? 'Built-in' : tab}
              </button>
            ))}
          </div>
          {libraryTab === 'library' && (
            <div className="p-2">
              <label className="block p-2 xl:hidden">
                <span className="mb-2 block text-xs font-semibold">Choose report</span>
                <Select
                  value={definition.kind}
                  onChange={(e) => selectKind(e.target.value as ReportKind)}
                  disabled={busy}
                >
                  {REPORT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {REPORT_INFO[kind].name}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="hidden xl:block">
                <p className="px-2 py-2 text-[10px] font-semibold tracking-wider text-muted uppercase">
                  Client intelligence
                </p>
                {REPORT_KINDS.map((kind) => {
                  const Icon = ICONS[kind];
                  return (
                    <button
                      key={kind}
                      onClick={() => selectKind(kind)}
                      aria-pressed={definition.kind === kind}
                      disabled={busy}
                      className="mb-1 flex w-full gap-2.5 rounded-md px-2 py-3 text-left hover:bg-surface-2 aria-pressed:bg-primary-soft aria-pressed:text-primary disabled:opacity-60"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>
                        <span className="block text-[13px] font-semibold">{REPORT_INFO[kind].name}</span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted">
                          {REPORT_INFO[kind].description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {libraryTab === 'templates' && (
            <div className="space-y-2 p-3">
              <p className="text-xs text-muted">Private to your account.</p>
              {templates.isLoading && <Skeleton className="h-20" />}
              <FormError message={templates.error?.message} />
              {templates.data
                ?.filter((t) => scoped(t.definition.clientIds))
                .map((t) => (
                  <div key={t.id} className="flex items-start gap-1 border-b border-border pb-2">
                    <button
                      className="min-h-9 min-w-0 flex-1 text-left text-sm font-medium hover:text-primary"
                      disabled={busy}
                      onClick={() => {
                        setTemplate(t);
                        setDefinition(t.definition);
                        setRun(null);
                        setSelection(initialSelection());
                        setError(null);
                      }}
                    >
                      {t.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete template ${t.name}`}
                      onClick={() => void remove(`/reports/templates/${t.id}`, { version: t.version })}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              {!templates.isLoading && !templates.data?.some((t) => scoped(t.definition.clientIds)) && (
                <p className="py-3 text-sm text-muted">No saved templates yet.</p>
              )}
            </div>
          )}
          {libraryTab === 'history' && (
            <div className="space-y-2 p-3">
              <p className="text-xs text-muted">Your latest 100 snapshots. Access is checked each time.</p>
              {history.isLoading && <Skeleton className="h-20" />}
              <FormError message={history.error?.message} />
              {history.data
                ?.filter((r) => scoped(r.clients.map((c) => c.id)))
                .map((r) => (
                  <div key={r.id} className="flex items-start gap-1 border-b border-border pb-2">
                    <button
                      disabled={busy}
                      onClick={() => void openRun(r.id)}
                      className="min-h-9 min-w-0 flex-1 text-left"
                    >
                      <span className="block text-sm font-medium hover:text-primary">{r.title}</span>
                      <span className="mt-1 block text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete report ${r.title}`}
                      onClick={() => {
                        if (run?.id === r.id) setRun(null);
                        void remove(`/reports/runs/${r.id}`);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              {!history.isLoading && !history.data?.some((r) => scoped(r.clients.map((c) => c.id))) && (
                <p className="py-3 text-sm text-muted">Run a report to capture your first snapshot.</p>
              )}
            </div>
          )}
        </Card>
        <div className="min-w-0 space-y-4">
          <Card className="min-w-0">
            <div className="border-b border-border p-4">
              <p className="text-[10px] font-semibold tracking-wider text-muted uppercase">Report workspace</p>
              <h2 className="mt-1 text-lg font-semibold">{run?.title ?? REPORT_INFO[definition.kind].name}</h2>
              <p className="mt-1 text-sm text-muted">{REPORT_INFO[definition.kind].description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => void generate()} loading={busy} disabled={!definition.clientIds.length || DEMO}>
                  <Play />
                  {run ? 'Refresh report' : 'Run report'}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !definition.clientIds.length || DEMO}
                  onClick={() => {
                    setTemplateName(template?.name ?? definition.title);
                    setSaving(true);
                  }}
                >
                  <Save />
                  Save template
                </Button>
                <Button
                  variant="secondary"
                  disabled={!run || exporting || busy}
                  onClick={() => void exportReport('csv')}
                >
                  <Download />
                  CSV
                </Button>
                <Button
                  variant="secondary"
                  disabled={!run || exporting || busy}
                  onClick={() => void exportReport('pdf')}
                >
                  <FileText />
                  PDF
                </Button>
              </div>
            </div>
            <details key={run?.id ?? definition.kind} open={!run} className="p-4">
              <summary className="cursor-pointer text-sm font-semibold">
                Report settings{run ? ' · change settings, then refresh' : ''}
              </summary>
              <div className="mt-4 space-y-4">
                <Field label="Report title">
                  {(p) => (
                    <Input
                      {...p}
                      value={definition.title}
                      maxLength={120}
                      onChange={(e) => setDefinition({ ...definition, title: e.target.value })}
                    />
                  )}
                </Field>
                <fieldset>
                  <legend className="mb-2 text-[13px] font-semibold">Clients {clientId ? '' : '(up to 25)'}</legend>
                  {clients.isLoading && <Skeleton className="h-12" />}
                  <FormError message={clients.error?.message} />
                  <div className="grid max-h-44 gap-3 overflow-y-auto sm:grid-cols-2">
                    {clients.data
                      ?.filter((c) => !clientId || c.id === clientId)
                      .map((c) => (
                        <Checkbox
                          key={c.id}
                          label={c.name}
                          checked={definition.clientIds.includes(c.id)}
                          disabled={
                            !!clientId || (definition.clientIds.length >= 25 && !definition.clientIds.includes(c.id))
                          }
                          onChange={(e) =>
                            setDefinition({
                              ...definition,
                              clientIds: e.currentTarget.checked
                                ? [...definition.clientIds, c.id]
                                : definition.clientIds.filter((id) => id !== c.id),
                            })
                          }
                        />
                      ))}
                  </div>
                </fieldset>
                {definition.kind === 'renewals' && (
                  <Field label="Renewal lookahead">
                    {(p) => (
                      <Select
                        {...p}
                        value={definition.withinDays}
                        onChange={(e) =>
                          setDefinition({
                            ...definition,
                            withinDays: Number(e.target.value) as ReportDefinition['withinDays'],
                          })
                        }
                      >
                        {[30, 60, 90, 180, 365].map((day) => (
                          <option key={day} value={day}>
                            {day} days, including overdue
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {definition.kind === 'licenses' && (
                  <Checkbox
                    label="Include Microsoft 365 inventory through GDAP"
                    description="Linked clients are read through GDAP. Connection failures are shown as notices."
                    checked={definition.includeMicrosoft}
                    onChange={(e) => setDefinition({ ...definition, includeMicrosoft: e.currentTarget.checked })}
                  />
                )}
              </div>
            </details>
          </Card>
          {!run && (
            <Card className="px-5 py-12 text-center">
              <ChartNoAxesCombined className="mx-auto mb-3 size-7 text-primary" aria-hidden />
              <h3 className="text-sm font-semibold">Ready when you are</h3>
              <p className="mt-2 text-sm text-muted">
                Choose your clients and run this report to capture current records.
              </p>
            </Card>
          )}
          {run && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <button
                  aria-pressed={!selection.attention}
                  onClick={() => setSelection({ ...selection, attention: false })}
                  className="rounded-md border border-border bg-surface p-4 text-left aria-pressed:border-primary"
                >
                  <span className="text-xs text-muted">All records</span>
                  <span className="mt-2 block text-2xl font-semibold tabular-nums">
                    {currentSection?.rows.length ?? 0}
                  </span>
                </button>
                <button
                  aria-pressed={selection.attention}
                  onClick={() => setSelection({ ...selection, attention: true })}
                  className="rounded-md border border-border bg-surface p-4 text-left aria-pressed:border-primary"
                >
                  <span className="text-xs text-muted">Needs review</span>
                  <span className="mt-2 block text-2xl font-semibold text-warning tabular-nums">{attention}</span>
                </button>
              </div>
              {run.snapshot.warnings.length > 0 && (
                <div className="rounded-md border border-border bg-warning-soft p-4">
                  <h3 className="text-sm font-semibold text-warning">Items worth reviewing</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-warning">
                    {run.snapshot.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Card className="min-w-0 overflow-hidden">
                <div className="space-y-3 border-b border-border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">Detailed results</h3>
                    <Badge>{visible?.rows.length ?? 0} matching rows</Badge>
                  </div>
                  <p className="text-xs text-muted">
                    Captured {new Date(run.snapshot.generatedAt).toLocaleString()} · {run.snapshot.generatedBy}
                  </p>
                  {run.snapshot.sections.length > 1 && (
                    <Field label="Report section">
                      {(p) => (
                        <Select
                          {...p}
                          value={selection.section}
                          onChange={(e) => setSelection({ ...initialSelection(), section: Number(e.target.value) })}
                        >
                          {run.snapshot.sections.map((s, i) => (
                            <option key={i} value={i}>
                              {s.title}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  )}
                  <div className="relative">
                    <Search className="absolute top-2.5 left-3 size-4 text-muted" aria-hidden />
                    <Input
                      aria-label="Search report results"
                      placeholder="Search report results"
                      className="pl-9"
                      value={selection.query}
                      onChange={(e) => setSelection({ ...selection, query: e.target.value })}
                      maxLength={200}
                    />
                  </div>
                  <details>
                    <summary className="cursor-pointer text-xs font-semibold">
                      <ListFilter className="mr-1 inline size-3.5" aria-hidden />
                      Filters & columns
                    </summary>
                    <div className="mt-3 space-y-3">
                      <Field label="Search field">
                        {(p) => (
                          <Select
                            {...p}
                            value={selection.field ?? 'all'}
                            onChange={(e) =>
                              setSelection({
                                ...selection,
                                field: e.target.value === 'all' ? undefined : Number(e.target.value),
                              })
                            }
                          >
                            <option value="all">All columns</option>
                            {currentSection?.columns.map((c, i) => (
                              <option key={i} value={i}>
                                {c}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <fieldset>
                        <legend className="mb-2 text-xs font-semibold">Visible columns</legend>
                        <div className="grid gap-3 sm:grid-cols-2">
                          {currentSection?.columns.map((c, i) => {
                            const selected = selection.columns ?? currentSection.columns.map((_, index) => index);
                            return (
                              <Checkbox
                                key={i}
                                label={c}
                                checked={selected.includes(i)}
                                disabled={selected.length === 1 && selected.includes(i)}
                                onChange={(e) =>
                                  setSelection({
                                    ...selection,
                                    columns: e.currentTarget.checked
                                      ? [...selected, i].sort((a, b) => a - b)
                                      : selected.filter((index) => index !== i),
                                  })
                                }
                              />
                            );
                          })}
                        </div>
                      </fieldset>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setSelection({ ...initialSelection(), section: selection.section })}
                      >
                        Reset filters
                      </Button>
                    </div>
                  </details>
                  <p className="text-xs text-muted">
                    CSV and PDF include this section’s matching rows and selected columns.
                  </p>
                </div>
                <div className="max-h-[600px] overflow-auto" role="region" aria-label="Report results" tabIndex={0}>
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-surface-2">
                      <tr>
                        {visible?.columns.map((c, i) => (
                          <th
                            key={i}
                            scope="col"
                            className="border-b border-border px-4 py-3 font-semibold whitespace-nowrap"
                          >
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visible?.rows.slice(0, 500).map((row, i) => (
                        <tr key={i} className="border-b border-border last:border-0 hover:bg-surface-2">
                          {row.map((value, j) => (
                            <td key={j} className="max-w-64 min-w-28 px-4 py-3 align-top break-words">
                              {value || '—'}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!visible?.rows.length && (
                    <p className="p-8 text-center text-sm text-muted">No rows match this selection.</p>
                  )}
                </div>
                {visible && visible.rows.length > 500 && (
                  <p className="border-t border-border p-3 text-xs text-muted">
                    Showing the first 500 matching rows. Exports contain all {visible.rows.length} matching rows. Filter
                    to narrow the view; PDF supports up to 2,000 rows.
                  </p>
                )}
              </Card>
            </>
          )}
        </div>
        <aside className="space-y-4 xl:col-start-2 2xl:col-start-auto">
          <Card className="p-4">
            <p className="text-[10px] font-semibold tracking-wider text-muted uppercase">Next actions</p>
            <h2 className="mt-1 text-base font-semibold">Review & act</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Use the metrics to focus on records needing attention. Open the client workspace to make changes.
            </p>
            {run && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setSelection({ ...selection, attention: true })}
              >
                {attention} records to review
              </Button>
            )}
            <div className="mt-4 space-y-2">
              {(run?.snapshot.clients ?? clients.data?.filter((c) => definition.clientIds.includes(c.id)) ?? []).map(
                (c) => (
                  <AppLink
                    key={c.id}
                    to={`/clients/${c.id}${definition.kind === 'licenses' ? '/licenses' : definition.kind === 'documentation' ? '/documents' : definition.kind === 'assets' || definition.kind === 'endpoints' ? '/assets' : ''}`}
                    className="flex min-h-9 items-start gap-2 text-xs font-medium text-primary hover:underline"
                  >
                    <Building2 className="size-4 shrink-0" aria-hidden />
                    {c.name}
                  </AppLink>
                ),
              )}
            </div>
          </Card>
          <Card className="p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <History className="size-4" aria-hidden />
              Snapshot & sources
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Reports capture available records at a point in time. Refresh creates a new snapshot in your private
              history.
            </p>
            {run?.snapshot.sources.map((source, i) => (
              <div key={i} className="mt-3 border-t border-border pt-3">
                <p className="text-xs font-semibold">{source.name}</p>
                <p className="mt-1 text-xs text-muted">
                  {source.updatedAt ? new Date(source.updatedAt).toLocaleString() : 'No data available'}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted">{source.detail}</p>
              </div>
            ))}
          </Card>
        </aside>
      </div>
      <Dialog
        open={saving}
        onClose={() => setSaving(false)}
        title={template ? 'Update report template' : 'Save report template'}
        description="Private to your account. Stores report settings; run the template to capture fresh data."
        footer={
          <>
            {template && (
              <Button
                variant="secondary"
                disabled={busy || !templateName.trim()}
                onClick={() => void saveTemplate(true)}
              >
                Save a copy
              </Button>
            )}
            <Button loading={busy} disabled={!templateName.trim()} onClick={() => void saveTemplate()}>
              <Save />
              {template ? 'Update template' : 'Save template'}
            </Button>
          </>
        }
      >
        <Field label="Template name">
          {(p) => (
            <Input {...p} value={templateName} onChange={(e) => setTemplateName(e.target.value)} maxLength={120} />
          )}
        </Field>
        <FormError message={error} />
      </Dialog>
    </>
  );
}
