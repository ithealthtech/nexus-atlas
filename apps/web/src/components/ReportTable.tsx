import type { ReportHighlight } from '@atlas/shared';
import { StatusPill } from '@/components/ui';
import { cn } from '@/lib/cn';

/*
 * How a report reads on screen, as in the IT Health Tech portal's reports: a row of figures across the top, then
 * roomy tables where a state is a pill, figures line up on the right, and a subscription's seats show how full it is.
 * The Reports workspace and a shared report link draw their tables with these.
 */

/** Columns whose values are states, shown as pills. */
const STATE_COLUMNS = new Set([
  'Status',
  'Answer',
  'Online',
  'Protection',
  'Encryption',
  'Last result',
  'Enabled',
  'Auto-renew',
  'Last check',
  'Account status',
]);
const GOOD = /^(active|enabled|yes|online|running|protected|healthy|ok|current|encrypted|on|ready|valid|licensed)\b/i;
const BAD =
  /^(expired|failed|no|offline|overdue|blocked|disabled|not encrypted|suspended|inactive|deleted|stopped|missing)\b/i;
const WARN =
  /^(partly|expiring|warning|unknown|not evidenced|outdated|needs review|draft|trial|grace|off|not recorded|unlicensed)\b/i;

export function stateTone(value: string) {
  return BAD.test(value) ? 'bad' : WARN.test(value) ? 'warn' : GOOD.test(value) ? 'good' : 'muted';
}

const NUMBER = /^-?[\d,]+(\.\d+)?%?$/;
const MONEY = /^[A-Z]{3} -?[\d,]+(\.\d+)?/;
/** Microsoft's free and trial products report 10,000 or more seats. */
const UNLIMITED = 10_000;

/** Columns that hold figures (every value a number or an amount): they line up on the right. */
export function figureColumns(columns: string[], rows: string[][]): Set<number> {
  return new Set(
    columns.flatMap((_, i) => {
      const values = rows.map((r) => r[i] ?? '').filter((v) => v && v !== '—');
      return values.length && values.every((v) => NUMBER.test(v) || MONEY.test(v)) ? [i] : [];
    }),
  );
}

/** Classes for a header cell and a body cell, so every report table has the same rhythm. */
export const reportHeadCell =
  'border-b border-border bg-surface-2 px-5 py-2.5 text-[10px] font-bold tracking-[0.08em] whitespace-nowrap text-muted uppercase';
export const reportBodyCell = 'px-5 py-3.5 align-middle text-[13px] leading-5';

/**
 * One value of a report row. `columns` and `row` are the whole row as shown, so the Assigned cell of a
 * subscription can draw its seats as a bar.
 */
export function ReportCell({ columns, row, index }: { columns: string[]; row: string[]; index: number }) {
  const column = columns[index]!;
  const value = row[index] ?? '';
  if (!value || value === '—') return <span className="text-muted">—</span>;
  if (column === 'Assigned') {
    const seatsAt = [columns.indexOf('Seats'), columns.indexOf('Enabled seats')].find((i) => i >= 0) ?? -1;
    const seats = Number((row[seatsAt] ?? '').replace(/,/g, ''));
    const assigned = Number(value.replace(/,/g, ''));
    if (seatsAt >= 0 && Number.isFinite(seats) && Number.isFinite(assigned))
      return <SeatUse assigned={assigned} seats={seats} />;
  }
  if (STATE_COLUMNS.has(column)) {
    // "Failed 2026-10-21" and the like: the word decides the colour.
    return <StatusPill tone={stateTone(value)}>{value}</StatusPill>;
  }
  return <>{value}</>;
}

/** Seats in use against seats bought, as a bar that turns amber when nearly full and red when over. */
export function SeatUse({ assigned, seats }: { assigned: number; seats: number }) {
  if (seats >= UNLIMITED)
    return (
      <span className="text-[13px] tabular-nums">
        {assigned.toLocaleString()} <span className="text-muted">· no seat limit</span>
      </span>
    );
  const share = seats > 0 ? Math.min(1, assigned / seats) : 1;
  const tone = assigned > seats ? 'bg-danger' : share >= 0.9 ? 'bg-warning' : 'bg-primary';
  return (
    <span className="flex min-w-32 flex-col gap-1.5">
      <span className="text-[13px] tabular-nums">
        {assigned.toLocaleString()} <span className="text-muted">of {seats.toLocaleString()}</span>
      </span>
      <span
        className="block h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-surface-3"
        role="img"
        aria-label={`${assigned} of ${seats} seats assigned`}
      >
        <span className={cn('block h-full rounded-full', tone)} style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
    </span>
  );
}

/**
 * The figures a report leads with, in a band of tiles. A tile can filter the table below (Needs review); the chosen one
 * is tinted and underlined, like the portal's counts.
 */
export function ReportHighlights({
  items,
  pressed,
  onPress,
}: {
  items: ReportHighlight[];
  /** The label of the tile that's filtering, if any. */
  pressed?: string;
  /** Tiles that filter, by label. */
  onPress?: Partial<Record<string, () => void>>;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-2 sm:grid-cols-3',
        items.length >= 6 ? 'lg:grid-cols-6' : items.length === 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4',
      )}
    >
      {items.map((item) => {
        const body = (
          <>
            <span className="block truncate text-[11px] font-semibold text-muted">{item.label}</span>
            <strong
              className={cn(
                'mt-1.5 block truncate text-[22px] leading-none font-bold tracking-[-0.04em] tabular-nums',
                item.tone === 'warning' && 'text-warning',
                item.tone === 'success' && 'text-success',
              )}
              title={item.value}
            >
              {item.value}
            </strong>
          </>
        );
        const cell = 'min-w-0 border-b border-border px-5 py-4 text-left not-last:border-r';
        const press = onPress?.[item.label];
        return press ? (
          <button
            key={item.label}
            type="button"
            aria-pressed={pressed === item.label}
            onClick={press}
            className={cn(
              cell,
              'hover:bg-primary-soft/60 aria-pressed:bg-primary-soft/60 aria-pressed:shadow-[inset_0_-2px_0_var(--primary)]',
            )}
          >
            {body}
          </button>
        ) : (
          <div key={item.label} className={cell}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
