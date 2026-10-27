import { useQuery } from '@tanstack/react-query';
import type { RunView, TemplateView } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Card, CardHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';

const DAY = 86_400_000;
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const daysBetween = (from: string, to: string) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / DAY));

/**
 * New clients being taken on: each run of the built-in "New client onboarding" checklist, how far along it is, and
 * how long finished ones took. Shown once that checklist is in the MSP's library and has been started for a client.
 */
export function OnboardingCard() {
  const actor = useActor();
  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateView[]>('/templates'),
    enabled: actor.isStaff,
  });
  const checklistId = templates.data?.find((t) => t.key === 'client-onboarding')?.addedId;
  const runs = useQuery({
    queryKey: ['checklist-runs', ''],
    queryFn: () => api<RunView[]>('/checklist-runs?'),
    enabled: !!checklistId,
  });
  const onboarding = (runs.data ?? []).filter((r) => r.checklistId === checklistId);
  if (!checklistId || !onboarding.length) return null;
  const open = onboarding.filter((r) => !r.completedAt);
  const finished = onboarding.filter((r) => r.completedAt);
  const took = finished.map((r) => daysBetween(r.createdAt, r.completedAt!));
  const average = took.length ? Math.round(took.reduce((n, d) => n + d, 0) / took.length) : null;
  const shown = [...open, ...finished.slice(0, Math.max(0, 5 - open.length))];
  return (
    <Card className="mb-6">
      <CardHeader
        title="Client onboarding"
        description={
          average === null
            ? `${open.length} in progress.`
            : `${open.length} in progress. Finished onboardings took ${days(average)} on average (${finished.length}).`
        }
      />
      <ul className="divide-y divide-border">
        {shown.map((r) => {
          const percent = r.total ? Math.round((r.done / r.total) * 100) : 0;
          return (
            <li key={r.id}>
              <AppLink to={`/checklist-runs/${r.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-surface-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{r.clientName}</span>
                  <span className="block text-xs text-muted">
                    {r.completedAt
                      ? `Finished in ${days(daysBetween(r.createdAt, r.completedAt))}`
                      : `Started ${relativeTime(r.createdAt)}${r.assigneeName ? ` · ${r.assigneeName}` : ''}`}
                  </span>
                </span>
                <span className="flex w-40 shrink-0 items-center gap-2 text-xs text-muted tabular-nums">
                  <span
                    className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"
                    role="progressbar"
                    aria-label={`${r.clientName} onboarding`}
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span
                      className={r.completedAt ? 'block h-full bg-success' : 'block h-full bg-primary'}
                      style={{ width: `${percent}%` }}
                    />
                  </span>
                  {r.done}/{r.total}
                </span>
              </AppLink>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
