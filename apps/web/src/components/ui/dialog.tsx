import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';

interface PanelProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}
const WIDTH = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' } as const;

/**
 * Native <dialog>: focus trapping, Escape to close, and the top layer without injected styles (keeps CSP strict).
 * Shared by the centred dialog and the drawer, which differ only in where the panel sits.
 */
function Panel({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  bodyClassName,
  onBackdrop,
}: PanelProps & { className: string; bodyClassName: string; onBackdrop?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click on the dimmed page lands on the <dialog> itself; the panel's contents are its children.
      onClick={onBackdrop && ((e) => e.target === e.currentTarget && onBackdrop())}
      aria-labelledby={titleId}
      className={cn('overflow-hidden border-border-strong bg-surface p-0 text-text', className)}
    >
      {open && (
        <div className={cn('flex flex-col', bodyClassName)}>
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-1">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold tracking-[-0.01em]">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border px-6 py-4">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

/** A centred dialog, for a decision or a short task: confirming, naming something, a code. */
export function Dialog({ size = 'md', ...props }: PanelProps) {
  return (
    <Panel
      {...props}
      className={cn('animate-dialog m-auto max-h-[90vh] w-[calc(100%-2rem)] rounded-xl border', WIDTH[size])}
      bodyClassName="max-h-[90vh]"
    />
  );
}

/**
 * A panel from the edge of the screen, for longer work beside the page: a record's form, or a list opened from a
 * card. It fills the height, so a long form scrolls inside it with its buttons always in reach, and a click on the
 * dimmed page closes it. On a phone it takes the whole screen.
 */
export function Drawer({ size = 'md', side = 'right', ...props }: PanelProps & { side?: 'left' | 'right' }) {
  return (
    <Panel
      {...props}
      onBackdrop={props.onClose}
      className={cn(
        'fixed inset-y-0 m-0 h-dvh max-h-none w-full',
        side === 'right'
          ? 'animate-drawer-right right-0 left-auto border-l'
          : // A menu from the left leaves a strip of the page showing on a phone, to tap back to it.
            'animate-drawer-left right-auto left-0 w-[85vw] border-r',
        WIDTH[size],
      )}
      bodyClassName="h-full"
    />
  );
}
