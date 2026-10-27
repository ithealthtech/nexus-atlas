import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { AlertWorkspace } from '@atlas/shared';
import { Badge, Button, Card, FormError, PageHeader, Skeleton } from '@/components/ui';
import { Library } from '@/components/alerting/Library';
import { TemplateEditor } from '@/components/alerting/TemplateEditor';
import { RuleEditor } from '@/components/alerting/RuleEditor';
import { Preview } from '@/components/alerting/Preview';
import { ALERTING_BASE, useAlertEditor } from '@/components/alerting/useAlertEditor';
import { api } from '@/lib/api';
import { useClients, useUsers } from '@/lib/queries';

export function AlertingPage() {
  const query = useQuery({ queryKey: ['alerting'], queryFn: () => api<AlertWorkspace>(ALERTING_BASE) });
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Administration"
        title="Alerting center"
        description="Draft rules and custom messages for email and Microsoft Teams."
      />
      <div className="flex flex-wrap gap-5 text-sm font-semibold text-primary">
        <Link to="/admin/email">Email connection & current alerts</Link>
        <Link to="/admin/teams">Teams connection, channels & delivery history</Link>
      </div>
      <Card className="space-y-2 p-5">
        <Badge tone="info">Draft workspace</Badge>
        <p className="text-sm text-text-2">
          Save templates and test rule conditions here. Drafts do not change automatic delivery. Current email and Teams
          alerts continue using their existing settings.
        </p>
      </Card>
      <FormError message={query.error?.message} />
      {query.data ? <AlertStudio initial={query.data} /> : query.isLoading && <Skeleton className="h-80" />}
    </div>
  );
}

function AlertStudio({ initial }: { initial: AlertWorkspace }) {
  const e = useAlertEditor(initial);
  const clients = useClients();
  const users = useUsers();
  return (
    <fieldset disabled={!!e.busy} className="max-w-5xl min-w-0 space-y-6">
      <legend className="sr-only">Alert drafts</legend>
      <Library editor={e} />
      <FormError message={clients.error?.message ?? users.error?.message} />
      {e.rule && clients.data && users.data && (
        <RuleEditor
          key={e.rule.id}
          rule={e.rule}
          templates={e.workspace.templates}
          clients={clients.data}
          users={users.data}
          change={e.changeRule}
        />
      )}
      {e.rule && (clients.isLoading || users.isLoading) && <Skeleton className="h-80" />}
      {e.template && <TemplateEditor key={e.template.id} template={e.template} change={e.changeTemplate} />}
      <FormError message={e.error} />
      <div className="flex flex-wrap items-center gap-4">
        <Button loading={e.busy === 'save'} disabled={!!e.busy || !e.dirty} onClick={() => void e.save()}>
          Save drafts
        </Button>
        <span className="text-sm text-muted" role="status">
          {e.dirty ? 'Unsaved changes' : `Saved drafts · revision ${e.workspace.revision}`}
        </span>
      </div>
      {e.template && (
        <Preview
          sample={e.sample}
          change={e.setSample}
          clients={clients.data ?? []}
          result={e.result}
          run={() => void e.run()}
          busy={!!e.busy}
        />
      )}
    </fieldset>
  );
}
