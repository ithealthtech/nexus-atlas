import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Plus, Send, Webhook } from 'lucide-react';
import {
  WEBHOOK_TOPICS,
  WEBHOOK_TOPIC_LABELS,
  type WebhookDeliveryView,
  type WebhookTopic,
  type WebhookView,
  type WebhookWithSecret,
} from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

function WebhookDialog({
  webhook,
  onClose,
  onSaved,
}: {
  webhook?: WebhookView;
  onClose: () => void;
  onSaved: (made?: WebhookWithSecret) => void;
}) {
  const [topics, setTopics] = useState<WebhookTopic[]>(webhook?.topics ?? ['asset', 'document']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = { name: form.get('name'), url: form.get('url'), topics, enabled: form.get('enabled') === 'on' };
    setBusy(true);
    setError(null);
    try {
      if (webhook) {
        await api(`/webhooks/${webhook.id}`, { method: 'PATCH', body });
        onSaved();
      } else onSaved(await api<WebhookWithSecret>('/webhooks', { method: 'POST', body }));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={webhook ? `Edit ${webhook.name}` : 'New webhook'}
      description="Atlas posts a short JSON message to this address when one of the chosen kinds of item changes."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="webhook-form" loading={busy}>
            {webhook ? 'Save webhook' : 'Create webhook'}
          </Button>
        </>
      }
    >
      <form id="webhook-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Webhook name" error={error?.fields?.name}>
          {(p) => (
            <Input {...p} name="name" defaultValue={webhook?.name} placeholder="Teams alerts" maxLength={80} required />
          )}
        </Field>
        <Field label="Address to post to" help="Must start with https://." error={error?.fields?.url}>
          {(p) => (
            <Input
              {...p}
              name="url"
              type="url"
              defaultValue={webhook?.url}
              className="font-mono"
              autoComplete="off"
              placeholder="https://"
              required
            />
          )}
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold">Send changes to</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {WEBHOOK_TOPICS.map((t) => (
              <Checkbox
                key={t}
                label={WEBHOOK_TOPIC_LABELS[t]}
                checked={topics.includes(t)}
                onChange={(e) => setTopics(e.target.checked ? [...topics, t] : topics.filter((x) => x !== t))}
              />
            ))}
          </div>
          {error?.fields?.topics && <p className="text-xs text-danger">{error.fields.topics}</p>}
          <p className="text-xs text-muted">
            A message says what changed, who changed it, and for which client, with a link. It never carries the
            item&rsquo;s contents: a password message gives the entry&rsquo;s name only.
          </p>
        </fieldset>
        <Checkbox name="enabled" defaultChecked={webhook?.enabled ?? true} label="Turned on" />
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

