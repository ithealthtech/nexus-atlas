import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CloudDownload, FileSpreadsheet, History, Info, Unplug, Upload } from 'lucide-react';
import type { CsvImportResult, CsvTarget, HuduPreview, ImportJobView } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { parseCsv } from '@/lib/csv';
import { useLayouts } from '@/lib/queries';
import { formatDateTime } from '@/lib/format';

const KIND_LABELS: Record<string, string> = {
  clients: 'Clients',
  locations: 'Locations',
  contacts: 'Contacts',
  layouts: 'Asset layouts',
  assets: 'Assets',
  documents: 'Documents',
  passwords: 'Passwords',
  users: 'People',
  links: 'Links',
};

function JobSummary({ job }: { job: ImportJobView }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={job.status === 'done' ? 'success' : job.status === 'failed' ? 'danger' : 'info'}>
          {job.status === 'running' ? 'Importing…' : job.status === 'done' ? 'Finished' : 'Stopped'}
        </Badge>
        <span className="text-muted">
          {job.source === 'hudu' ? 'Hudu' : job.source === 'legacy' ? 'Atlas 0.2' : 'CSV'} · started by{' '}
          {job.startedByName} {formatDateTime(job.createdAt)}
        </span>
      </div>
      {Object.keys(job.counts).length > 0 && (
        <div className="relative overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm tabular-nums">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">New</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium">Skipped</th>
                <th className="px-3 py-2 font-medium">Failed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {Object.entries(job.counts).map(([kind, c]) => (
                <tr key={kind}>
                  <td className="px-3 py-2 font-medium">{KIND_LABELS[kind] ?? kind}</td>
                  <td className="px-3 py-2">{c.created}</td>
                  <td className="px-3 py-2">{c.updated}</td>
                  <td className="px-3 py-2">{c.skipped}</td>
                  <td className={c.failed ? 'px-3 py-2 font-semibold text-danger' : 'px-3 py-2'}>{c.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {job.messages.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">
            {job.messages.length} note{job.messages.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-2 max-h-56 list-disc space-y-1 overflow-y-auto pl-5 text-text-2">
            {job.messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function HuduImport() {
  const toast = useToast();
  const client = useQueryClient();
  const connection = useQuery({
    queryKey: ['hudu'],
    queryFn: () => api<{ url: string; hasKey: boolean }>('/import/hudu'),
  });
  const [preview, setPreview] = useState<HuduPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const job = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api<ImportJobView>(`/import/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });
  useEffect(() => {
    if (job.data && job.data.status !== 'running') void client.invalidateQueries({ queryKey: ['import-jobs'] });
  }, [job.data, client]);

  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const apiKey = String(form.get('apiKey') ?? '');
    return act('save', async () => {
      await api('/import/hudu', { method: 'PUT', body: { url: form.get('url'), ...(apiKey ? { apiKey } : {}) } });
      await connection.refetch();
      setPreview(null);
      toast('Hudu connected. Check what will be imported next.');
    });
  };
  const connected = connection.data?.hasKey;
  return (
    <Card>
      <CardHeader
        title="Import from Hudu"
        description="Companies, addresses, asset layouts and assets, articles, and passwords. Running it again updates what it imported before."
      />
      <div className="space-y-5 p-5">
        {connection.isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          <form onSubmit={save} className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
            <Field label="Hudu address">
              {(p) => (
                <Input
                  {...p}
                  name="url"
                  type="url"
                  defaultValue={connection.data?.url}
                  placeholder="https://yourcompany.huducloud.com"
                  required
                />
              )}
            </Field>
            <Field
              label="API key"
              help={connected ? 'Saved and encrypted. Leave empty to keep it.' : 'Hudu → Admin → API Keys'}
            >
              {(p) => (
                <Input
                  {...p}
                  name="apiKey"
                  type="password"
                  autoComplete="off"
                  placeholder={connected ? '••••••••' : ''}
                />
              )}
            </Field>
            <Button type="submit" variant="secondary" loading={busy === 'save'}>
              {connected ? 'Update' : 'Connect'}
            </Button>
          </form>
        )}
        {connected && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              loading={busy === 'preview'}
              onClick={() =>
                act('preview', async () =>
                  setPreview(await api<HuduPreview>('/import/hudu/preview', { method: 'POST', body: {} })),
                )
              }
            >
              <CloudDownload /> Check what will be imported
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                act('forget', async () => {
                  await api('/import/hudu', { method: 'DELETE' });
                  setPreview(null);
                  await connection.refetch();
                  toast('Hudu disconnected. The API key was deleted from Atlas.');
                })
              }
            >
              <Unplug /> Disconnect
            </Button>
          </div>
        )}
        {preview && (
          <div className="rounded-xl border border-border bg-surface-2 p-4">
            <p className="text-sm font-semibold">Found in Hudu (archived items are left out)</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
              {(
                [
                  ['Companies', preview.companies],
                  ['Asset layouts', preview.assetLayouts],
                  ['Assets', preview.assets],
                  ['Articles', preview.articles],
                  ['Passwords', preview.passwords],
                ] as const
              ).map(([label, n]) => (
                <div key={label}>
                  <dt className="text-xs text-muted">{label}</dt>
                  <dd className="text-xl font-semibold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-muted">
              Companies become clients. Passwords go into each client&rsquo;s password list (folders are flattened).
              Password-type asset fields are not copied into assets.
            </p>
            <Button
              className="mt-4"
              loading={busy === 'run'}
              disabled={job.data?.status === 'running'}
              onClick={() =>
                act('run', async () => {
                  const { id } = await api<{ id: string }>('/import/hudu/run', { method: 'POST', body: {} });
                  setJobId(id);
                })
              }
            >
              Start import
            </Button>
          </div>
        )}
        {job.data && <JobSummary job={job.data} />}
        <FormError message={error} />
      </div>
    </Card>
  );
}

type TargetField = { key: string; label: string; required?: boolean; aliases?: string[] };
const BASE_FIELDS: Record<Exclude<CsvTarget, 'assets'>, TargetField[]> = {
  clients: [
    {
      key: 'name',
      label: 'Name',
      required: true,
      aliases: ['clientname', 'client', 'company', 'companyname', 'organization', 'organisation'],
    },
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status (active, prospect, inactive)' },
    { key: 'notes', label: 'Notes' },
  ],
  contacts: [
    { key: 'client', label: 'Client name', required: true },
    { key: 'name', label: 'Name', required: true },
    { key: 'title', label: 'Job title' },
    { key: 'email', label: 'Email' },
    { key: 'phone', label: 'Phone' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'notes', label: 'Notes' },
    { key: 'primary', label: 'Primary (yes/no)' },
  ],
  locations: [
    { key: 'client', label: 'Client name', required: true },
    { key: 'name', label: 'Name', required: true },
    { key: 'address', label: 'Address' },
    { key: 'city', label: 'City' },
    { key: 'region', label: 'State or region' },
    { key: 'postalCode', label: 'Postal code' },
    { key: 'country', label: 'Country' },
    { key: 'phone', label: 'Phone' },
    { key: 'notes', label: 'Notes' },
  ],
  passwords: [
    { key: 'client', label: 'Client name', required: true },
    { key: 'name', label: 'Name', required: true },
    { key: 'username', label: 'Username', aliases: ['user', 'login'] },
    { key: 'password', label: 'Password', required: true, aliases: ['secret'] },
    { key: 'url', label: 'Website', aliases: ['url', 'link', 'address'] },
    { key: 'notes', label: 'Notes' },
    { key: 'totp', label: 'One-time code key' },
  ],
};
const TARGET_LABELS: Record<CsvTarget, string> = {
  clients: 'Clients',
  contacts: 'Contacts',
  locations: 'Locations',
  assets: 'Assets',
  passwords: 'Passwords',
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function CsvImport() {
  const toast = useToast();
  const client = useQueryClient();
  const layouts = useLayouts();
  const [target, setTarget] = useState<CsvTarget>('clients');
  const [layoutId, setLayoutId] = useState('');
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  // Columns the person chose; everything else is guessed from the column names.
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [result, setResult] = useState<(CsvImportResult & { dryRun: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const layout = layouts.data?.find((l) => l.id === layoutId);
  const fields: TargetField[] = useMemo(
    () =>
      target === 'assets'
        ? [
            { key: 'client', label: 'Client name', required: true },
            { key: 'name', label: 'Name', required: true },
            { key: 'status', label: 'Status (active, inactive, retired)' },
            { key: 'notes', label: 'Notes' },
            ...(layout?.fields ?? []).map((f) => ({ key: f.key, label: f.label, required: f.required })),
          ]
        : BASE_FIELDS[target],
    [target, layout],
  );
  // Guess the mapping from column names whenever the file or the fields change.
  const autoMap = (headers: string[], list: TargetField[]) =>
    Object.fromEntries(
      list.map((f) => [
        f.key,
        headers.find(
          (h) =>
            norm(h) === norm(f.key) ||
            norm(h) === norm(f.label) ||
            (f.aliases ?? []).includes(norm(h)) ||
            (f.key === 'client' && /^(client|company|organi[sz]ation)(name)?$/.test(norm(h))),
        ) ?? '',
      ]),
    );
  const pick = async (input: File | undefined) => {
    setResult(null);
    setError(null);
    if (!input) return setFile(null);
    if (input.size > 8 * 1024 * 1024) return setError('Use a CSV file under 8 MB.');
    const parsed = parseCsv(await input.text());
    if (!parsed.headers.length || !parsed.rows.length) return setError('That file has no rows under a header line.');
    if (parsed.rows.length > 5000)
      return setError('Import at most 5,000 rows at a time. Split the file and try again.');
    setFile({ name: input.name, ...parsed });
    setOverrides({});
  };

  const rows = () =>
    file!.rows.map((r) =>
      Object.fromEntries(
        Object.entries(mapping)
          .filter(([, column]) => column)
          .map(([key, column]) => [key, (r[file!.headers.indexOf(column)] ?? '').trim()]),
      ),
    );
  const mapping: Record<string, string> = file ? { ...autoMap(file.headers, fields), ...overrides } : {};
  const missing = fields.filter((f) => f.required && !mapping[f.key]);
  const send = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<CsvImportResult>('/import/csv', {
        method: 'POST',
        body: { target, ...(target === 'assets' ? { layoutId } : {}), rows: rows(), dryRun },
      });
      setResult({ ...res, dryRun });
      if (!dryRun) {
        toast(`Imported: ${res.created} new, ${res.updated} updated.`);
        await client.invalidateQueries();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Import from a spreadsheet"
        description="Save the sheet as CSV. Rows name their client by its name, so import clients first."
      />
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="What's in the file">
            {(p) => (
              <Select {...p} value={target} onChange={(e) => setTarget(e.target.value as CsvTarget)}>
                {(Object.keys(TARGET_LABELS) as CsvTarget[]).map((t) => (
                  <option key={t} value={t}>
                    {TARGET_LABELS[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {target === 'assets' && (
            <Field label="Asset layout">
              {(p) => (
                <Select {...p} value={layoutId} onChange={(e) => setLayoutId(e.target.value)}>
                  <option value="">Choose…</option>
                  {layouts.data
                    ?.filter((l) => !l.archived)
                    .map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="CSV file">
            {(p) => (
              <Input
                {...p}
                type="file"
                accept=".csv,text/csv"
                className="pt-1.5"
                onChange={(e) => pick(e.target.files?.[0])}
              />
            )}
          </Field>
        </div>
        {file && (target !== 'assets' || layout) && (
          <>
            <p className="text-sm text-muted">
              {file.name}: {file.rows.length} row{file.rows.length === 1 ? '' : 's'}. Match each Atlas field to a
              column.
            </p>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {fields.map((f) => (
                <label key={f.key} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate font-medium">
                    {f.label}
                    {f.required && <span className="text-danger"> *</span>}
                  </span>
                  <Select
                    className="h-9 w-48 text-[13px]"
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => {
                      setResult(null);
                      setOverrides((m) => ({ ...m, [f.key]: e.target.value }));
                    }}
                  >
                    <option value="">Don&rsquo;t import</option>
                    {file.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </label>
              ))}
            </div>
            {missing.length > 0 && (
              <p className="flex items-center gap-2 text-sm text-warning">
                <Info className="size-4" aria-hidden /> Choose a column for {missing.map((m) => m.label).join(', ')}.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                onClick={() => send(true)}
                loading={busy && !result}
                disabled={!!missing.length}
              >
                <FileSpreadsheet /> Check the file
              </Button>
              <Button onClick={() => send(false)} loading={busy} disabled={!!missing.length || !result?.dryRun}>
                <Upload /> Import {plural(file.rows.length, 'row')}
              </Button>
            </div>
          </>
        )}
        {result && (
          <div className="rounded-xl border border-border bg-surface-2 p-4 text-sm" aria-live="polite">
            <p className="flex items-center gap-2 font-semibold">
              <CheckCircle2 className="size-4 text-success" aria-hidden />
              {result.dryRun
                ? `${plural((file?.rows.length ?? 0) - result.errors.length, 'row')} ready to import.`
                : `${result.created} new, ${result.updated} updated.`}
              {result.errors.length > 0 &&
                ` ${result.errors.length} row${result.errors.length === 1 ? ' has' : 's have'} problems.`}
            </p>
            {result.errors.length > 0 && (
              <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-text-2">
                {result.errors.map((e) => (
                  <li key={e.row}>
                    <span className="font-medium">Row {e.row}:</span> {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <FormError message={error} />
      </div>
    </Card>
  );
}

function ImportHistory() {
  const jobs = useQuery({ queryKey: ['import-jobs'], queryFn: () => api<ImportJobView[]>('/import/jobs') });
  if (!jobs.data?.length) return null;
  return (
    <Card>
      <CardHeader title="Recent imports" />
      <ul className="divide-y divide-border">
        {jobs.data.map((j) => (
          <li key={j.id} className="p-5">
            <JobSummary job={j} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function DataTools() {
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Import & export"
        description="Bring in documentation from Hudu or spreadsheets. Export a single client from its page."
      />
      <div className="grid max-w-4xl gap-6">
        <HuduImport />
        <CsvImport />
        <ImportHistory />
        <div className="flex gap-3 rounded-xl border border-border bg-surface-2 p-4 text-sm text-text-2">
          <History className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p>
            Moving from Atlas 0.2? Run{' '}
            <code className="font-mono text-[13px]">
              npm run migrate-legacy -w @atlas/server -- path/to/atlas.sqlite
            </code>{' '}
            on the server. People keep their passwords; see the deployment guide for details.
          </p>
        </div>
      </div>
    </>
  );
}
