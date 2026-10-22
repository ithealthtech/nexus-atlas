import type { HTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-surface', className)} {...props} />;
}
export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-1', className)}>
      <div>
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
    </div>
  );
}

// A status is a small dot and a word, not a filled pill: a column of them stays quiet, and the few that differ
// are the ones that catch the eye.
const tones = {
  neutral: 'text-text-2 before:opacity-45',
  quiet: 'font-normal text-muted before:hidden',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};
export type Tone = keyof typeof tones;
export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap before:size-1.5 before:shrink-0 before:rounded-full before:bg-current has-[svg]:before:hidden [&_svg]:size-3',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-md bg-surface-3 font-semibold text-text-2',
        size === 'sm' ? 'size-7 text-[11px]' : size === 'lg' ? 'size-12 text-base' : 'size-9 text-xs',
        className,
      )}
    >
      {initials(name) || '?'}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-[13px] text-muted">{eyebrow}</p>}
        <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em] text-text">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[13px] leading-5 text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state flex flex-col items-center px-6 py-8 text-center">
      <Icon className="mb-3 size-6 text-muted" strokeWidth={1.5} aria-hidden />
      <h3 className="font-semibold text-text">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-surface-3', className)} aria-hidden />;
}

export function Stat({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: LucideIcon;
}) {
  return (
    <div className="h-full rounded-md border border-border bg-surface px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted">{label}</span>
        {Icon && <Icon className="size-4 text-muted" aria-hidden />}
      </div>
      <div className="mt-1 text-[28px] leading-none font-semibold tracking-[-0.02em] text-text tabular-nums">
        {value}
      </div>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}
