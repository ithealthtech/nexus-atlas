import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { AppLink } from './AppLink';

/** The way back to the list a record came from. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <AppLink
      to={to}
      className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-text print:hidden"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> {children}
    </AppLink>
  );
}

/**
 * The top of a single record: what kind of thing it is, its name, and one line of status and history, with the
 * actions to the right. Every detail page uses this, so assets, passwords, documents and checklists read alike.
 */
export function DetailHeader({
  kind,
  title,
  star,
  status,
  meta,
  actions,
}: {
  kind: ReactNode;
  title: ReactNode;
  /** The favourite toggle, sitting just after the name. */
  star?: ReactNode;
  /** Badges, shown before the meta line. */
  status?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <p className="mb-1 text-[13px] text-muted">{kind}</p>
        <div className="flex items-center gap-1.5">
          <h1 className="min-w-0 text-[26px] leading-tight font-semibold tracking-[-0.02em] break-words text-text">
            {title}
          </h1>
          {star}
        </div>
        {(status || meta) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            {status}
            {meta && <span>{meta}</span>}
          </div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
    </header>
  );
}
