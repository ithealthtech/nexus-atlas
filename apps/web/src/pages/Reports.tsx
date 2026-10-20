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
  AppWindow,
  FileCheck2,
  FileText,
  History,
  Handshake,
  Settings2,
  Globe,
  ListFilter,
  LockKeyhole,
  Play,
  Save,
  Search,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  MAX_REPORT_ASSET_FIELDS,
  REPORTABLE_FIELD_TYPES,
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
import { useClients, useLayouts } from '@/lib/queries';
import { DEMO } from '@/lib/demo';

const ICONS = {
  executive: ChartNoAxesCombined,
  security: LockKeyhole,
  service: Handshake,
  assets: Archive,
  licenses: ShieldCheck,
  renewals: CalendarDays,
  domains: Globe,
  documentation: FileCheck2,
  endpoints: Activity,
  software: AppWindow,
};
/** The client page each report's "open client" link goes to; reports not listed open the client's overview. */
const CLIENT_PAGE: Partial<Record<ReportKind, string>> = {
  security: '/passwords',
  assets: '/assets',
  licenses: '/licenses',
  domains: '/trackers/domains',
  documentation: '/documents',
  endpoints: '/assets',
  software: '/assets',
};
/** Reports with a time window (`withinDays`), and what the setting is called for each. */
const WINDOW_LABEL: Partial<Record<ReportKind, string>> = {
  renewals: 'Renewal lookahead',
  domains: 'Expiring within',
  service: 'Period',
};
const REPORT_SUBTITLE: Record<ReportKind, string> = {
  executive: 'Your client environment at a glance',
  security: 'Passwords, protection and encryption',
  service: 'Work done over a period',
  assets: 'Hardware, systems and infrastructure',
  licenses: 'Subscriptions, seats and assignments',
  renewals: 'Upcoming dates and overdue items',
  domains: 'Domain and certificate expiry',
  documentation: 'Coverage, ownership and review dates',
  endpoints: 'Device status and protection',
  software: 'Applications and who signs in',
};
const REPORT_STEPS = [
  { icon: Building2, title: 'Choose your scope', detail: 'One client or up to 25 workspaces.' },
  { icon: ListFilter, title: 'Focus the details', detail: 'Search, review and select columns.' },
  { icon: Download, title: 'Share your findings', detail: 'Export the current view to CSV or PDF.' },
];
const initialSelection = (): ReportSelection => ({ section: 0, query: '', attention: false });
export function Reports() {
  const { clientId } = useParams({ strict: false }) as { clientId?: string };
  return <ReportWorkspace key={clientId ?? 'all'} clientId={clientId} />;
}
/** Extra Asset inventory columns, grouped by layout. Long text is left out: it can hold notes and configuration. */
function AssetFieldPicker({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const layouts = useLayouts();
  const groups = (layouts.data ?? [])
    .filter((l) => !l.archived)
    .map((layout) => ({ layout, fields: layout.fields.filter((f) => REPORTABLE_FIELD_TYPES.includes(f.type)) }))
    .filter((g) => g.fields.length);
  return (
    <fieldset>
      <legend className="mb-1 text-[13px] font-semibold">Asset fields</legend>
      <p className="mb-2 text-xs text-muted">
        Add up to {MAX_REPORT_ASSET_FIELDS} fields as columns. Long text is never included.
        {value.length ? ` ${value.length} chosen.` : ''}
      </p>
      {layouts.isLoading && <Skeleton className="h-12" />}
      <FormError message={layouts.error?.message} />
      <div className="max-h-56 space-y-3 overflow-y-auto">
        {groups.map(({ layout, fields }) => (
          <div key={layout.id}>
            <p className="mb-1.5 text-xs font-medium text-text-2">{layout.name}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map((f) => {
                const id = `${layout.key}:${f.key}`;
                const on = value.includes(id);
                return (
                  <Checkbox
                    key={id}
                    label={f.label}
                    checked={on}
                    disabled={!on && value.length >= MAX_REPORT_ASSET_FIELDS}
                    onChange={(e) => onChange(e.currentTarget.checked ? [...value, id] : value.filter((x) => x !== id))}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
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
      <PageHeader title="Reports" description="Client insights, ready to review and share." />
      <FormError message={error} />
      {DEMO && (
        <p className="mb-4 rounded-md border border-border bg-surface p-3 text-sm text-muted">
          Report generation and PDF export require a connected Atlas server. The live application includes{' '}
          {REPORT_KINDS.length} report types, private templates, and snapshot history.
        </p>
      )}
      <div className="report-studio grid min-w-0 overflow-hidden rounded-md border border-border bg-surface xl:grid-cols-[204px_minmax(0,1fr)] 2xl:grid-cols-[204px_minmax(0,1fr)_216px]">
        <div className="min-w-0 border-b border-border bg-surface-2 xl:border-r xl:border-b-0">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Report library</h2>
            <p className="mt-1 text-xs text-muted">{REPORT_KINDS.length} built-in reports</p>
          </div>
          <div className="flex border-b border-border p-1" aria-label="Report collections">
            {(['library', 'templates', 'history'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setLibraryTab(tab)}
                aria-pressed={libraryTab === tab}
                className="min-h-9 flex-1 rounded px-1 text-xs font-medium text-muted capitalize aria-pressed:bg-surface aria-pressed:text-text"
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
                  Client reports
                </p>
                {REPORT_KINDS.map((kind) => {
                  const Icon = ICONS[kind];
                  return (
                    <button
                      key={kind}
                      onClick={() => selectKind(kind)}
                      aria-pressed={definition.kind === kind}
                      disabled={busy}
                      className="mb-1 flex w-full gap-2.5 rounded-md border border-transparent px-2.5 py-2.5 text-left text-text-2 hover:bg-surface aria-pressed:border-border aria-pressed:bg-surface aria-pressed:text-primary disabled:opacity-60"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>
                        <span className="block text-[13px] font-semibold">{REPORT_INFO[kind].name}</span>
                        <span className="mt-1 block text-[11px] leading-4 text-muted">{REPORT_SUBTITLE[kind]}</span>
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
        </div>
        <div className="min-w-0">
          <div className="min-w-0">
            <div className="border-b border-border px-5 py-5">
              <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                <ChartNoAxesCombined className="size-3.5" aria-hidden /> Report workspace
              </p>
              <h2 className="text-xl font-semibold tracking-tight">
                {run?.title ?? REPORT_INFO[definition.kind].name}
              </h2>
              <p className="mt-1.5 max-w-xl text-[13px] leading-5 text-muted">
                {REPORT_INFO[definition.kind].description}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
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
            <details
              key={run?.id ?? definition.kind}
              open={!run}
              className="report-settings border-b border-border bg-surface-2 px-5 py-3"
            >
              <summary className="cursor-pointer text-xs font-medium text-text-2">
                <Settings2 className="mr-1.5 inline size-3.5" aria-hidden />
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
                {WINDOW_LABEL[definition.kind] && (
                  <Field label={WINDOW_LABEL[definition.kind]}>
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
                            {definition.kind === 'service' ? `Last ${day} days` : `${day} days, including overdue`}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {definition.kind === 'assets' && (
                  <AssetFieldPicker
                    value={definition.assetFields ?? []}
                    onChange={(assetFields) => setDefinition({ ...definition, assetFields })}
                  />
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
          </div>
          {!run && (
            <div className="px-5 py-7">
              <h3 className="text-sm font-semibold">Ready when you are</h3>
              <p className="mt-1 text-[13px] leading-5 text-muted">
                Choose your clients and run this report to capture current records.
              </p>
              <div className="mt-6 grid gap-4 border-t border-border pt-5 sm:grid-cols-3">
                {REPORT_STEPS.map(({ icon: Icon, title, detail }) => (
                  <div key={title}>
                    <Icon className="mb-2 size-4 text-muted" aria-hidden />
                    <p className="text-xs font-medium">{title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {run && (
            <>
              <div className="grid grid-cols-3 border-b border-border">
                <button
                  aria-pressed={!selection.attention}
                  onClick={() => setSelection({ ...selection, attention: false })}
                  className="border-r border-border border-b-2 border-b-transparent px-5 py-4 text-left hover:bg-surface-2 aria-pressed:border-b-primary aria-pressed:bg-primary-soft"
                >
                  <span className="block min-h-8 text-xs text-muted sm:min-h-0">All records</span>
                  <span className="mt-1 block text-[26px] leading-none font-semibold tabular-nums">
                    {currentSection?.rows.length ?? 0}
                  </span>
                </button>
                <button
                  aria-pressed={selection.attention}
                  onClick={() => setSelection({ ...selection, attention: true })}
                  className="border-r border-border border-b-2 border-b-transparent px-5 py-4 text-left hover:bg-surface-2 aria-pressed:border-b-primary aria-pressed:bg-primary-soft"
                >
                  <span className="block min-h-8 text-xs text-muted sm:min-h-0">Needs review</span>
                  <span className="mt-1 block text-[26px] leading-none font-semibold text-warning tabular-nums">
                    {attention}
                  </span>
                </button>
                <div className="px-5 py-4">
                  <span className="block min-h-8 text-xs text-muted sm:min-h-0">Clients in scope</span>
                  <span className="mt-1 block text-[26px] leading-none font-semibold tabular-nums">
                    {run.snapshot.clients.length}
                  </span>
                </div>
              </div>
              {run.snapshot.warnings.length > 0 && (
                <div className="border-b border-border bg-warning-soft px-5 py-3">
                  <h3 className="text-sm font-semibold text-warning">Items worth reviewing</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed text-warning">
                    {run.snapshot.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="min-w-0 overflow-hidden">
                <div className="space-y-3 border-b border-border px-5 py-4">
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
                <p className="border-t border-border px-5 py-3 text-[11px] text-muted">
                  CSV and PDF include this section’s matching rows and selected columns.
                </p>
              </div>
            </>
          )}
        </div>
        <aside className="border-t border-border bg-surface-2 xl:col-span-2 2xl:col-span-1 2xl:border-t-0 2xl:border-l">
          <div className="border-b border-border p-4">
            <h2 className="mt-1 text-base font-semibold">Review & act</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Review flagged records, then open a client to take action.
            </p>
            {run && (
              <Button
                variant="secondary"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setSelection({ ...selection, attention: true })}
              >
                {attention} {attention === 1 ? 'record' : 'records'} to review
              </Button>
            )}
            <div className="mt-4 space-y-2">
              {(run?.snapshot.clients ?? clients.data?.filter((c) => definition.clientIds.includes(c.id)) ?? []).map(
                (c) => (
                  <AppLink
                    key={c.id}
                    to={`/clients/${c.id}${CLIENT_PAGE[definition.kind] ?? ''}`}
                    className="flex min-h-9 items-start gap-2 text-xs font-medium text-primary hover:underline"
                  >
                    <Building2 className="size-4 shrink-0" aria-hidden />
                    {c.name}
                  </AppLink>
                ),
              )}
            </div>
          </div>
          <div className="p-4">
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
          </div>
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
