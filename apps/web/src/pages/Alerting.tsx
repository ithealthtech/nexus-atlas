import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Clock, History, Radio, Route, Save } from 'lucide-react';
import type { AlertWorkspace } from '@atlas/shared';
import { Badge, Button, FormError, PageHeader, Skeleton } from '@/components/ui';
import { Versions } from '@/components/alerting/Versions';
import { DeliveryHistory, DeliveryPanel, TestSend } from '@/components/alerting/Delivery';
import { Library } from '@/components/alerting/Library';
import { RuleLibrary } from '@/components/alerting/RuleLibrary';
import { TemplateEditor } from '@/components/alerting/TemplateEditor';
import { RuleEditor } from '@/components/alerting/RuleEditor';
import { Preview } from '@/components/alerting/Preview';
import { ALERTING_BASE, useAlertEditor } from '@/components/alerting/useAlertEditor';
import { api } from '@/lib/api';
import { useClients, useGroups, useUsers } from '@/lib/queries';
import { ScheduleEditor } from '@/components/alerting/Schedule';
import { Pauses } from '@/components/alerting/Pauses';

const SECTIONS = [
  {
    id: 'templates',
    label: 'Templates',
    icon: BookOpen,
    description: 'Find a saved message, edit it, or use it in a rule.',
  },
  {
    id: 'rules',
    label: 'Rules',
    icon: Route,
    description: 'Choose the clients, recipients and conditions for each alert.',
  },
  {
    id: 'timing',
    label: 'Timing & pauses',
    icon: Clock,
    description: 'Set quiet hours, daily summaries and client pauses.',
  },
  {
    id: 'publish',
    label: 'Publish & delivery',
    icon: Radio,
    description: 'Publish saved drafts, review what would send, then go live.',
  },
  {
    id: 'history',
    label: 'Delivery history',
    icon: History,
    description: 'See what sent, what failed and what needs attention.',
  },
] as const;
type Section = (typeof SECTIONS)[number]['id'];

export function AlertingPage() {
  const query = useQuery({ queryKey: ['alerting'], queryFn: () => api<AlertWorkspace>(ALERTING_BASE) });
  return (
    <div className="space-y-6">
      <FormError message={query.error?.message} />
      {query.data ? (
        <AlertStudio initial={query.data} />
      ) : (
        <>
          <PageHeader title="Alerting center" />
          {query.isLoading && <Skeleton className="h-80" />}
          {query.isError && (
            <div className="space-y-3 rounded-lg border border-border-strong bg-surface p-4">
              <p className="text-sm text-text-2">
                Drafts could not be loaded. Delivery controls and history are still available below.
              </p>
              <Button variant="secondary" loading={query.isFetching} onClick={() => void query.refetch()}>
                Retry loading drafts
              </Button>
            </div>
          )}
          <div className="grid items-start gap-5 xl:grid-cols-2">
            <DeliveryPanel />
            <DeliveryHistory />
          </div>
        </>
      )}
    </div>
  );
}

