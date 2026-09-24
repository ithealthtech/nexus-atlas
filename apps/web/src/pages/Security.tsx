import { useMemo, useState } from 'react';
import { AlertTriangle, Download, LogIn, ScrollText, Search, ShieldCheck, ShieldX, UserCog } from 'lucide-react';
import type { AuditVerification } from '@atlas/shared';
import { Button, Card, EmptyState, FormError, Input, PageHeader, Skeleton, useToast } from '@/components/ui';
import { api, download } from '@/lib/api';
import { useSecurityEvents } from '@/lib/queries';
import { useVaultAudit } from '@/lib/vault';
import { CardHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';

const style = (action: string) =>
  /fail|lock|block/i.test(action)
    ? { icon: AlertTriangle, tone: 'bg-danger-soft text-danger' }
    : /sign/i.test(action)
      ? { icon: LogIn, tone: 'bg-info-soft text-info' }
      : /mfa|password/i.test(action)
        ? { icon: ShieldCheck, tone: 'bg-primary-soft text-primary' }
        : { icon: UserCog, tone: 'bg-surface-3 text-text-2' };

export function Security() {
  const { data, isLoading } = useSecurityEvents();
  const [query, setQuery] = useState('');
  const rows = useMemo(
    () =>
      (data ?? []).filter((e) =>
        `${e.action} ${e.detail} ${e.actor} ${e.ip}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [data, query],
  );
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Security log"
        description="Sign-ins, failed attempts, lockouts, and account changes. The latest 200 events are shown."
      />
      <AuditIntegrity />
      <Card>
        <div className="border-b border-border p-4">
          <label className="relative block max-w-md">
            <span className="sr-only">Filter events</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by person, action, or address…"
              className="pl-9"
            />
          </label>
        </div>
        {isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : !rows.length ? (
          <EmptyState icon={ScrollText} title="No events" description="Security events will appear here." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((e) => {
              const { icon: Icon, tone } = style(e.action);
              return (
                <li key={e.id} className="flex items-start gap-3 px-5 py-3.5">
                  <span className={cn('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg', tone)}>
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1 text-sm">
                    <p>
                      <span className="font-semibold">{e.action}</span>{' '}
                      {e.detail && <span className="text-text-2">· {e.detail}</span>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      {e.actor}
                      {e.ip && ` · ${e.ip}`}
                    </p>
                  </div>
                  <time dateTime={e.createdAt} className="shrink-0 text-xs text-muted">
                    {formatDateTime(e.createdAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <VaultAudit />
    </>
  );
}

function VaultAudit() {
  const { data } = useVaultAudit(true);
  return (
    <Card className="mt-6">
      <CardHeader
        title="Vault access"
        description="Every reveal, copy, change, and share across all clients (latest 300)."
      />
      {!data?.length ? (
        <p className="px-5 py-4 text-sm text-muted">No vault activity yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((a) => (
            <li key={a.id} className="flex items-start gap-3 px-5 py-3 text-sm">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-warning-soft text-warning">
                <ShieldCheck className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p>
                  <span className="font-semibold">{a.actorName}</span>{' '}
                  <span className="text-text-2">{a.action.toLowerCase()}</span>{' '}
                  <span className="font-medium">{a.passwordName}</span>
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {a.clientName}
                  {a.ip && ` · ${a.ip}`}
                  {a.reason && ` · Reason: ${a.reason}`}
                </p>
              </div>
              <time dateTime={a.createdAt} className="shrink-0 text-xs text-muted">
                {formatDateTime(a.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AuditIntegrity() {
  const toast = useToast();
  const [result, setResult] = useState<AuditVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<AuditVerification>('/audit/verify', { method: 'POST', body: {} }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportLog = async (kind: 'security' | 'vault') => {
    try {
      await download(`/audit/export/${kind}`, `atlas-${kind}-log-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Card className="mb-6">
      <CardHeader
        title="Log integrity"
        description="Each event includes a fingerprint of the one before it, so edited or removed entries are detected."
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => exportLog('security')}>
              <Download /> Security events CSV
            </Button>
            <Button variant="secondary" size="sm" onClick={() => exportLog('vault')}>
              <Download /> Password activity CSV
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        {result ? (
          result.ok ? (
            <ShieldCheck className="size-6 text-success" aria-hidden />
          ) : (
            <ShieldX className="size-6 text-danger" aria-hidden />
          )
        ) : (
          <ScrollText className="size-6 text-muted" aria-hidden />
        )}
        <div className="min-w-0 flex-1 text-sm" aria-live="polite">
          {!result ? (
            <p className="text-muted">Check that no security events have been changed or deleted.</p>
          ) : result.ok ? (
            <p>
              <span className="font-semibold text-success">Intact.</span> {result.checked} events checked
              {result.checkpoint === 'missing' ? '; a signed checkpoint was created for next time.' : '.'}
            </p>
          ) : (
            <p>
              <span className="font-semibold text-danger">Problem found.</span>{' '}
              {result.brokenAt
                ? `Event #${result.brokenAt} was changed, or an event before it was removed.`
                : 'The newest events no longer match the signed checkpoint, so recent entries may have been deleted.'}{' '}
              Investigate database access and restore from backup if needed.
            </p>
          )}
          <FormError message={error} />
        </div>
        <Button onClick={verify} loading={busy}>
          Verify now
        </Button>
      </div>
    </Card>
  );
}
