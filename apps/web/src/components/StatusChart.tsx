import { useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

/**
 * Status colours for the health charts (good, warning, serious, critical, unknown). They're fixed rather than
 * themed, and never carry meaning alone: every slice has an icon and a label in the legend beside it.
 */
export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';
const STROKE: Record<Tone, string> = {
  good: 'stroke-[#0ca30c]',
  warning: 'stroke-[#fab219]',
  serious: 'stroke-[#ec835a]',
  critical: 'stroke-[#d03b3b]',
  unknown: 'stroke-[#c3c2b7] dark:stroke-[#5b5a55]',
};
export const SWATCH: Record<Tone, string> = {
  good: 'text-[#0ca30c]',
  warning: 'text-[#b27c0a] dark:text-[#fab219]',
  serious: 'text-[#c75a30] dark:text-[#ec835a]',
  critical: 'text-[#d03b3b] dark:text-[#ef8a7c]',
  unknown: 'text-muted',
};
const ICON: Record<Tone, LucideIcon> = {
  good: CheckCircle2,
  warning: AlertTriangle,
  serious: AlertTriangle,
  critical: XCircle,
  unknown: CircleHelp,
};

export interface Slice<F extends string = string> {
  label: string;
  count: number;
  tone: Tone;
  /** The list behind the slice; healthy slices have none. */
  filter?: F;
}

export const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);

/** A donut of status slices with a 2px gap between them. Decorative: the legend beside it carries the numbers. */
function Donut({ slices, total, active }: { slices: Slice[]; total: number; active: string | null }) {
  const shown = slices.filter((s) => s.count > 0);
  const gap = shown.length > 1 ? 0.7 : 0; // about 2px at this size, in path-length units of 100
  // Where each slice starts, as a share of the ring.
  const starts = shown.map((_, i) => shown.slice(0, i).reduce((sum, s) => sum + (s.count / total) * 100, 0));
  return (
    <svg viewBox="0 0 120 120" className="size-32 shrink-0 -rotate-90" aria-hidden>
      {shown.map((s, i) => {
        const length = (s.count / total) * 100;
        const dash = Math.max(length - gap, 0.1);
        return (
          <circle
            key={s.label}
            cx="60"
            cy="60"
            r="48"
            fill="none"
            strokeWidth={active === s.label ? 16 : 13}
            pathLength={100}
            strokeDasharray={`${dash} ${100 - dash}`}
            strokeDashoffset={-starts[i]!}
            className={cn(STROKE[s.tone], 'transition-[stroke-width]', active && active !== s.label && 'opacity-40')}
          >
            <title>{`${s.label}: ${s.count} (${pct(s.count, total)}%)`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

/**
 * One metric's share over recent days, as a thin line. The caption beside it gives the first and latest values
 * in words; each point has a tooltip.
 */
export function Sparkline({
  label,
  points,
  days,
}: {
  label: string;
  points: { day: string; value: number }[];
  days: number;
}) {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const low = Math.max(Math.min(...points.map((p) => p.value)) - 5, 0);
  const span = Math.max(100 - low, 1);
  const x = (i: number) => (i / (points.length - 1)) * 200;
  const y = (v: number) => 4 + (1 - (v - low) / span) * 32;
  const change = last.value - first.value;
  return (
    <div className="mt-auto border-t border-border pt-3">
      <p className="flex items-baseline justify-between gap-2 text-xs text-muted">
        <span>
          Last {days} days
          <span className="sr-only">
            , {label}: {first.value}% on {formatDate(`${first.day}T12:00:00`)}, {last.value}% on{' '}
            {formatDate(`${last.day}T12:00:00`)}
          </span>
        </span>
        <span className="font-medium text-text-2 tabular-nums" aria-hidden>
          {change === 0 ? 'No change' : `${change > 0 ? '+' : '−'}${Math.abs(change)} pts`}
        </span>
      </p>
      <svg viewBox="0 0 200 40" preserveAspectRatio="none" className="mt-1 h-10 w-full overflow-visible" aria-hidden>
        <line
          x1="0"
          x2="200"
          y1={y(100)}
          y2={y(100)}
          className="stroke-border"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')}
          fill="none"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          className="stroke-primary"
        />
        {points.map((p, i) => (
          <rect
            key={p.day}
            x={x(i) - 100 / (points.length - 1)}
            width={200 / (points.length - 1)}
            y="0"
            height="40"
            fill="transparent"
          >
            <title>{`${formatDate(`${p.day}T12:00:00`)}: ${p.value}% ${label}`}</title>
          </rect>
        ))}
      </svg>
    </div>
  );
}

/** A donut with its legend table (icon, label, count, share); problem slices open their list. */
export function StatusChart<F extends string>({
  title,
  headline,
  slices,
  total,
  onPick,
  unit,
  footer,
  bare,
}: {
  /** Without its own border, for a card that holds just this chart. */
  bare?: boolean;
  title: string;
  /** What the rows count, for the table's column header, e.g. "Devices". */
  unit: string;
  footer?: ReactNode;
  /** The share the chart is about, e.g. "online", shown large in the middle. */
  headline: { label: string; count: number };
  slices: Slice<F>[];
  total: number;
  onPick: (slice: Slice<F>) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <section aria-label={title} className={cn('flex min-w-0 flex-col', !bare && 'rounded-lg border border-border p-4')}>
      <h3 className={cn('text-sm font-semibold text-text', bare && 'sr-only')}>{title}</h3>
      <div className={cn('flex flex-wrap items-center gap-4', !bare && 'mt-3')}>
        <div className="relative">
          <Donut slices={slices} total={total} active={active} />
          <div className="absolute inset-0 grid place-content-center text-center">
            <span className="text-2xl font-semibold tracking-tight text-text">{pct(headline.count, total)}%</span>
            <span className="text-xs text-muted">{headline.label}</span>
          </div>
        </div>
        <table className="min-w-40 flex-1 text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Status</th>
              <th scope="col">{unit}</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {slices.map((s) => {
              const Icon = ICON[s.tone];
              const label = (
                <>
                  <Icon className={cn('size-4 shrink-0', SWATCH[s.tone])} aria-hidden />
                  <span className="truncate">{s.label}</span>
                </>
              );
              return (
                <tr
                  key={s.label}
                  onMouseEnter={() => setActive(s.label)}
                  onMouseLeave={() => setActive(null)}
                  className="align-middle"
                >
                  <th scope="row" className="py-1 pr-2 text-left font-normal text-text-2">
                    {s.filter && s.count > 0 ? (
                      <button
                        type="button"
                        onClick={() => onPick(s)}
                        onFocus={() => setActive(s.label)}
                        onBlur={() => setActive(null)}
                        className="-mx-1 flex min-h-7 items-center gap-2 rounded px-1 text-left hover:bg-surface-2 hover:underline"
                      >
                        {label}
                      </button>
                    ) : (
                      <span className="flex min-h-7 items-center gap-2">{label}</span>
                    )}
                  </th>
                  <td className="py-1 pr-2 text-right font-semibold text-text tabular-nums">{s.count}</td>
                  <td className="w-12 py-1 text-right text-muted tabular-nums">{pct(s.count, total)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer && (
        <>
          <div className="min-h-3 flex-1" />
          {footer}
        </>
      )}
    </section>
  );
}

export function Tile({
  label,
  value,
  icon: Icon,
  alert,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  alert?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <div className="flex items-center justify-between text-xs text-muted">
        {label}
        <Icon className={cn('size-4', alert && SWATCH.critical)} aria-hidden />
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-text tabular-nums">{value}</div>
    </div>
  );
}
