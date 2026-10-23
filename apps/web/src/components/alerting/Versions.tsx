import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlertVersion, AlertVersionHistory, AlertWorkspace } from '@atlas/shared';
import { Button, Card, Field, FormError, Input, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';
import { ALERTING_BASE, type AlertEditor } from './useAlertEditor';

export function Versions({ editor, lock }: { editor: AlertEditor; lock: (busy: boolean) => void }) {
  const queries = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [before, setBefore] = useState<number>();
  const [selected, setSelected] = useState<number>();
  const history = useQuery({
    queryKey: ['alert-versions', before],
    queryFn: () => api<AlertVersionHistory>(`${ALERTING_BASE}/versions${before ? `?beforeVersion=${before}` : ''}`),
  });
  const detail = useQuery({
    queryKey: ['alert-version', selected],
    queryFn: () => api<AlertVersion>(`${ALERTING_BASE}/versions/${selected}`),
    enabled: selected !== undefined,
  });
  const { busy, error, act } = useAction();
  const change = (name: string, work: () => Promise<void>) =>
    act(name, async () => {
      lock(true);
      try {
        await work();
        await queries.invalidateQueries({ queryKey: ['alert-versions'] });
      } finally {
        lock(false);
      }
    });
  const publish = () =>
    change('publish', async () => {
      await api(ALERTING_BASE + '/publish', {
        method: 'POST',
        body: {
          revision: editor.workspace.revision,
          lastVersion: history.data!.latestVersion,
          note,
        },
      });
      setNote('');
      setBefore(undefined);
      toast('Version published. Automatic delivery is not active yet.');
    });
  const restore = () => {
    if (
      !selected ||
      !confirm(`Replace saved drafts with version ${selected}? Published versions and current delivery stay unchanged.`)
    )
      return;
    return change('restore', async () => {
      const result = await api<AlertWorkspace>(`${ALERTING_BASE}/versions/${selected}/restore`, {
        method: 'POST',
        body: { revision: editor.workspace.revision },
      });
      editor.replaceWorkspace(result);
      toast('Version restored to drafts. Review selections before publishing again.');
    });
  };
  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-lg font-semibold">Published versions</h2>
      <p className="text-sm text-text-2">
        Publish a fixed copy of your saved templates and rules. Automatic delivery from these versions is coming in a
        later update.
      </p>
      <Field label="Version note" help="Describe what changed. Do not include passwords or other secrets.">
        {(p) => <Input {...p} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <Button
        onClick={() => void publish()}
        loading={busy === 'publish'}
        disabled={editor.dirty || !note.trim() || !history.data || !!busy}
      >
        Publish saved drafts
      </Button>
      {editor.dirty && <p className="text-sm text-muted">Save your edits before publishing or restoring a version.</p>}
      <FormError message={error ?? history.error?.message ?? detail.error?.message} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={history.isFetching} onClick={() => void history.refetch()}>
          Refresh version history
        </Button>
        {before && (
          <Button variant="secondary" onClick={() => setBefore(undefined)}>
            Newest versions
          </Button>
        )}
        {history.data?.nextBeforeVersion && (
          <Button variant="secondary" onClick={() => setBefore(history.data!.nextBeforeVersion!)}>
            Older versions
          </Button>
        )}
      </div>
      {history.data?.versions.length === 0 && <p className="text-sm text-muted">No versions published yet.</p>}
      <ul className="space-y-3">
        {history.data?.versions.map((v) => (
          <li key={v.version} className="space-y-1 rounded-md border border-border p-3">
            <Button variant="secondary" onClick={() => setSelected(v.version)}>
              View version {v.version}
            </Button>
            <p className="text-sm break-words">{v.note}</p>
            <p className="text-xs text-muted">
              {v.publishedBy} · {new Date(v.publishedAt).toLocaleString()} · {v.templateCount} templates · {v.ruleCount}{' '}
              rules
            </p>
          </li>
        ))}
      </ul>
      {detail.data && (
        <section
          aria-label={`Published version ${detail.data.version}`}
          className="space-y-3 border-t border-border pt-4"
        >
          <h3 className="font-semibold">Version {detail.data.version} · Read only</h3>
          {detail.data.workspace.templates.map((t) => (
            <details key={t.id} className="rounded-md border border-border p-3">
              <summary className="cursor-pointer font-semibold">{t.name}</summary>
              <p className="mt-3 text-sm font-semibold">Email subject</p>
              <p className="text-sm break-words">{t.emailSubject}</p>
              <p className="mt-3 text-sm font-semibold">Email message</p>
              <p className="text-sm whitespace-pre-wrap break-words">{t.emailBody}</p>
              <p className="mt-3 text-sm font-semibold">Teams message</p>
              <p className="text-sm whitespace-pre-wrap break-words">{t.teamsBody}</p>
            </details>
          ))}
          {detail.data.workspace.rules.map((r) => (
            <div key={r.id} className="text-sm">
              <p className="font-semibold">{r.name}</p>
              <p>
                {r.kind} · {r.clientIds.length ? `${r.clientIds.length} selected clients` : 'All clients'} ·{' '}
                {r.emailUserIds.length} email recipients{r.teams ? ' · Teams' : ''}
              </p>
              <p>
                Items: {r.itemKinds.join(', ')}. Severities: {r.severities.join(', ')}. Reminder days:{' '}
                {r.daysBefore.join(', ') || 'None'}. Overdue: {r.includeOverdue ? 'Yes' : 'No'}.
              </p>
            </div>
          ))}
          <p className="text-sm text-muted">
            Restoring replaces saved drafts. Review unavailable clients or recipients before publishing again.
          </p>
          <Button
            variant="secondary"
            disabled={editor.dirty || !!busy}
            onClick={() => void restore()}
            loading={busy === 'restore'}
          >
            Restore version {detail.data.version} to drafts
          </Button>
        </section>
      )}
    </Card>
  );
}
