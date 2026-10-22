import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  Circle,
  DatabaseBackup,
  FileInput,
  Mail,
  MonitorCog,
  Palette,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { SetupStatus } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Card, FormError, PageHeader, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { cn } from '@/lib/cn';

interface Step {
  id: keyof SetupStatus | 'mfa';
  icon: LucideIcon;
  title: string;
  why: string;
  to: string;
  action: string;
  /** Worth doing, but Atlas works without it. */
  optional?: boolean;
}

/** A new installation's first steps, in the order they make sense. */
const STEPS: Step[] = [
  {
    id: 'mfa',
    icon: ShieldCheck,
    title: 'Turn on two-step sign-in for yourself',
    why: 'Your account can open every password. A second step keeps it yours.',
    to: '/account',
    action: 'Your account',
  },
  {
    id: 'branding',
    icon: Palette,
    title: 'Make it yours',
    why: 'Your name, logo and colours on every page, the sign-in page, the client portal and report PDFs.',
    to: '/admin/theme',
    action: 'Theme',
  },
  {
    id: 'email',
    icon: Mail,
    title: 'Connect email',
    why: 'For invitations, password resets, alerts and scheduled reports. Microsoft 365 or any mail server.',
    to: '/admin/email',
    action: 'Email & alerts',
  },
  {
    id: 'import',
    icon: FileInput,
    title: 'Bring your documentation across',
    why: 'Import clients, assets, passwords and documents from Hudu, IT Glue or a spreadsheet.',
    to: '/admin/data',
    action: 'Import & export',
    optional: true,
  },
  {
    id: 'client',
    icon: Building2,
    title: 'Add your first client',
    why: 'Everything in Atlas belongs to a client. An import adds them for you.',
    to: '/clients',
    action: 'Clients',
  },
  {
    id: 'rmm',
    icon: MonitorCog,
    title: 'Connect ConnectWise RMM',
    why: 'Devices arrive as assets and stay up to date, with online status, protection and warranty.',
    to: '/admin/data',
    action: 'Import & export',
    optional: true,
  },
  {
    id: 'microsoft',
    icon: MonitorCog,
    title: 'Connect Microsoft 365',
    why: 'Users, licenses and domains from each client’s tenant, and the Microsoft 365 reports.',
    to: '/admin/data',
    action: 'Import & export',
    optional: true,
  },
  {
    id: 'team',
    icon: Users,
    title: 'Invite your team',
    why: 'Each technician signs in as themselves, so the access history says who did what.',
    to: '/admin/users',
    action: 'People & access',
  },
  {
    id: 'backup',
    icon: DatabaseBackup,
    title: 'Take a first backup',
    why: 'Atlas backs itself up on a schedule. Run one now and check where the file goes.',
    to: '/admin/status',
    action: 'System status',
  },
];

export const useSetupStatus = (enabled = true) =>
  useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<SetupStatus>('/admin/setup'),
    enabled,
    staleTime: 30_000,
  });

/** Steps with whether each is done: the server's view, plus two-step sign-in, which the browser already knows. */
export function useSetupSteps() {
  const actor = useActor();
  const status = useSetupStatus(actor.isAdmin);
  const steps = STEPS.map((step) => ({
    ...step,
    done: step.id === 'mfa' ? actor.mfa : !!status.data?.[step.id],
  }));
  const required = steps.filter((s) => !s.optional);
  return { steps, status, left: required.filter((s) => !s.done).length, requiredCount: required.length };
}

/** Administration → Set up Atlas: a new installation's first steps, each ticked off when it's really done. */
export function Setup() {
  const { steps, status, left } = useSetupSteps();
  const done = steps.filter((s) => s.done).length;
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Set up Atlas"
        description="The first steps for a new installation. Each one ticks itself off once it's done, however you did it."
      />
      <FormError message={status.error?.message} />
      <Card className="overflow-hidden">
        <div className="border-b border-border px-[21px] py-[19px]">
          <p className="text-sm font-semibold">
            {left === 0 ? 'Atlas is set up.' : `${left} essential ${left === 1 ? 'step' : 'steps'} left`}
            <span className="font-normal text-muted">
              {' '}
              · {done} of {steps.length} done
            </span>
          </p>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-label="Setup progress"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={done}
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${(done / steps.length) * 100}%` }} />
          </div>
        </div>
        {status.isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : (
          <ol className="divide-y divide-border">
            {steps.map(({ id, icon: Icon, title, why, to, action, optional, done: complete }) => (
              <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-[21px] py-4 max-sm:px-[18px]">
                {complete ? (
                  <CheckCircle2 className="size-5 shrink-0 text-success" aria-label="Done" />
                ) : (
                  <Circle className="size-5 shrink-0 text-border-strong" aria-label="To do" />
                )}
                <span
                  aria-hidden
                  className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface-2 text-text-2 [&_svg]:size-4"
                >
                  <Icon />
                </span>
                <div className="min-w-0 flex-1 basis-64">
                  <p className={cn('text-sm font-semibold', complete && 'text-muted')}>
                    {title}
                    {optional && <span className="ml-2 text-xs font-normal text-muted">Optional</span>}
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted">{why}</p>
                </div>
                <AppLink
                  to={to}
                  className={cn(
                    'inline-flex h-9 items-center gap-1.5 rounded-md px-3.5 text-sm font-semibold',
                    complete
                      ? 'text-text-2 hover:bg-surface-2'
                      : 'border border-border bg-surface text-text hover:border-primary/40 hover:bg-primary-soft/40',
                  )}
                >
                  {complete ? 'Review' : action} <ArrowRight className="size-4" aria-hidden />
                </AppLink>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
