import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/cn';

/*
 * The parts of a list panel, as in the IT Health Tech portal's People & access: a header with its actions, a row of
 * counts that filter the list, a search toolbar, column labels, and rows. A panel is a Card; the list's columns are
 * a grid template the caller gives both ListHead and ListRow, so they line up.
 */

/** Title, a line about the source, and actions on the right. */
export function PanelHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-[21px] py-[19px] max-sm:p-[18px]">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1.5 text-[10px] font-bold tracking-[0.12em] text-muted uppercase">{eyebrow}</p>}
        <h2 className="text-base font-bold tracking-[-0.03em] text-text">{title}</h2>
        {description && <p className="mt-[5px] text-xs leading-normal text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Counts across the panel that also filter it: the chosen one is tinted and underlined. Four fit a row; on a phone
 * they stack their label over the number.
 */
export function MetricTabs<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: { id: T; label: string; count: number | string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 border-b border-border sm:grid-cols-4">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
          className="flex min-w-0 items-center justify-between gap-2 border-border bg-surface px-[17px] py-[14px] text-left not-last:border-r hover:bg-primary-soft/60 aria-pressed:bg-primary-soft/60 aria-pressed:shadow-[inset_0_-2px_0_var(--primary)] max-sm:flex-col max-sm:items-start max-sm:p-[11px] max-sm:nth-[2n]:border-r-0 max-sm:nth-[-n+2]:border-b"
        >
          <span className="truncate text-[11px] font-semibold text-muted">{item.label}</span>
          <strong className="text-xl font-bold tracking-[-0.05em] text-text tabular-nums max-sm:text-lg">
            {item.count}
          </strong>
        </button>
      ))}
    </div>
  );
}

/** Search across the list, any extra controls, and how many rows show. */
export function ListToolbar({
  query,
  onQuery,
  placeholder,
  shown,
  total,
  noun,
  children,
}: {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  shown: number;
  total: number;
  /** What a row is, for the count: "user" makes "3 of 17 users". */
  noun: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-[9px] border-b border-border px-[19px] py-3 max-sm:px-3.5">
      <label className="flex h-[39px] min-w-[220px] flex-1 items-center gap-[9px] rounded-md border border-border bg-surface px-[11px] text-muted focus-within:border-primary/50 max-sm:min-w-full">
        <Search className="size-4 shrink-0" aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full min-w-0 bg-transparent text-xs text-text outline-none placeholder:text-muted/80"
        />
      </label>
      {children}
      <span className="text-xs whitespace-nowrap text-muted tabular-nums">
        {shown} of {total} {total === 1 ? noun : `${noun}s`}
      </span>
    </div>
  );
}

/**
 * The column labels: small, spaced capitals on a faint band. `columns` is the grid template shared with the rows; a
 * label can carry the class that hides its column on small screens, as the row's cell does.
 */
export function ListHead({
  columns,
  labels,
}: {
  columns: string;
  labels: (string | { label: string; className: string })[];
}) {
  return (
    <div
      aria-hidden
      className={cn(
        'grid items-center gap-x-[9px] border-b border-border bg-surface-2 px-[18px] py-2.5 text-[10px] font-bold tracking-[0.08em] text-muted uppercase max-sm:px-2.5',
        columns,
      )}
    >
      {labels.map((label, i) =>
        typeof label === 'string' ? (
          <span key={i} className="truncate">
            {label}
          </span>
        ) : (
          <span key={i} className={cn('truncate', label.className)}>
            {label.label}
          </span>
        ),
      )}
    </div>
  );
}

/** One row of a list panel; its actions brighten as it's pointed at. */
export function ListRow({
  columns,
  children,
  className,
}: {
  columns: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'group grid min-h-[66px] items-center gap-x-[9px] border-b border-border bg-surface px-[18px] py-3 text-text last:border-b-0 hover:bg-primary-soft/40 max-sm:px-2.5 max-sm:py-2.5',
        columns,
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The row's subject: a lettered square, a name, and a second line. */
export function RowTitle({ mark, title, detail }: { mark: ReactNode; title: ReactNode; detail?: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-[11px]">
      <span
        aria-hidden
        className="grid size-[34px] shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-[13px] font-bold text-text-2 max-sm:size-[29px] [&_svg]:size-4"
      >
        {mark}
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <strong className="truncate text-xs font-[650]">{title}</strong>
        {detail && <small className="truncate text-[11px] text-muted">{detail}</small>}
      </span>
    </span>
  );
}

/** Icon buttons at the end of a row: quiet until the row is pointed at or focused. */
export function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="flex items-center justify-end gap-0.5 opacity-65 group-focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100 [&_button]:size-[30px] [&_button]:text-primary">
      {children}
    </span>
  );
}

const PILL = {
  good: 'bg-success-soft text-success',
  bad: 'bg-danger-soft text-danger',
  warn: 'bg-warning-soft text-warning',
  info: 'bg-info-soft text-info',
  muted: 'bg-surface-3 text-muted',
} as const;
/** A state in a tinted pill: Enabled, Blocked, Active. */
export function StatusPill({ tone, children }: { tone: keyof typeof PILL; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex w-max max-w-full items-center gap-[5px] rounded-md px-2 py-1.5 text-[11px] leading-none font-[650] whitespace-nowrap [&_svg]:size-3',
        PILL[tone],
      )}
    >
      {children}
    </span>
  );
}
