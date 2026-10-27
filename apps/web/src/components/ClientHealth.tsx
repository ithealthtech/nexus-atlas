import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowRight, ArrowUpRight, HeartPulse } from 'lucide-react';
import {
  HEALTH_PART_INFO,
  healthGrade,
  type ClientHealthDetail,
  type ClientHealthSummary,
  type HealthList,
  type HealthTone,
} from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { DeviceList } from '@/components/RmmHealth';
import { AssetList } from '@/components/Warranty';
import { Card, CardHeader, Dialog, FormError, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';

const TEXT: Record<HealthTone, string> = {
  success: 'text-success',
  primary: 'text-primary',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-muted',
};
const BAR: Record<HealthTone, string> = {
  success: 'bg-success',
  primary: 'bg-primary',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-border-strong',
};

export const useClientHealth = (clientId: string, enabled = true) =>
  useQuery({
    queryKey: ['client-health', clientId],
    queryFn: () => api<ClientHealthDetail>(`/clients/${clientId}/health`),
    enabled,
  });

/** Every client's score this person can see, lowest first (staff only). */
export function useHealthList() {
  const actor = useActor();
  return useQuery({
    queryKey: ['client-health'],
    queryFn: () => api<ClientHealthSummary[]>('/client-health'),
    enabled: actor.isStaff,
  });
}

/** The score in a ring that fills to it, in the grade's colour. */
export function HealthRing({
  score,
  size = 40,
  className,
}: {
  score: number | null;
  size?: number;
  className?: string;
}) {
  const { tone } = healthGrade(score);
  const stroke = Math.max(3, Math.round(size / 11));
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <span className={cn('relative inline-grid shrink-0 place-items-center', TEXT[tone], className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-border" />
        {score !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${(score / 100) * length} ${length}`}
          />
        )}
      </svg>
      <span
        className="absolute font-semibold text-text tabular-nums"
        style={{ fontSize: Math.max(10, Math.round(size / 3)) }}
      >
        {score ?? '–'}
      </span>
    </span>
  );
}

/** A small line of the scores over time. */
export function HealthSparkline({ points, className }: { points: number[]; className?: string }) {
  if (points.length < 2) return null;
  const w = 100;
  const h = 28;
  // Scaled to its own range, with a little room, so a few points of change show.
  const min = Math.min(...points) - 4;
  const max = Math.max(...points) + 4;
  const y = (v: number) => h - 2 - ((v - min) / (max - min || 1)) * (h - 4);
  const path = points.map((v, i) => `${(i / (points.length - 1)) * w},${y(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className={cn('h-7 w-24', className)}>
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Up, down or flat, with the points it moved. */
export function HealthChange({ change, className }: { change: number | null; className?: string }) {
  if (change === null) return null;
  const Icon = change > 0 ? ArrowUpRight : change < 0 ? ArrowDownRight : ArrowRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-xs font-medium tabular-nums',
        change > 0 ? 'text-success' : change < 0 ? 'text-danger' : 'text-muted',
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {change > 0 ? `+${change}` : change}
      <span className="sr-only"> points in 30 days</span>
    </span>
  );
}

/**
 * The client's health beside its name: the score in a ring, and what it means. Choosing it shows what makes up
 * the score, what would raise it most, and how it has moved. Staff only.
 */
export function HealthBadge({ clientId }: { clientId: string }) {
  const actor = useActor();
  const health = useClientHealth(clientId, actor.isStaff);
  const [open, setOpen] = useState(false);
  // The list behind a finding, opened from the health window (which closes, so the list has the screen).
  const [list, setList] = useState<HealthList | null>(null);
  if (!actor.isStaff || !health.data) return null;
  const grade = healthGrade(health.data.score);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full border border-border bg-surface py-0.5 pr-3 pl-0.5 text-[13px] hover:bg-surface-3"
        aria-label={`Health score ${health.data.score ?? 'not measured'}: ${grade.label}. Show what makes it up`}
      >
        <HealthRing score={health.data.score} size={30} />
        <span className={cn('font-semibold', TEXT[grade.tone])}>{grade.label}</span>
        <HealthChange change={health.data.change} />
      </button>
      {open && (
        <HealthDetail
          health={health.data}
          onClose={() => setOpen(false)}
          onList={(l) => {
            setOpen(false);
            setList(l);
          }}
        />
      )}
      <DeviceList
        filter={list?.kind === 'devices' ? list.filter : null}
        clientId={clientId}
        onClose={() => setList(null)}
      />
      <AssetList
        filter={list?.kind === 'warranty' ? list.filter : null}
        clientId={clientId}
        onClose={() => setList(null)}
      />
    </>
  );
}

function FindingRow({ gain, text, part }: { gain: number; text: string; part: keyof typeof HEALTH_PART_INFO }) {
  return (
    <>
      <span
        className={cn(
          'w-10 shrink-0 text-right text-xs font-semibold tabular-nums',
          gain ? 'text-success' : 'text-muted',
        )}
      >
        {gain ? `+${gain}` : 'Check'}
      </span>
      <span className="min-w-0 flex-1">{text}</span>
      <span className="text-xs text-muted">{HEALTH_PART_INFO[part].label}</span>
    </>
  );
}

function HealthDetail({
  health,
  onClose,
  onList,
}: {
  health: ClientHealthDetail;
  onClose: () => void;
  onList: (list: HealthList) => void;
}) {
  const grade = healthGrade(health.score);
  const findings = health.parts
    .flatMap((p) => p.findings.map((f) => ({ ...f, part: p.part })))
    .sort((a, b) => b.gain - a.gain);
  const base = `/clients/${health.clientId}`;
  return (
    <Dialog open onClose={onClose} size="lg" title="Client health" description={health.clientName}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-5">
          <HealthRing score={health.score} size={84} />
          <div className="min-w-0 flex-1 basis-48">
            <p className={cn('text-lg font-semibold', TEXT[grade.tone])}>{grade.label}</p>
            <p className="mt-0.5 text-sm text-muted">
              {health.change === null ? (
                'The trend starts as Atlas records a score each day.'
              ) : (
                <>
                  <HealthChange change={health.change} /> in the last 30 days
                </>
              )}
            </p>
            <p className="mt-0.5 text-xs text-muted">Worked out {relativeTime(health.computedAt)}, and every hour.</p>
          </div>
          <span className={cn('text-text-2', TEXT[grade.tone])}>
            <HealthSparkline points={health.trend.map((p) => p.score)} className="h-12 w-40" />
          </span>
        </div>

        <section>
          <h3 className="mb-2 text-sm font-semibold">What makes it up</h3>
          <ul className="space-y-3">
            {health.parts.map((p) => {
              const info = HEALTH_PART_INFO[p.part];
              const tone = healthGrade(p.score).tone;
              return (
                <li key={p.part}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-medium">
                      {info.label} <span className="text-xs font-normal text-muted">· {info.weight}% of the score</span>
                    </span>
                    <span className={cn('font-semibold tabular-nums', TEXT[tone])}>{p.score ?? 'Not measured'}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <div className={cn('h-full rounded-full', BAR[tone])} style={{ width: `${p.score ?? 0}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {p.score === null ? `${p.detail}. Left out until there is something to measure.` : p.detail}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">What would raise it most</h3>
          {findings.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {findings.map((f) => (
                <li key={`${f.part}-${f.text}`}>
                  {/* A finding with a list behind it opens that list; the others go to where it's fixed. */}
                  {f.list ? (
                    <button
                      type="button"
                      onClick={() => onList(f.list!)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-surface-2"
                    >
                      <FindingRow gain={f.gain} text={f.text} part={f.part} />
                    </button>
                  ) : (
                    <AppLink
                      to={`${base}${f.section}`}
                      onClick={onClose}
                      className="flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-surface-2"
                    >
                      <FindingRow gain={f.gain} text={f.text} part={f.part} />
                    </AppLink>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nothing is pulling the score down.</p>
          )}
        </section>
        <p className="text-xs text-muted">
          The score weighs security, endpoints, documentation and renewals. A part with nothing to measure, such as a
          client without RMM devices, is left out rather than counted as healthy.
        </p>
      </div>
    </Dialog>
  );
}

/** Every client's health on the dashboard, lowest first: where to spend the week. Staff only. */
export function ClientHealthCard() {
  const actor = useActor();
  const list = useHealthList();
  if (!actor.isStaff) return null;
  const scored = (list.data ?? []).filter((c) => c.score !== null);
  const average = scored.length ? Math.round(scored.reduce((n, c) => n + c.score!, 0) / scored.length) : null;
  return (
    <Card>
      <CardHeader
        title="Client health"
        description={
          average === null
            ? 'Security, endpoints, documentation and renewals, scored 0–100.'
            : `Average ${average} across ${scored.length} client${scored.length === 1 ? '' : 's'}. Lowest first.`
        }
      />
      <FormError message={list.error?.message} />
      {list.isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : !list.data?.length ? (
        <p className="flex items-center gap-2 px-5 py-4 text-sm text-muted">
          <HeartPulse className="size-4" aria-hidden /> Scores appear once you have clients.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {list.data.slice(0, 8).map((c) => {
            const grade = healthGrade(c.score);
            return (
              <li key={c.clientId}>
                <AppLink to={`/clients/${c.clientId}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
                  <HealthRing score={c.score} size={36} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{c.clientName}</span>
                    <span className="block text-xs text-muted">
                      <span className={TEXT[grade.tone]}>{grade.label}</span>
                      {c.weakest && ` · ${HEALTH_PART_INFO[c.weakest].label} lowest`}
                    </span>
                  </span>
                  <span className={cn('hidden sm:block', TEXT[grade.tone])}>
                    <HealthSparkline points={c.trend} />
                  </span>
                  <HealthChange change={c.change} className="w-10 justify-end" />
                </AppLink>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
