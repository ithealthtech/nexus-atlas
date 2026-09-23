import { useMemo, useState } from 'react';
import { AlertTriangle, LogIn, ScrollText, Search, ShieldCheck, UserCog } from 'lucide-react';
import { Card, EmptyState, Input, PageHeader, Skeleton } from '@/components/ui';
import { useSecurityEvents } from '@/lib/queries';
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
    </>
  );
}
