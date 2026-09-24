import { useMemo, useState } from 'react';
import { BookOpen, CalendarClock, KeyRound, Server } from 'lucide-react';
import type { ExpirationItem, ExpiryKind } from '@atlas/shared';
import { Badge, Card, EmptyState, PageHeader, Select, Skeleton } from '@/components/ui';
import { AppLink } from '@/components/AppLink';
import { useExpirations } from '@/lib/queries';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';

const KIND: Record<ExpiryKind, { label: string; icon: typeof Server; path: string }> = {
  asset: { label: 'Assets', icon: Server, path: 'assets' },
  password: { label: 'Password rotation', icon: KeyRound, path: 'passwords' },
  document: { label: 'Document reviews', icon: BookOpen, path: 'documents' },
};

const GROUPS = [
  { key: 'overdue', title: 'Overdue', test: (d: number) => d < 0 },
  { key: 'week', title: 'Next 7 days', test: (d: number) => d >= 0 && d <= 7 },
  { key: 'month', title: 'Next 30 days', test: (d: number) => d > 7 && d <= 30 },
  { key: 'later', title: 'Later', test: (d: number) => d > 30 },
];

export function when(daysLeft: number) {
  if (daysLeft < 0) return `${-daysLeft} day${daysLeft === -1 ? '' : 's'} overdue`;
  if (daysLeft === 0) return 'Today';
  if (daysLeft === 1) return 'Tomorrow';
  return `In ${daysLeft} days`;
}
export const urgency = (daysLeft: number) => (daysLeft < 0 ? 'danger' : daysLeft <= 7 ? 'warning' : 'neutral');

export function ExpiryRow({ item }: { item: ExpirationItem }) {
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  return (
    <AppLink to={`/${kind.path}/${item.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-lg',
          item.daysLeft < 0 ? 'bg-danger-soft text-danger' : 'bg-surface-3 text-text-2',
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        <span className="block truncate text-xs text-muted">
          {item.label} · {item.clientName ?? 'Knowledge base'}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <Badge tone={urgency(item.daysLeft)}>{when(item.daysLeft)}</Badge>
        <span className="mt-0.5 block text-xs text-muted tabular-nums">{formatDate(`${item.date}T12:00:00`)}</span>
      </span>
    </AppLink>
  );
}

export function Expirations() {
  const [days, setDays] = useState(90);
  const [kind, setKind] = useState<ExpiryKind | 'all'>('all');
  const { data, isLoading } = useExpirations(days);
  const items = useMemo(() => (data ?? []).filter((i) => kind === 'all' || i.kind === kind), [data, kind]);
  const overdue = items.filter((i) => i.daysLeft < 0).length;
  return (
    <>
      <PageHeader
        eyebrow="Across your clients"
        title="Expirations"
        description="Certificates, domains, licences, warranties, password rotations, and document reviews coming due."
      />
      <Card>
        <div className="flex flex-wrap items-end gap-4 border-b border-border p-4">
          <label className="text-[13px] font-semibold">
            Show the next
            <Select className="mt-1.5 w-40" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[30, 60, 90, 180, 365].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </Select>
          </label>
          <label className="text-[13px] font-semibold">
            Type
            <Select
              className="mt-1.5 w-52"
              value={kind}
              onChange={(e) => setKind(e.target.value as ExpiryKind | 'all')}
            >
              <option value="all">Everything</option>
              {(Object.keys(KIND) as ExpiryKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND[k].label}
                </option>
              ))}
            </Select>
          </label>
          {!isLoading && (
            <p className="ml-auto text-sm text-muted" aria-live="polite">
              {items.length} item{items.length === 1 ? '' : 's'}
              {overdue ? ` · ${overdue} overdue` : ''}
            </p>
          )}
        </div>
        {isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !items.length ? (
          <EmptyState
            icon={CalendarClock}
            title="Nothing coming due"
            description="Date fields marked as expiry dates in asset layouts, password rotation schedules, and document review dates all show up here."
          />
        ) : (
          GROUPS.map((g) => {
            const rows = items.filter((i) => g.test(i.daysLeft));
            if (!rows.length) return null;
            return (
              <section key={g.key} aria-labelledby={`exp-${g.key}`}>
                <h2
                  id={`exp-${g.key}`}
                  className={cn(
                    'border-b border-border bg-surface-2 px-5 py-2 text-xs font-bold tracking-wide uppercase',
                    g.key === 'overdue' ? 'text-danger' : 'text-muted',
                  )}
                >
                  {g.title} · {rows.length}
                </h2>
                <ul className="divide-y divide-border">
                  {rows.map((i) => (
                    <li key={`${i.kind}-${i.id}-${i.label}`}>
                      <ExpiryRow item={i} />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </Card>
    </>
  );
}