function Deliveries({ webhook, onClose }: { webhook: WebhookView; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ['webhook-deliveries', webhook.id],
    queryFn: () => api<WebhookDeliveryView[]>(`/webhooks/${webhook.id}/deliveries`),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Recent deliveries: ${webhook.name}`}
      description="The latest 50. A failed delivery is tried six times over about eight hours."
    >
      {!data ? (
        <Skeleton className="h-24" />
      ) : !data.length ? (
        <p className="text-sm text-muted">Nothing has been sent yet.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <Badge tone={d.status === 'delivered' ? 'success' : d.status === 'failed' ? 'danger' : 'warning'}>
                {d.status === 'delivered' ? 'Delivered' : d.status === 'failed' ? 'Gave up' : 'Waiting'}
              </Badge>
              <span className="font-mono text-xs">{d.event}</span>
              <span className="min-w-0 flex-1 truncate text-text-2">{d.title}</span>
              <span className="text-xs text-muted">{formatDateTime(d.createdAt)}</span>
              {d.status !== 'delivered' && (
                <p className="basis-full text-xs text-muted">
                  {d.error ?? 'Not sent yet.'}
                  {d.attempts > 0 && ` Tried ${d.attempts} ${d.attempts === 1 ? 'time' : 'times'}.`}
                  {d.nextAttemptAt && ` Next try ${formatDateTime(d.nextAttemptAt)}.`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Webhooks: where Atlas posts when documentation changes, and how deliveries went. */
export function Webhooks() {
  const toast = useToast();
  const list = useQuery({ queryKey: ['webhooks'], queryFn: () => api<WebhookView[]>('/webhooks') });
  const [editing, setEditing] = useState<WebhookView | 'new' | null>(null);
  const [viewing, setViewing] = useState<WebhookView | null>(null);
  const [secret, setSecret] = useState<WebhookWithSecret | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await work();
      await list.refetch();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Webhooks"
        description="Tell another system when something changes in Atlas: post to a chat channel, start an automation, or keep another tool in step."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> New webhook
          </Button>
        }
      />
      <div className="grid max-w-4xl gap-6">
        {secret && (
          <Card>
            <CardHeader
              title={`Signing secret for ${secret.name}`}
              description="Copy it now: Atlas can't show it again. Your receiver uses it to check that a message really came from Atlas."
              actions={
                <Button
                  variant="secondary"
                  onClick={() => navigator.clipboard.writeText(secret.secret).then(() => toast('Secret copied.'))}
                >
                  <Copy /> Copy secret
                </Button>
              }
            />
            <div className="space-y-2 px-5 py-4 text-sm text-text-2">
              <code className="block rounded bg-surface-2 px-2 py-1.5 font-mono text-xs break-all">
                {secret.secret}
              </code>
              <p>
                Each message has an <code className="font-mono text-xs">X-Atlas-Signature</code> header:{' '}
                <code className="font-mono text-xs">sha256=</code> followed by the HMAC-SHA256, in hex, of the{' '}
                <code className="font-mono text-xs">X-Atlas-Timestamp</code> header, a full stop, and the body. Check
                it, and ignore messages whose timestamp is more than a few minutes old.
              </p>
            </div>
          </Card>
        )}
        <Card>
          {!list.data ? (
            <Skeleton className="m-5 h-20" />
          ) : !list.data.length ? (
            <EmptyState
              icon={Webhook}
              title="No webhooks yet"
              description="Add one with the address of the system that should hear about changes."
            />
          ) : (
            <ul className="divide-y divide-border">
              {list.data.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {w.name}
                      {w.paused ? (
                        <Badge tone="danger">Paused after repeated failures</Badge>
                      ) : !w.enabled ? (
                        <Badge tone="neutral">Off</Badge>
                      ) : w.last?.status === 'delivered' ? (
                        <Badge tone="success">Working</Badge>
                      ) : w.last ? (
                        <Badge tone="warning">{w.last.status === 'failed' ? 'Last delivery failed' : 'Retrying'}</Badge>
                      ) : null}
                    </p>
                    <p className="truncate font-mono text-xs text-muted">{w.url}</p>
                    <p className="text-xs text-text-2">
                      {w.topics.map((t) => WEBHOOK_TOPIC_LABELS[t]).join(', ')}
                      {w.last && ` · ${w.last.detail}, ${formatDateTime(w.last.at)}`}
                    </p>
                  </div>
                  {w.paused && (
                    <Button
                      size="sm"
                      loading={busy === `resume-${w.id}`}
                      onClick={() =>
                        act(`resume-${w.id}`, () => api(`/webhooks/${w.id}/resume`, { method: 'POST', body: {} }))
                      }
                    >
                      Resume
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === `test-${w.id}`}
                    onClick={() =>
                      act(`test-${w.id}`, async () => {
                        const r = await api<{ ok: boolean; detail: string }>(`/webhooks/${w.id}/test`, {
                          method: 'POST',
                          body: {},
                        });
                        toast(
                          r.ok ? `Test sent to ${w.name}. ${r.detail}` : `Test failed. ${r.detail}`,
                          r.ok ? undefined : 'error',
                        );
                      })
                    }
                  >
                    <Send /> Send test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setViewing(w)}>
                    Deliveries
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(w)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Replace the signing secret for “${w.name}”? The receiver must be given the new one.`,
                        )
                      )
                        return;
                      void act(`secret-${w.id}`, async () =>
                        setSecret(
                          await api<WebhookWithSecret>(`/webhooks/${w.id}/secret`, { method: 'POST', body: {} }),
                        ),
                      );
                    }}
                  >
                    New secret
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (!window.confirm(`Delete the webhook “${w.name}”?`)) return;
                      void act(`delete-${w.id}`, () => api(`/webhooks/${w.id}`, { method: 'DELETE' }));
                    }}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {editing && (
        <WebhookDialog
          webhook={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={(made) => {
            setEditing(null);
            if (made) setSecret(made);
            void list.refetch();
            toast(made ? 'Webhook created. Copy its signing secret now.' : 'Webhook saved.');
          }}
        />
      )}
      {viewing && <Deliveries webhook={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}