function AlertStudio({ initial }: { initial: AlertWorkspace }) {
  const e = useAlertEditor(initial);
  const [publishing, setPublishing] = useState(false);
  const [section, setSection] = useState<Section>('templates');
  const editorPanel = useRef<HTMLDivElement>(null);
  const focusEditor = () => {
    editorPanel.current?.focus();
    editorPanel.current?.scrollIntoView({ block: 'start' });
  };
  const clients = useClients();
  const users = useUsers();
  const groups = useGroups();
  const current = SECTIONS.find((s) => s.id === section)!;
  const onUseTemplate = (id: string) => {
    e.addRule(id);
    setSection('rules');
  };
  return (
    <fieldset disabled={!!e.busy || publishing} className="alert-studio max-w-6xl min-w-0 space-y-5">
      <legend className="sr-only">Alert drafts</legend>
      <div className="sticky top-0 z-20 rounded-lg border border-border-strong bg-surface p-4">
        <PageHeader
          eyebrow="Administration"
          title="Alerting center"
          description="Email and Microsoft Teams, in one place."
          actions={
            <>
              <span role="status">
                <Badge tone={e.dirty ? 'warning' : 'neutral'}>{e.dirty ? 'Unsaved changes' : 'Drafts saved'}</Badge>
              </span>
              <Button loading={e.busy === 'save'} disabled={!!e.busy || !e.dirty} onClick={() => void e.save()}>
                <Save /> Save drafts
              </Button>
            </>
          }
        />
      </div>
      <div className="flex flex-wrap gap-3 text-sm font-semibold">
        <Link
          to="/admin/email"
          className="rounded-lg border border-border-strong bg-surface px-4 py-2 text-text-2 hover:bg-surface-3"
        >
          Email connection
        </Link>
        <Link
          to="/admin/teams"
          className="rounded-lg border border-border-strong bg-surface px-4 py-2 text-text-2 hover:bg-surface-3"
        >
          Teams connection
        </Link>
      </div>

      <div aria-label="Alerting overview" className="grid grid-cols-3 gap-3">
        {[
          { label: 'Templates', value: e.workspace.templates.length },
          { label: 'Alert rules', value: e.workspace.rules.length },
          { label: 'Draft revision', value: e.workspace.revision },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-lg border border-border-strong bg-surface p-3 sm:p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-2">{label}</p>
            <p className="alert-metric mt-2 text-2xl font-semibold tabular-nums text-text">{value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border-strong bg-surface-3 p-3">
        <nav aria-label="Alerting sections" className="flex gap-2 overflow-x-auto">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setSection(id)}
              className={`flex shrink-0 items-center gap-2 rounded-lg border px-3 py-3 text-left whitespace-nowrap xl:flex-1 text-sm font-semibold transition-colors ${section === id ? 'border-primary bg-primary text-primary-fg' : 'border-border-strong bg-surface text-text hover:bg-primary-soft'}`}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      <FormError message={e.error} />
      <section
        aria-label={current.label}
        className="min-w-0 space-y-5 rounded-lg border border-border-strong bg-surface-2 p-3 sm:p-5"
      >
        <header className="border-b border-border-strong pb-4">
          <h2 className="text-xl font-semibold text-text">{current.label}</h2>
          <p className="mt-1 text-sm text-text-2">{current.description}</p>
        </header>
        {section === 'templates' && (
          <div className="alert-template-layout grid items-start gap-5">
            <Library
              editor={{
                ...e,
                selectTemplate: (id) => {
                  e.selectTemplate(id);
                  focusEditor();
                },
                addTemplate: () => {
                  e.addTemplate();
                  focusEditor();
                },
                addPreset: (id) => {
                  e.addPreset(id);
                  focusEditor();
                },
              }}
              onUseTemplate={onUseTemplate}
            />
            <div className="min-w-0 space-y-5">
              {e.template && (
                <div
                  ref={editorPanel}
                  tabIndex={-1}
                  aria-label="Selected template editor"
                  className="scroll-mt-28 outline-none"
                >
                  <TemplateEditor key={e.template.id} template={e.template} change={e.changeTemplate} />
                </div>
              )}
              {e.template && <TestSend template={e.template} saved={!e.dirty} />}
            </div>
          </div>
        )}
        {section === 'rules' && (
          <>
            <RuleLibrary editor={e} chooseTemplate={() => setSection('templates')} />
            <FormError message={clients.error?.message ?? users.error?.message ?? groups.error?.message} />
            {e.rule && clients.data && users.data && (
              <RuleEditor
                key={e.rule.id}
                rule={e.rule}
                templates={e.workspace.templates}
                clients={clients.data}
                users={users.data}
                groups={groups.data ?? []}
                change={e.changeRule}
              />
            )}
            {e.rule && (clients.isLoading || users.isLoading) && <Skeleton className="h-80" />}
            {e.rule && (
              <Button
                variant="secondary"
                onClick={() => {
                  e.selectTemplate(e.rule!.templateId);
                  setSection('templates');
                }}
              >
                Edit this rule’s template
              </Button>
            )}
          </>
        )}
        {(section === 'templates' || section === 'rules') && e.template && (
          <Preview
            sample={e.sample}
            change={e.setSample}
            clients={clients.data ?? []}
            result={e.result}
            run={() => void e.run()}
            busy={!!e.busy}
          />
        )}
        {section === 'timing' && (
          <>
            <ScheduleEditor schedule={e.workspace.schedule} change={e.changeSchedule} />
            <FormError message={clients.error?.message} />
            {clients.isLoading && <Skeleton className="h-40" />}
            {clients.data && (
              <Pauses
                pauses={e.workspace.pauses}
                schedule={e.workspace.schedule}
                clients={clients.data}
                change={e.changePauses}
              />
            )}
          </>
        )}
        {section === 'publish' && (
          <>
            <Versions editor={e} lock={setPublishing} />
            <DeliveryPanel />
          </>
        )}
        {section === 'history' && <DeliveryHistory />}
      </section>
    </fieldset>
  );
}
