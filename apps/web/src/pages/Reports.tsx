import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import {
  Activity,
  Archive,
  Building2,
  CalendarDays,
  CalendarClock,
  ChartColumn,
  ChartNoAxesCombined,
  Download,
  AppWindow,
  FileCheck2,
  FileText,
  GitCompare,
  History,
  Handshake,
  Settings2,
  Globe,
  Share2,
  ListFilter,
  LockKeyhole,
  PiggyBank,
  Pin,
  PinOff,
  Play,
  Presentation,
  Save,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Umbrella,
  Users,
} from 'lucide-react';
import {
  type ReportScheduleView,
  MAX_REPORT_ASSET_FIELDS,
  REPORTABLE_FIELD_TYPES,
  REPORT_INFO,
  REPORT_LINK,
  compareReportSections,
  previousReportRun,
  reportHighlights,
  reportNeedsAttention,
  selectReportSection,
  type ReportDefinition,
  type ReportKind,
  type ReportRunDetail,
  type ReportRunView,
  type ReportSelection,
  type ReportTemplateView,
  type WorkspacePrefs,
} from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { ReportShareDialog } from '@/components/ReportShare';
import { ScheduleDialog, ScheduleList } from '@/components/ReportSchedules';
import { ReportCell, ReportHighlights, figureColumns, reportBodyCell, reportHeadCell } from '@/components/ReportTable';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  Field,
  FormError,
  Input,
  ListToolbar,
  PageHeader,
  PanelHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { api, download } from '@/lib/api';
import { useClients, useLayouts, useWorkspacePrefs } from '@/lib/queries';
import { DEMO } from '@/lib/demo';
import { cn } from '@/lib/cn';

