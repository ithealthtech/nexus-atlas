import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  PASSWORD_ISSUES,
  PASSWORD_ISSUE_LABELS,
  type PasswordHealthReport,
  type PasswordHealthSettings,
  type PasswordIssue,
} from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  FormError,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { useActor } from '@/lib/session';

const tone = (score: number | null) =>
  score === null ? 'neutral' : score >= 90 ? 'success' : score >= 70 ? 'warning' : 'danger';
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Where passwords are weak, reused, overdue, expired, or found in a breach, per client and per password. */
export function PasswordHealth() {
  const actor = useActor();
  const toast = useToast();
  const report = useQuery({
    queryKey: ['password-health'],
    queryFn: () => api<PasswordHealthReport>('/password-health'),
  });
  const [client, setClient] = useState('');
  const [issue, setIssue] = useState<PasswordIssue | ''>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const data = report.data;
  const items = useMemo(
    () => (data?.items ?? []).filter((i) => (!client || i.clientId === client) && (!issue || i.issues.includes(issue))),
    [data, client, issue],
  );

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
  const exportCsv = () => {
    const rows = [
      ['Client', 'Password', 'Type', 'Issues'],
      ...items.map((i) => [i.clientName, i.name, i.category, i.issues.map((x) => PASSWORD_ISSUE_LABELS[x]).join('; ')]),
    ];
    const href = URL.createObjectURL(
      new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }),
    );
    Object.assign(document.createElement('a'), { href, download: 'password-health.csv' }).click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  };

  return (
    <>
      <PageHeader
        eyebrow="Vault"
        title="Password health"
        description="Weak, reused, overdue, expired, and breached passwords across the clients you can open. Nothing here shows a password."
        actions={
          <Button variant="secondary" onClick={exportCsv} disabled={!items.length}>
            <Download /> Export CSV
          </Button>
        }
      />
      {report.isLoading || !data ? (
        <Skeleton className="h-64 max-w-4xl" />
      ) : (
        <div className="grid max-w-5xl gap-6">
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Card className="p-4 sm:col-span-3 lg:col-span-2">
              <p className="text-xs text-muted">Overall health</p>
              <p className="mt-1 flex items-baseline gap-2">
                <span className="text-4xl font-semibold tabular-nums">
                  {data.score === null ? '—' : `${data.score}%`}
                </span>
                <Badge tone={tone(data.score)}>
                  {data.score === null ? 'No passwords' : `of ${data.total} passwords clean`}
                </Badge>
              </p>
            </Card>
            {PASSWORD_ISSUES.map((i) => (
              <button
                key={i}
                type="button"
                aria-pressed={issue === i}
                onClick={() => setIssue(issue === i ? '' : i)}
                className={cn(
                  'rounded-xl border border-border bg-surface p-4 text-left hover:bg-surface-2 aria-pressed:border-primary aria-pressed:bg-primary-soft',
                )}
              >
                <span className="block text-xs text-muted">{PASSWORD_ISSUE_LABELS[i]}</span>
                <span
                  className={cn(
                    'mt-1 block text-2xl font-semibold tabular-nums',
                    data.counts[i] > 0 && i === 'breached' && 'text-danger',
                  )}
                >
                  {data.counts[i]}
                </span>
              </button>
            ))}
          </div>

          <Card>
            <CardHeader title="Clients" description="Percent of each client’s passwords with no issue. Lowest first." />
            {data.clients.length ? (
              <ul className="divide-y divide-border">
                {data.clients.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setClient(client === c.id ? '' : c.id)}
                      aria-pressed={client === c.id}
                      className="flex w-full items-center gap-3 px-5 py-3 text-left text-sm hover:bg-surface-2 aria-pressed:bg-primary-soft"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                      <span className="text-xs text-muted">
                        {c.withIssues} of {c.total} need attention
                      </span>
                      <Badge tone={tone(c.score)}>{c.score === null ? '—' : `${c.score}%`}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={ShieldCheck}
                title="No passwords yet"
                description="Add passwords to a client to see their health."
              />
            )}
          </Card>

          <Card>
            <CardHeader
              title={`${items.length} password${items.length === 1 ? '' : 's'} to look at`}
              actions={
                <div className="flex flex-wrap gap-2">
                  <label>
                    <span className="sr-only">Client</span>
                    <Select value={client} onChange={(e) => setClient(e.target.value)} className="h-8 w-auto">
                      <option value="">All clients</option>
                      {data.clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    <span className="sr-only">Issue</span>
                    <Select
                      value={issue}
                      onChange={(e) => setIssue(e.target.value as PasswordIssue | '')}
                      className="h-8 w-auto"
                    >
                      <option value="">Any issue</option>
                      {PASSWORD_ISSUES.map((i) => (
                        <option key={i} value={i}>
                          {PASSWORD_ISSUE_LABELS[i]}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
              }
            />
            {items.length ? (
              <ul className="divide-y divide-border">
                {items.slice(0, 300).map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                    <AppLink to={`/passwords/${i.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">
                      {i.name}
                      <span className="ml-2 font-normal text-muted">{i.clientName}</span>
                    </AppLink>
                    <span className="flex flex-wrap gap-1">
                      {i.issues.map((x) => (
                        <Badge key={x} tone={x === 'breached' ? 'danger' : 'warning'}>
                          {PASSWORD_ISSUE_LABELS[x]}
                        </Badge>
                      ))}
                    </span>
                  </li>
                ))}
                {items.length > 300 && (
                  <li className="px-5 py-3 text-sm text-muted">
                    Showing the first 300. Filter, or export the CSV for all {items.length}.
                  </li>
                )}
              </ul>
            ) : (
              <EmptyState icon={ShieldCheck} title="Nothing to fix" description="No passwords match this view." />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Breach checks"
              description="Each password is compared with Have I Been Pwned’s list of leaked passwords. Only the first 5 characters of a scrambled (SHA-1) fingerprint leave this server; the password never does."
            />
            <div className="space-y-3 p-5 text-sm">
              <p className="text-text-2">
                {data.breach.enabled
                  ? `${data.breach.checked} checked, ${data.breach.unchecked} waiting. ${
                      data.breach.lastRunAt
                        ? `Last daily run ${formatDateTime(data.breach.lastRunAt)}.`
                        : 'The daily run has not happened yet.'
                    }`
                  : 'Breach checks are off.'}
              </p>
              {actor.isAdmin && (
                <div className="flex flex-wrap items-center gap-3">
                  <Checkbox
                    label="Check passwords against known breaches"
                    description="Turn off for servers without internet access."
                    checked={data.breach.enabled}
                    disabled={busy === 'setting'}
                    onChange={(e) =>
                      act('setting', async () => {
                        await api<PasswordHealthSettings>('/password-health/settings', {
                          method: 'PUT',
                          body: { breachChecks: e.target.checked },
                        });
                        await report.refetch();
                      })
                    }
                  />
                  <Button
                    variant="secondary"
                    className="ml-auto"
                    loading={busy === 'check'}
                    disabled={!data.breach.enabled}
                    onClick={() =>
                      act('check', async () => {
                        const result = await api<{ checked: number }>('/password-health/check', {
                          method: 'POST',
                          body: {},
                        });
                        await report.refetch();
                        toast(`Checked ${result.checked} password${result.checked === 1 ? '' : 's'}.`);
                      })
                    }
                  >
                    <RefreshCw /> Check now
                  </Button>
                </div>
              )}
              <FormError message={error} />
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
