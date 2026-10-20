import { cn } from '@/lib/cn';
import { useDarkMode, useTheme } from '@/lib/branding';

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  const theme = useTheme();
  const dark = useDarkMode();
  // A custom logo replaces the Atlas mark (Administration → Theme); the dark one is used in dark mode.
  const logo = (dark && theme?.logoDark) || theme?.logo;
  if (logo)
    return (
      <span className={cn('inline-flex items-center', className)}>
        <img
          src={logo}
          alt={theme?.brandName || theme?.name}
          className={cn('max-h-10 w-auto rounded-md object-contain', compact ? 'max-w-10' : 'max-w-44')}
        />
      </span>
    );
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-semibold', className)}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="5" fill="#245fba" />
        <path d="M7 24 14 8h4l7 16h-5l-1.3-3.5h-6L11.3 24Zm7-7h3.5L16 12Z" fill="#ffffff" />
      </svg>
      {!compact && (
        <span className="leading-none">
          <span className="block text-base tracking-tight">{theme?.brandName || theme?.name || 'Atlas'}</span>
          <span className="mt-1 block text-[8px] font-semibold tracking-[0.16em] opacity-65">
            {theme?.tagline || 'ATLAS WORKSPACE'}
          </span>
        </span>
      )}
    </span>
  );
}
