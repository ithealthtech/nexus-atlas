import { cn } from '@/lib/cn';

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-semibold', className)}>
      <svg viewBox="0 0 32 32" className="size-9 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="9" fill="#c4e99a" />
        <path d="M7 24 14 8h4l7 16h-5l-1.3-3.5h-6L11.3 24Zm7-7h3.5L16 12Z" fill="#173e32" />
      </svg>
      {!compact && (
        <span className="leading-none">
          <span className="block text-xl tracking-tight">atlas</span>
          <span className="mt-1 block text-[9px] font-bold tracking-[0.2em] opacity-60">FOR MSPs</span>
        </span>
      )}
    </span>
  );
}
