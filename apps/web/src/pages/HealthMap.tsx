import { HeartPulse } from 'lucide-react';
import { HEALTH_PARTS, HEALTH_PART_INFO, healthGrade, type HealthTone } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { HealthChange, useHealthList } from '@/components/ClientHealth';
import { Card, EmptyState, FormError, PageHeader, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';

// The table scrolls inside its card on a phone; the card is `relative` so the screen-reader-only labels in the
// cells scroll with it rather than widening the page.

// A cell's fill and text by grade: soft enough that the numbers stay readable in both themes.
const CELL: Record<HealthTone, string> = {
  success: 'bg-success-soft text-success',
  primary: 'bg-primary-soft text-primary',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  neutral: 'bg-surface-2 text-muted',
};

function Cell({ score, to }: { score: number | null; to: string }) {
  const grade = healthGrade(score);
  return (
    <td className="p-1">
      <AppLink
        to={to}
        className={cn(
          'flex h-11 items-center justify-center rounded-md text-sm font-semibold tabular-nums hover:ring-2 hover:ring-border-strong',
          CELL[grade.tone],
        )}
        title={grade.label}
      >
        {score ?? '–'}
        <span className="sr-only">, {grade.label}</span>
      </AppLink>
    </td>
  );
}

/**
 * Every client against every part of its health score, on one screen: the weak spots across the whole portfolio
 * at a glance. Lowest overall first; each cell opens the client.
 */
export function HealthMap() {
  const list = useHealthList();
  return (
    <>
      <PageHeader
        eyebrow="Clients"
        title="Health map"
        description="Every client's score, and each part of it, lowest first. Select a cell to open the client."
      />
      <FormError message={list.error?.message} />
      {list.isLoading ? (
        <Skeleton className="h-64" />
      ) : !list.data?.length ? (
        <Card>
          <EmptyState icon={HeartPulse} title="No scores yet" description="Scores appear once you have clients." />
        </Card>
      ) : (
        <Card className="relative overflow-x-auto p-3">
          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-sm">
            <caption className="sr-only">Client health by part, lowest overall score first</caption>
            <thead>
              <tr className="text-xs text-muted">
                <th scope="col" className="px-3 py-2 text-left font-medium">
                  Client
                </th>
                <th scope="col" className="w-24 px-1 py-2 font-medium">
                  Overall
                </th>
                {HEALTH_PARTS.map((part) => (
                  <th
                    key={part}
                    scope="col"
                    className="w-28 px-1 py-2 font-medium"
                    title={HEALTH_PART_INFO[part].description}
                  >
                    {HEALTH_PART_INFO[part].label}
                  </th>
                ))}
                <th scope="col" className="w-16 px-1 py-2 font-medium">
                  30 days
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.clientId}>
                  <th scope="row" className="max-w-56 min-w-36 truncate px-3 text-left font-medium">
                    <AppLink to={`/clients/${c.clientId}`} className="hover:underline">
                      {c.clientName}
                    </AppLink>
                  </th>
                  <Cell score={c.score} to={`/clients/${c.clientId}`} />
                  {HEALTH_PARTS.map((part) => (
                    <Cell key={part} score={c.parts?.[part] ?? null} to={`/clients/${c.clientId}`} />
                  ))}
                  <td className="px-1">
                    <HealthChange change={c.change} className="justify-center" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