const ICONS = {
  review: Presentation,
  executive: ChartNoAxesCombined,
  security: LockKeyhole,
  insurance: Umbrella,
  service: Handshake,
  assets: Archive,
  licenses: ShieldCheck,
  savings: PiggyBank,
  renewals: CalendarDays,
  domains: Globe,
  documentation: FileCheck2,
  endpoints: Activity,
  software: AppWindow,
  accounts: Users,
  usage: ChartColumn,
};
/** Reports with a time window (`withinDays`), and what the setting is called for each. */
const WINDOW_LABEL: Partial<Record<ReportKind, string>> = {
  review: 'Period',
  renewals: 'Renewal lookahead',
  savings: 'Renewals within',
  domains: 'Expiring within',
  service: 'Period',
  usage: 'Period',
};
const REPORT_SUBTITLE: Record<ReportKind, string> = {
  review: 'A business review in one PDF',
  executive: 'Your client environment at a glance',
  security: 'Passwords, protection and encryption',
  insurance: 'What insurers ask, with evidence',
  service: 'Work done over a period',
  assets: 'Hardware, systems and infrastructure',
  licenses: 'Subscriptions, seats and assignments',
  savings: 'Unused seats and renewals, priced',
  renewals: 'Upcoming dates and overdue items',
  domains: 'Domain and certificate expiry',
  documentation: 'Coverage, ownership and review dates',
  endpoints: 'Device status and protection',
  software: 'Applications and who signs in',
  accounts: 'Accounts, sign-in status and licenses',
  usage: 'Email, Teams, OneDrive, SharePoint and apps',
};
/** The library, grouped by what each report answers, as the portal groups its reports. */
const LIBRARY: { id: string; title: string; kinds: ReportKind[] }[] = [
  { id: 'reviews', title: 'Client reviews', kinds: ['review', 'executive', 'service'] },
  { id: 'licensing', title: 'Licensing & spend', kinds: ['licenses', 'savings', 'renewals'] },
  { id: 'microsoft', title: 'Microsoft 365', kinds: ['accounts', 'usage'] },
  { id: 'security', title: 'Security & compliance', kinds: ['security', 'insurance', 'endpoints', 'software'] },
  { id: 'records', title: 'Infrastructure & documentation', kinds: ['assets', 'domains', 'documentation'] },
];
const LIBRARY_TABS = {
  library: {
    label: 'Built-in',
    title: 'Choose a report',
    description: 'Built-in reports, grouped by what they answer.',
  },
  templates: {
    label: 'Templates',
    title: 'Report templates',
    description: 'Saved report settings, private to your account.',
  },
  history: {
    label: 'History',
    title: 'Report history',
    description: 'Your latest 100 snapshots. Access is checked each time one opens.',
  },
  scheduled: { label: 'Scheduled', title: 'Scheduled reports', description: 'Reports emailed on a schedule.' },
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
  const [sharing, setSharing] = useState(false);
  // Security, insurance, endpoint, documentation, asset and license reports for this client, as one zip of PDFs.
  const [packing, setPacking] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [template, setTemplate] = useState<ReportTemplateView | null>(null);
  const [libraryTab, setLibraryTab] = useState<keyof typeof LIBRARY_TABS>('library');
  // The library folds away once a report is open, so the results lead.
  const [libraryOpen, setLibraryOpen] = useState(true);
  // A schedule being made ('new') or changed.
  const [scheduling, setScheduling] = useState<ReportScheduleView | 'new' | null>(null);
  const templates = useQuery({
    queryKey: ['report-templates'],
    queryFn: () => api<ReportTemplateView[]>('/reports/templates'),
  });
  // A pinned report opened from the dashboard arrives as ?template=, and opens set up, ready to run.
  const { template: wanted } = useSearch({ strict: false }) as { template?: string };
  // Set while rendering, once per template asked for, rather than in an effect (React's "adjusting state" pattern).
  const [opened, setOpened] = useState<string | null>(null);
  const asked = wanted && wanted !== opened ? templates.data?.find((x) => x.id === wanted) : undefined;
  if (asked) {
    setOpened(asked.id);
    setTemplate(asked);
    setDefinition(asked.definition);
    setRun(null);
  }
  const prefs = useWorkspacePrefs();
  const pinned = new Set(prefs.data?.pinnedReports ?? []);
  const pin = async (t: ReportTemplateView) => {
    try {
      const saved = await api<WorkspacePrefs>('/account/pinned-reports', {
        method: 'POST',
        body: { templateId: t.id, pinned: !pinned.has(t.id) },
      });
      qc.setQueryData(['workspace'], saved);
      toast(pinned.has(t.id) ? 'Unpinned from your dashboard.' : 'Pinned to your dashboard.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const history = useQuery({ queryKey: ['report-history'], queryFn: () => api<ReportRunView[]>('/reports/runs') });
  // The same report for the same clients, captured before this one, and (once asked for) what changed since.
  const [compare, setCompare] = useState<{ runId: string; previous: ReportRunDetail } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [changesOnly, setChangesOnly] = useState(false);
  const previous = run && history.data ? previousReportRun(history.data, run) : null;
  const against = compare && run && compare.runId === run.id ? compare.previous : null;
  const startCompare = async () => {
    if (!run || !previous) return;
    setComparing(true);
    setError(null);
    try {
      setCompare({ runId: run.id, previous: await api<ReportRunDetail>(`/reports/runs/${previous.id}`) });
      setChangesOnly(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setComparing(false);
    }
  };
  const when = (iso: string) => new Date(iso).toLocaleString();
  const highlights = useMemo(() => (run ? reportHighlights(run.snapshot) : []), [run]);
  // How many rows the search and filter leave, across every section.
  const matching = run
    ? run.snapshot.sections.reduce(
        (n, _, i) => n + selectReportSection(run.snapshot, { ...selection, section: i }).rows.length,
        0,
      )
    : 0;
  const allRows = run?.snapshot.sections.reduce((n, s) => n + s.rows.length, 0) ?? 0;
  const clientCount = (n: number) => `${n} ${n === 1 ? 'client' : 'clients'}`;
  const selectKind = (kind: ReportKind) => {
    // A review pack is for one client.
    setDefinition((d) => ({
      ...d,
      kind,
      title: REPORT_INFO[kind].name,
      clientIds: kind === 'review' ? d.clientIds.slice(0, 1) : d.clientIds,
    }));
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
      setLibraryOpen(false);
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
      setLibraryOpen(false);
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
  // The PDF is the whole report (a review pack's with its cover); a CSV is one section, as searched and filtered.
  const wholePdf = run?.kind === 'review';
  const exportReport = async (format: 'csv' | 'pdf', section = 0) => {
    if (!run) return;
    setExporting(true);
    setError(null);
    try {
      await download(
        `/reports/runs/${run.id}/export?format=${format}&selection=${encodeURIComponent(JSON.stringify({ ...selection, section }))}${format === 'pdf' ? '&whole=1' : ''}`,
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
        description="Client reports from your Atlas records and Microsoft 365, ready to review, export, and share."
        actions={
          clientId &&
          !DEMO && (
            <Button
              variant="secondary"
              size="sm"
              loading={packing}
              onClick={() => {
                setPacking(true);
                setError(null);
                download(`/reports/evidence-pack?client=${clientId}`, 'evidence-pack.zip')
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setPacking(false));
              }}
            >
              <Archive /> Evidence pack
            </Button>
          )
        }
      />
      <FormError message={error} />
      {DEMO && (
        <p className="mb-5 rounded-md border border-border bg-surface px-4 py-3 text-[13px] text-muted">
          The demo runs reports on its sample data. Exports, sharing, and schedules need a connected Atlas server.
        </p>
      )}
      <div className="space-y-5">
        <Card className="overflow-hidden">
          <PanelHeader
            eyebrow="Report library"
            title={libraryOpen ? LIBRARY_TABS[libraryTab].title : 'Report library'}
            description={
              libraryOpen
                ? LIBRARY_TABS[libraryTab].description
                : 'Pick another report, or open a template or an earlier run.'
            }
            actions={
              !libraryOpen ? (
                <Button variant="secondary" onClick={() => setLibraryOpen(true)}>
                  Change report
                </Button>
              ) : (
                <div
                  role="group"
                  aria-label="Report collections"
                  className="flex flex-wrap rounded-md border border-border bg-surface-2 p-0.5"
                >
                  {(['library', 'templates', 'history', 'scheduled'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setLibraryTab(tab)}
                      aria-pressed={libraryTab === tab}
                      className="min-h-8 rounded px-3 text-xs font-semibold text-muted hover:text-text aria-pressed:bg-surface aria-pressed:text-text aria-pressed:shadow-sm"
                    >
                      {LIBRARY_TABS[tab].label}
                    </button>
                  ))}
                </div>
              )
            }
          />
          {libraryOpen && libraryTab === 'library' && (
            <div className="space-y-6 px-[21px] py-5 max-sm:px-[18px]">
              {LIBRARY.map((group) => (
                <section key={group.title} aria-labelledby={`library-${group.id}`}>
                  <h3
                    id={`library-${group.id}`}
                    className="mb-2.5 text-[10px] font-bold tracking-[0.12em] text-muted uppercase"
                  >
                    {group.title}
                  </h3>
                  <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    {group.kinds.map((kind) => {
                      const Icon = ICONS[kind];
                      return (
                        <button
                          key={kind}
                          type="button"
                          onClick={() => selectKind(kind)}
                          aria-pressed={definition.kind === kind}
                          disabled={busy}
                          className="group flex min-h-[66px] items-center gap-3 rounded-md border border-border bg-surface px-3.5 py-3 text-left hover:border-primary/40 hover:bg-primary-soft/40 aria-pressed:border-primary aria-pressed:bg-primary-soft/60 disabled:opacity-60"
                        >
                          <span
                            aria-hidden
                            className="grid size-[34px] shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-text-2 group-aria-pressed:border-primary/30 group-aria-pressed:bg-surface group-aria-pressed:text-primary [&_svg]:size-4"
                          >
                            <Icon />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[13px] font-semibold text-text">{REPORT_INFO[kind].name}</span>
                            <span className="mt-0.5 block text-xs leading-snug text-muted">
                              {REPORT_SUBTITLE[kind]}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
          {libraryOpen && libraryTab === 'templates' && (
            <div className="divide-y divide-border">
              {templates.isLoading && <Skeleton className="m-5 h-16" />}
              <FormError message={templates.error?.message} />
              {templates.data
                ?.filter((t) => scoped(t.definition.clientIds))
                .map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-[21px] py-3 hover:bg-primary-soft/40">
                    <button
                      className="min-h-10 min-w-0 flex-1 text-left"
                      disabled={busy}
                      onClick={() => {
                        setTemplate(t);
                        setDefinition(t.definition);
                        setRun(null);
                        setSelection(initialSelection());
                        setError(null);
                      }}
                    >
                      <span className="block text-[13px] font-semibold hover:text-primary">{t.name}</span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {REPORT_INFO[t.definition.kind].name} · {clientCount(t.definition.clientIds.length)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={
                        pinned.has(t.id) ? `Unpin ${t.name} from the dashboard` : `Pin ${t.name} to the dashboard`
                      }
                      aria-pressed={pinned.has(t.id)}
                      onClick={() => void pin(t)}
                    >
                      {pinned.has(t.id) ? <PinOff /> : <Pin />}
                    </Button>
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
                <p className="px-[21px] py-10 text-center text-[13px] text-muted">
                  No saved templates yet. Set a report up, then choose Save template.
                </p>
              )}
            </div>
          )}
          {libraryOpen && libraryTab === 'scheduled' && (
            <div className="px-2 py-1">
              <ScheduleList scoped={scoped} onEdit={(s) => setScheduling(s)} />
            </div>
          )}
          {libraryOpen && libraryTab === 'history' && (
            <div className="divide-y divide-border">
              {history.isLoading && <Skeleton className="m-5 h-16" />}
              <FormError message={history.error?.message} />
              {history.data
                ?.filter((r) => scoped(r.clients.map((c) => c.id)))
                .map((r) => (
                  <div key={r.id} className="flex items-center gap-3 px-[21px] py-3 hover:bg-primary-soft/40">
                    <button
                      disabled={busy}
                      onClick={() => void openRun(r.id)}
                      className="min-h-10 min-w-0 flex-1 text-left"
                    >
                      <span className="block text-[13px] font-semibold hover:text-primary">{r.title}</span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {when(r.createdAt)} · {clientCount(r.clients.length)} · {r.rowCount.toLocaleString()}{' '}
                        {r.rowCount === 1 ? 'row' : 'rows'}
                      </span>
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
                <p className="px-[21px] py-10 text-center text-[13px] text-muted">
                  Run a report to capture your first snapshot.
                </p>
              )}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <PanelHeader
            eyebrow="Report workspace"
            title={run?.title ?? REPORT_INFO[definition.kind].name}
            description={REPORT_INFO[definition.kind].description}
            actions={
              <>
                <Button onClick={() => void generate()} loading={busy} disabled={!definition.clientIds.length}>
                  <Play />
                  {run ? 'Refresh' : 'Run report'}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !definition.clientIds.length || DEMO}
                  onClick={() => setScheduling('new')}
                >
                  <CalendarClock />
                  Schedule
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
                  disabled={!run || exporting || busy || DEMO}
                  onClick={() => void exportReport('pdf')}
                >
                  <FileText />
                  {wholePdf ? 'Review pack PDF' : 'PDF'}
                </Button>
                {/* Only a single-client snapshot can go outside Atlas. */}
                {run?.snapshot.clients.length === 1 && !DEMO && (
                  <Button variant="secondary" disabled={busy} onClick={() => setSharing(true)}>
                    <Share2 />
                    Share
                  </Button>
                )}
              </>
            }
          />
          {sharing && run && (
            <ReportShareDialog
              runId={run.id}
              title={run.title}
              client={run.snapshot.clients[0]?.name ?? ''}
              onClose={() => setSharing(false)}
            />
          )}
          <details key={run?.id ?? definition.kind} open={!run} className="report-settings">
            <summary className="flex min-h-12 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 px-[21px] py-3 text-[13px] font-semibold text-text-2 hover:bg-surface-2 max-sm:px-[18px]">
              <Settings2 className="size-4" aria-hidden />
              Report settings
              <span className="font-normal text-muted">
                · {definition.clientIds.length ? clientCount(definition.clientIds.length) : 'choose clients'}
                {WINDOW_LABEL[definition.kind] ? ` · ${definition.withinDays} days` : ''}
                {run ? ' · change, then refresh' : ''}
              </span>
            </summary>
            <div className="grid gap-6 border-t border-border bg-surface-2/60 px-[21px] py-5 max-sm:px-[18px] lg:grid-cols-2">
              <div className="space-y-4">
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
                            {definition.kind === 'service' || definition.kind === 'usage'
                              ? `Last ${day} days`
                              : definition.kind === 'savings'
                                ? `${day} days`
                                : definition.kind === 'review'
                                  ? `Last ${day} days, and renewals in the next ${day}`
                                  : `${day} days, including overdue`}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {(definition.kind === 'licenses' || definition.kind === 'savings') && (
                  <Checkbox
                    label="Include Microsoft 365 inventory through GDAP"
                    description="Linked clients are read through GDAP. Connection failures are shown as notices."
                    checked={definition.includeMicrosoft}
                    onChange={(e) => setDefinition({ ...definition, includeMicrosoft: e.currentTarget.checked })}
                  />
                )}
                {definition.kind === 'assets' && (
                  <AssetFieldPicker
                    value={definition.assetFields ?? []}
                    onChange={(assetFields) => setDefinition({ ...definition, assetFields })}
                  />
                )}
              </div>
              <fieldset className="min-w-0">
                <legend className="mb-2 text-[13px] font-semibold">
                  {definition.kind === 'review' ? 'Client' : `Clients ${clientId ? '' : '(up to 25)'}`}
                </legend>
                {clients.isLoading && <Skeleton className="h-12" />}
                <FormError message={clients.error?.message} />
                <div className="grid max-h-64 gap-x-4 gap-y-3 overflow-y-auto rounded-md border border-border bg-surface p-3.5 sm:grid-cols-2">
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
                            // A review pack is for one client: choosing another replaces it.
                            clientIds: e.currentTarget.checked
                              ? definition.kind === 'review'
                                ? [c.id]
                                : [...definition.clientIds, c.id]
                              : definition.clientIds.filter((id) => id !== c.id),
                          })
                        }
                      />
                    ))}
                </div>
              </fieldset>
            </div>
          </details>
          {!run && (
            <div className="border-t border-border px-[21px] py-7 max-sm:px-[18px]">
              <h3 className="text-sm font-semibold">Ready when you are</h3>
              <p className="mt-1 text-[13px] text-muted">
                Choose your clients and run this report to capture their records as they are now.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                {REPORT_STEPS.map(({ icon: Icon, title, detail }) => (
                  <div key={title} className="rounded-md border border-border bg-surface-2/60 px-4 py-3.5">
                    <Icon className="mb-2.5 size-4 text-primary" aria-hidden />
                    <p className="text-[13px] font-semibold">{title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>

        {run && (
          <>
            <Card className="overflow-hidden">
              <PanelHeader
                eyebrow="Summary"
                title="At a glance"
                description={`Captured ${when(run.snapshot.generatedAt)} by ${run.snapshot.generatedBy} · ${clientCount(run.snapshot.clients.length)}`}
                actions={
                  previous && !against ? (
                    <Button size="sm" variant="secondary" loading={comparing} onClick={() => void startCompare()}>
                      <GitCompare /> Compare with {when(previous.createdAt)}
                    </Button>
                  ) : undefined
                }
              />
              <ReportHighlights
                items={highlights}
                pressed={selection.attention ? 'Needs review' : undefined}
                onPress={{ 'Needs review': () => setSelection({ ...selection, attention: !selection.attention }) }}
              />
              {run.snapshot.warnings.length > 0 && (
                <ul className="space-y-2 border-b border-border px-[21px] py-4 max-sm:px-[18px]">
                  {run.snapshot.warnings.map((w, i) => (
                    <li
                      key={i}
                      className="flex gap-2.5 rounded-md border border-warning/30 bg-warning-soft px-3.5 py-2.5 text-xs leading-5 text-warning"
                    >
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
              <ListToolbar
                query={selection.query}
                onQuery={(query) => setSelection({ ...selection, query })}
                placeholder="Search the whole report"
                shown={matching}
                total={allRows}
                noun="row"
              >
                <Checkbox
                  label="Needs review only"
                  checked={selection.attention}
                  onChange={(e) => setSelection({ ...selection, attention: e.currentTarget.checked })}
                />
              </ListToolbar>
              {against && (
                <div
                  className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border bg-primary-soft/40 px-[21px] py-3 text-xs max-sm:px-[18px]"
                  role="status"
                >
                  <p className="font-semibold">Compared with {when(against.snapshot.generatedAt)}</p>
                  <Checkbox
                    label="Changes only"
                    checked={changesOnly}
                    onChange={(e) => setChangesOnly(e.currentTarget.checked)}
                  />
                  <Button size="sm" variant="ghost" onClick={() => setCompare(null)}>
                    Stop comparing
                  </Button>
                </div>
              )}
              {run.snapshot.sources.length > 0 && (
                <p className="px-[21px] py-3 text-[11px] leading-5 text-muted max-sm:px-[18px]">
                  <History className="mr-1.5 inline size-3.5 align-[-2px]" aria-hidden />
                  {run.snapshot.sources
                    .map(
                      (source) => `${source.name}, ${source.updatedAt ? `read ${when(source.updatedAt)}` : 'no data'}`,
                    )
                    .join(' · ')}
                </p>
              )}
            </Card>
            {run.snapshot.sections.map((section, index) => (
              <SectionTable
                key={`${run.id}-${index}`}
                snapshot={run.snapshot}
                index={index}
                selection={selection}
                previous={against?.snapshot ?? null}
                changesOnly={changesOnly}
                exporting={exporting || busy}
                onCsv={() => void exportReport('csv', index)}
              />
            ))}
          </>
        )}
      </div>
      {scheduling && (
        <ScheduleDialog
          definition={definition}
          schedule={scheduling === 'new' ? undefined : scheduling}
          onClose={() => setScheduling(null)}
        />
      )}
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

/** One section of a report: its own card and table, all rows at once (up to 500), searched and filtered with the rest. */
function SectionTable({
  snapshot,
  index,
  selection,
  previous,
  changesOnly,
  exporting,
  onCsv,
}: {
  snapshot: ReportRunDetail['snapshot'];
  index: number;
  selection: ReportSelection;
  previous: ReportRunDetail['snapshot'] | null;
  changesOnly: boolean;
  exporting: boolean;
  onCsv: () => void;
}) {
  const section = snapshot.sections[index]!;
  const visible = selectReportSection(snapshot, { ...selection, section: index });
  // Against the earlier run's section with the same name.
  const before = previous?.sections.find((s) => s.title === section.title);
  const diff = before ? compareReportSections(before, section) : null;
  const added = new Set(diff?.added);
  const changed = new Map(diff?.changed.map((c) => [c.index, c]));
  const rows = visible.rows
    .map((row, i) => ({ row, index: visible.indexes[i]! }))
    .filter(({ index: at }) => !diff || !changesOnly || added.has(at) || changed.has(at));
  const figures = figureColumns(section.columns, section.rows);
  const when = (iso: string) => new Date(iso).toLocaleString();
  // A row's name opens its record; a client's name in the first column opens the client.
  const clientIds = new Map(snapshot.clients.map((c) => [c.name, c.id]));
  const linkFor = (at: number, j: number, value: string) => {
    if (j === 1) {
      const link = section.links?.[at];
      return link && REPORT_LINK.test(link) ? link : null;
    }
    const client = j === 0 && section.columns[0] === 'Client' ? clientIds.get(value) : undefined;
    return client ? `/clients/${client}` : null;
  };
  return (
    <Card className="overflow-hidden">
      <PanelHeader
        eyebrow={section.part}
        title={section.title}
        description={
          `${rows.length.toLocaleString()} of ${section.rows.length.toLocaleString()} ${section.rows.length === 1 ? 'row' : 'rows'}` +
          (diff ? ` · ${diff.added.length} new, ${diff.changed.length} changed, ${diff.removed.length} removed` : '')
        }
        actions={
          <Button size="sm" variant="secondary" disabled={exporting || DEMO || !rows.length} onClick={onCsv}>
            <Download /> CSV
          </Button>
        }
      />
      {rows.length > 0 && (
        <div className="max-h-[70vh] overflow-auto" role="region" aria-label={section.title} tabIndex={0}>
          <table className="w-full border-separate border-spacing-0 text-left">
            <thead className="sticky top-0 z-[1]">
              <tr>
                {section.columns.map((c, i) => (
                  <th key={i} scope="col" className={cn(reportHeadCell, figures.has(i) && 'text-right')}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map(({ row, index: at }) => {
                const isNew = added.has(at);
                const change = changed.get(at);
                const flagged = reportNeedsAttention(section, section.rows[at]!);
                return (
                  <tr key={at} className={cn('group hover:bg-primary-soft/40', isNew && 'bg-success-soft')}>
                    {row.map((_, j) => {
                      const moved = !!change?.columns.includes(j);
                      return (
                        <td
                          key={j}
                          className={cn(
                            reportBodyCell,
                            'max-w-80 min-w-28 border-b border-border break-words group-last:border-b-0',
                            j === 0 && 'min-w-44 font-semibold',
                            // A row that needs review carries an amber edge.
                            j === 0 && flagged && 'shadow-[inset_3px_0_0_var(--warning)]',
                            figures.has(j) && 'text-right whitespace-nowrap tabular-nums',
                            moved && 'bg-warning-soft',
                          )}
                        >
                          {j === 0 && isNew && (
                            <Badge tone="success" className="mr-1.5">
                              New
                            </Badge>
                          )}
                          {linkFor(at, j, row[j] ?? '') ? (
                            <AppLink
                              to={linkFor(at, j, row[j] ?? '')!}
                              className={cn(
                                'underline-offset-2 hover:underline',
                                j === 1 && 'font-medium text-primary',
                              )}
                            >
                              <ReportCell columns={section.columns} row={row} index={j} />
                            </AppLink>
                          ) : (
                            <ReportCell columns={section.columns} row={row} index={j} />
                          )}
                          {moved && (
                            <span className="mt-0.5 block text-[11px] text-muted">
                              <span className="sr-only">Previously </span>
                              <span className="line-through">{change!.previous[j] || '—'}</span>
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!rows.length && (
        <p className="px-[21px] py-6 text-[13px] text-muted max-sm:px-[18px]">
          {!section.rows.length
            ? 'Nothing to list.'
            : diff && changesOnly
              ? 'Nothing new or changed.'
              : selection.attention
                ? 'Nothing here needs review.'
                : 'No rows match the search.'}
        </p>
      )}
      {rows.length > 500 && (
        <p className="border-t border-border px-[21px] py-3 text-[11px] text-muted max-sm:px-[18px]">
          Showing the first 500 of {rows.length.toLocaleString()} rows. The CSV has them all.
        </p>
      )}
      {diff && diff.removed.length > 0 && (
        <details className="border-t border-border px-[21px] py-3">
          <summary className="cursor-pointer text-xs font-semibold">
            {diff.removed.length} removed since {previous && when(previous.generatedAt)}
          </summary>
          <table className="mt-2 w-full text-left text-xs text-muted">
            <tbody>
              {diff.removed.slice(0, 200).map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {row.map((value, j) => (
                    <td key={j} className="max-w-64 px-4 py-2 align-top break-words line-through">
                      {value || '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Card>
  );
}
