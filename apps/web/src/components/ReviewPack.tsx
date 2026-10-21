import { useQueryClient } from '@tanstack/react-query';
import { Presentation } from 'lucide-react';
import type { ReportDefinition, ReportRunDetail } from '@atlas/shared';
import { Button, useToast } from '@/components/ui';
import { useAction } from '@/lib/actions';
import { api, download } from '@/lib/api';
import { DEMO } from '@/lib/demo';

/**
 * One click from the client's page: a quarterly business review captured now and downloaded as the branded PDF pack.
 * The snapshot stays in Reports history, where it can be compared, shared with the client or scheduled.
 */
export function ReviewPackButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { busy, act } = useAction({ toast: true });
  const build = () =>
    act('pack', async () => {
      const definition: ReportDefinition = {
        kind: 'review',
        title: `${clientName} quarterly review`,
        clientIds: [clientId],
        withinDays: 90,
        includeMicrosoft: true,
      };
      const run = await api<ReportRunDetail>('/reports/runs', { method: 'POST', body: definition });
      void qc.invalidateQueries({ queryKey: ['report-history'] });
      await download(`/reports/runs/${run.id}/export?format=pdf&whole=1`, `${definition.title}.pdf`);
      toast('Review pack downloaded. It’s also in this client’s report history.');
    });
  return (
    <Button variant="secondary" size="sm" loading={busy === 'pack'} disabled={DEMO} onClick={() => void build()}>
      <Presentation /> Review pack
    </Button>
  );
}
