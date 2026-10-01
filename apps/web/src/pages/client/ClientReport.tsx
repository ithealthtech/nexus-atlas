import { AppLink } from '@/components/AppLink';
import { useParams } from '@tanstack/react-router';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button, Card, CardHeader, Skeleton } from '@/components/ui';
import { RmmHealthCard } from '@/components/RmmHealth';
import { ClientSecurityCard } from '@/components/CwSecurity';
import { TrackerCard } from '@/components/Trackers';
import { TicketsCard } from '@/components/Tickets';
import { WarrantyCard } from '@/components/Warranty';
import { SoftwareCard } from '@/components/Inventory';
import { AssetStatsCard } from '@/components/AssetStats';
import { useAssets, useClient, useDocuments, useLayouts } from '@/lib/queries';

/**
 * A one-page monthly report for a client, from what Atlas already has: documentation coverage, ConnectWise security
 * and compliance, tickets, renewals, and endpoint health. Printed or saved as a PDF from the browser.
 */
export function ClientReport() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const client = useClient(clientId);
  const assets = useAssets({ client: clientId }).data ?? [];
  const layouts = useLayouts().data ?? [];
  const docs = (useDocuments({ client: clientId }).data ?? []).filter((d) => !d.archived);
  if (client.isLoading) return <Skeleton className="h-40" />;
  if (!client.data) return null;
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const counts = layouts
    .map((l) => ({ ...l, count: assets.filter((a) => a.layoutId === l.id).length }))
    .filter((l) => l.count > 0);
  const overdue = docs.filter((d) => d.reviewDate && d.reviewDate < today).length;
  const section = 'break-inside-avoid';
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <AppLink
          to={`/clients/${clientId}`}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text"
        >
          <ArrowLeft className="size-4" /> {client.data.name}
        </AppLink>
        <Button onClick={() => window.print()}>
          <Printer /> Print or save as PDF
        </Button>
      </div>
      <header>
        <p className="text-sm font-medium text-muted">Monthly report · {month}</p>
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight">{client.data.name}</h1>
      </header>
      <Card className={section}>
        <CardHeader
          title="Documentation"
          description={`${assets.length} asset${assets.length === 1 ? '' : 's'} and ${docs.length} document${docs.length === 1 ? '' : 's'} on record${overdue ? `; ${overdue} document${overdue === 1 ? ' is' : 's are'} past review` : ''}.`}
        />
        {counts.length > 0 && (
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 px-5 py-4 text-sm sm:grid-cols-3">
            {counts.map((l) => (
              <li key={l.id} className="flex justify-between gap-2">
                <span className="truncate">{l.name}</span>
                <span className="tabular-nums text-muted">{l.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <div className={section}>
        <ClientSecurityCard clientId={clientId} />
      </div>
      <div className={section}>
        <TicketsCard clientId={clientId} />
      </div>
      <div className={section}>
        <TrackerCard clientId={clientId} />
      </div>
      <div className={section}>
        <WarrantyCard clientId={clientId} />
      </div>
      <div className={section}>
        <RmmHealthCard clientId={clientId} />
      </div>
      <div className={section}>
        <AssetStatsCard clientId={clientId} />
      </div>
      <div className={section}>
        <SoftwareCard clientId={clientId} />
      </div>
    </div>
  );
}
