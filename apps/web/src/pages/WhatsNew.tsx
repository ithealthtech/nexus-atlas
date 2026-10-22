import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  ChartNoAxesCombined,
  ClipboardPaste,
  HeartPulse,
  LayoutPanelLeft,
  Monitor,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { WHATS_NEW, type WorkspacePrefs } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Card, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { useActor } from '@/lib/session';

/** One part of the release: what it is, in a few points, and where to see it. */
interface Highlight {
  icon: LucideIcon;
  title: string;
  summary: string;
  points: ReactNode[];
  to: string;
  link: string;
}

const HIGHLIGHTS: Highlight[] = [
  {
    icon: ChartNoAxesCombined,
    title: 'Reports that do the work',
    summary: 'Every report reads like the rest of Atlas now: the figures first, then every section on one page.',
    points: [
      <>
        <strong>Client review pack:</strong> a quarterly business review in one branded PDF, in one click from a client.
      </>,
      <>
        <strong>Scheduled reports and alerts:</strong> email a report every month, or send one only when something new
        needs attention.
      </>,
      <>
        <strong>New reports:</strong> cyber insurance readiness with evidence, a savings finder that prices unused
        seats, and Microsoft 365 accounts and usage.
      </>,
    ],
    to: '/reports',
    link: 'Open Reports',
  },
  {
    icon: HeartPulse,
    title: 'A health score for every client',
    summary:
      'A score from 0 to 100 from security, endpoints, documentation and renewals, with its trend and what would raise it.',
    points: [
      'It sits in each client’s header and on the Clients list.',
      'The dashboard shows the clients that need you most.',
    ],
    to: '/clients',
    link: 'See your clients',
  },
  {
    icon: ClipboardPaste,
    title: 'Faster documenting',
    summary: 'The small things that save a few minutes, many times a day.',
    points: [
      <>
        <strong>Smart paste:</strong> paste <code>ipconfig /all</code> or <code>systeminfo</code> into a new asset and
        its fields fill themselves in.
      </>,
      <>
        <strong>Wi-Fi join codes:</strong> any Wi-Fi password shows a code to scan, and prints as a card for the waiting
        room.
      </>,
      <>
        <strong>Licenses at a glance:</strong> every subscription with its seats, and everyone with their licenses, on
        one page.
      </>,
    ],
    to: '/clients',
    link: 'Open a client',
  },
  {
    icon: LayoutPanelLeft,
    title: 'A cleaner workspace',
    summary: 'Pages with room to breathe, forms that slide in beside the page, and layouts that work on a phone.',
    points: [
      'Administration has tabs like every other area.',
      <>
        Your menu stays yours: rail and panel, sidebar, or top bar, under <strong>Your account → Menu</strong>.
      </>,
    ],
    to: '/account',
    link: 'Choose your menu',
  },
  {
    icon: Monitor,
    title: 'Atlas for Windows 1.0',
    summary:
      'The desktop app for technicians: search from anywhere with Ctrl+Shift+Space, copy passwords behind Windows Hello, and read documents with their formatting.',
    points: [
      'A Settings page, a dark theme, and a native build for Arm laptops.',
      'It takes your Atlas’s favicon as its own icon.',
    ],
    to: '/account',
    link: 'Download it from Your account',
  },
];

/**
 * What's new in this release, in plain words, with a link to each part. Opening it puts away the dashboard's card for
 * good; it stays here, under the account menu, to come back to.
 */
export function WhatsNew() {
  const actor = useActor();
  const client = useQueryClient();
  useEffect(() => {
    if (!actor.isStaff) return;
    void api<WorkspacePrefs>('/account/whats-new', { method: 'POST', body: { seen: WHATS_NEW } })
      .then((prefs) => client.setQueryData(['workspace'], prefs))
      .catch(() => undefined);
  }, [actor.isStaff, client]);

  return (
    <>
      <PageHeader
        eyebrow={`Atlas ${WHATS_NEW}`}
        title={`What’s new in Atlas ${WHATS_NEW}`}
        description="The biggest update yet: reports that do the work, a health score for every client, faster documenting, a cleaner workspace, and Atlas for Windows 1.0."
      />
      <div className="space-y-5">
        {HIGHLIGHTS.map(({ icon: Icon, title, summary, points, to, link }) => (
          <Card key={title} className="overflow-hidden">
            <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-start max-sm:p-5">
              <span
                aria-hidden
                className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary [&_svg]:size-5"
              >
                <Icon />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-bold tracking-[-0.02em]">{title}</h2>
                <p className="mt-1 text-sm text-muted">{summary}</p>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-text-2">
                  {points.map((point, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
                <AppLink
                  to={to}
                  className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
                >
                  {link} <ArrowRight className="size-4" aria-hidden />
                </AppLink>
              </div>
            </div>
          </Card>
        ))}
        <p className="flex items-center gap-2 text-xs text-muted">
          <Sparkles className="size-3.5" aria-hidden /> Everything else that changed is in the release notes, under
          Administration → Updates.
        </p>
      </div>
    </>
  );
}

/**
 * The dashboard's card for someone who hasn't seen What's new: one line, a way in, and a way to put it away.
 */
export function WhatsNewCard({ prefs }: { prefs: WorkspacePrefs | undefined }) {
  const client = useQueryClient();
  if (!prefs || prefs.seenWhatsNew === WHATS_NEW) return null;
  const dismiss = () =>
    void api<WorkspacePrefs>('/account/whats-new', { method: 'POST', body: { seen: WHATS_NEW } })
      .then((saved) => client.setQueryData(['workspace'], saved))
      .catch(() => undefined);
  return (
    <Card className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-primary/30 bg-primary-soft/50 px-5 py-4">
      <span
        aria-hidden
        className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface text-primary [&_svg]:size-5"
      >
        <Sparkles />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-bold">Welcome to Atlas {WHATS_NEW}</h2>
        <p className="mt-0.5 text-[13px] text-text-2">
          Reports that do the work, a health score for every client, smart paste, and Atlas for Windows 1.0.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <AppLink
          to="/whats-new"
          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-sm font-semibold text-primary-fg hover:bg-primary-hover"
        >
          See what&rsquo;s new <ArrowRight className="size-4" aria-hidden />
        </AppLink>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss the welcome to Atlas card"
          className="h-9 rounded-md px-3 text-sm font-medium text-text-2 hover:bg-surface hover:text-text"
        >
          Dismiss
        </button>
      </div>
    </Card>
  );
}
