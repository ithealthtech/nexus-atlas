import type { HTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-surface shadow-card', className)} {...props} />;
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
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4', className)}>
      <div>
        <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

const tones = {
  neutral: 'bg-surface-3 text-text-2',
  primary: 'bg-primary-soft text-primary',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
};
export type Tone = keyof typeof tones;
export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap [&_svg]:size-3',
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

const avatarTones = [
  'bg-info-soft text-info',
  'bg-primary-soft text-primary',
  'bg-warning-soft text-warning',
  'bg-success-soft text-success',
];
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const tone = avatarTones[[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % avatarTones.length];
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-lg font-semibold',
        tone,
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
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-2 text-xs font-bold tracking-[0.14em] text-muted uppercase">{eyebrow}</p>}
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-text">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
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
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-xl bg-primary-soft text-primary">
        <Icon className="size-6" aria-hidden />
      </span>
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
  icon: LucideIcon;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between text-[13px] text-muted">
        {label}
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-text">{value}</div>
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </Card>
  );
}
