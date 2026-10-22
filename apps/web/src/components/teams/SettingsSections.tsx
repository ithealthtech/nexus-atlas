import { TEAMS_ALERT_KINDS, TEAMS_ALERT_LABELS } from '@atlas/shared';
import { Button, Card, CardHeader, Checkbox, Field, FormError, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { DEMO } from '@/lib/demo';
import type { TeamsEditor } from '@/pages/Teams';
const BASE = '/integrations/teams';

export function TeamsConnection({
  form,
  setForm,
  initial,
  secret,
  setSecret,
  busy,
  act,
  refresh,
  toast,
  dirty,
}: Pick<
  TeamsEditor,
  'form' | 'setForm' | 'initial' | 'secret' | 'setSecret' | 'busy' | 'act' | 'refresh' | 'toast' | 'dirty'
>) {
  return (
    <Card>
      <CardHeader
        title="Connection"
        description="Connect a Microsoft work account for discussions and automatic alerts. Messages appear under that account."
      />
      <div className="space-y-4 p-5">
        <p className="text-sm">
          <a
            className="text-primary underline"
            href="https://github.com/ithealthtech/nexus-atlas/blob/main/docs/TEAMS.md"
            target="_blank"
            rel="noreferrer"
          >
            Microsoft Teams setup guide
          </a>
        </p>
        <Checkbox
          label="Enable Microsoft Teams"
          checked={form.enabled}
          onChange={(e) => setForm({ ...form, enabled: e.currentTarget.checked })}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Directory (tenant) ID">
            {(p) => (
              <Input
                {...p}
                value={form.tenantId ?? ''}
                onChange={(e) => setForm({ ...form, tenantId: e.target.value || undefined })}
              />
            )}
          </Field>
          <Field label="Application (client) ID">
            {(p) => (
              <Input
                {...p}
                value={form.appId ?? ''}
                onChange={(e) => setForm({ ...form, appId: e.target.value || undefined })}
              />
            )}
          </Field>
        </div>
        <Field
          label="Application secret"
          help={
            initial.hasClientSecret
              ? 'A secret is saved. Leave blank to keep it; replacing it requires reconnecting Microsoft.'
              : 'Enter the secret value, not its ID.'
          }
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          )}
        </Field>

        <p className="text-sm text-muted">
          {initial.connection
            ? `Discussions and alerts connected as ${initial.connection.name}.`
            : 'Connect a Microsoft account to read discussions and send alerts. Notifications wait until the account is connected.'}
        </p>
        {new URLSearchParams(window.location.search).get('connection') && (
          <p role="status" className="text-sm">
            {new URLSearchParams(window.location.search).get('connection') === 'connected'
              ? 'Microsoft account connected.'
              : 'The connection did not complete. Save your settings and try again.'}
          </p>
        )}
        <p className="text-sm text-muted">
          Atlas sends alerts in the background while this connection is valid. If Microsoft requires sign-in again,
          notifications stay queued until you reconnect. An Azure Bot resource or Teams app installation is not
          required.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!!busy || DEMO || dirty}
            onClick={() =>
              void act('connect', async () => {
                const result = await api<{ url: string }>(BASE + '/connect', { method: 'POST', body: {} });
                const url = new URL(result.url);
                if (url.origin !== 'https://login.microsoftonline.com')
                  throw new Error('Unexpected Microsoft sign-in address.');
                window.location.assign(url.href);
              })
            }
          >
            Connect Microsoft account
          </Button>
          <Button
            variant="secondary"
            disabled={!!busy}
            onClick={() =>
              void act('disconnect', async () => {
                await api(BASE, { method: 'DELETE' });
                setForm({ ...form, enabled: false });
                await refresh();
                toast('Teams disconnected and alerts paused.');
              })
            }
          >
            Disconnect and pause
          </Button>
        </div>
      </div>
    </Card>
  );
}

export function TeamsChannels({
  form,
  setForm,
  clients,
  patchMapping,
  busy,
  act,
  toast,
  refresh,
  dirty,
}: Pick<
  TeamsEditor,
  'form' | 'setForm' | 'clients' | 'patchMapping' | 'busy' | 'act' | 'toast' | 'refresh' | 'dirty'
>) {
  return (
    <Card>
      <CardHeader
        title="Client channels"
        description="Choose an existing channel for each client. Security alerts can go to a separate staff channel in the same team."
      />
      <div className="space-y-4 p-5">
        {form.mappings.map((m, i) => (
          <fieldset key={i} className="space-y-3 rounded-md border border-border p-4">
            <legend className="px-1 text-sm font-semibold">Client channel {i + 1}</legend>
            <Field label="Client">
              {(p) => (
                <Select {...p} value={m.clientId} onChange={(e) => patchMapping(i, { clientId: e.target.value })}>
                  <option value="">Choose a client</option>
                  {clients.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Team ID">
                {(p) => <Input {...p} value={m.teamId} onChange={(e) => patchMapping(i, { teamId: e.target.value })} />}
              </Field>
              <Field label="Channel name">
                {(p) => (
                  <Input
                    {...p}
                    value={m.channelName}
                    onChange={(e) => patchMapping(i, { channelName: e.target.value })}
                  />
                )}
              </Field>
              <Field label="Channel ID">
                {(p) => (
                  <Input {...p} value={m.channelId} onChange={(e) => patchMapping(i, { channelId: e.target.value })} />
                )}
              </Field>
              <Field label="Security channel ID (optional)">
                {(p) => (
                  <Input
                    {...p}
                    value={m.securityChannelId ?? ''}
                    onChange={(e) => patchMapping(i, { securityChannelId: e.target.value || undefined })}
                  />
                )}
              </Field>
            </div>
            <p className="text-xs text-muted">
              In Teams, choose Get link to channel. The link contains the channel ID and groupId (the team ID). Confirm
              that everyone in the destination channel may see this client's information.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={!!busy || DEMO || dirty}
                onClick={() =>
                  void act(`test-${i}`, async () => {
                    await api(`${BASE}/test/${m.clientId}`, { method: 'POST', body: {} });
                    toast('Test notification sent.');
                    await refresh();
                  })
                }
              >
                Send test notification
              </Button>
              <Button
                variant="ghost"
                onClick={() => setForm({ ...form, mappings: form.mappings.filter((_, n) => n !== i) })}
              >
                Remove mapping
              </Button>
            </div>
          </fieldset>
        ))}
        <Button
          variant="secondary"
          onClick={() =>
            setForm({
              ...form,
              mappings: [...form.mappings, { clientId: '', teamId: '', channelId: '', channelName: '' }],
            })
          }
        >
          Add client channel
        </Button>
      </div>
    </Card>
  );
}

export function TeamsAlertPreferences({
  form,
  setForm,
  reminders,
  setReminders,
}: Pick<TeamsEditor, 'form' | 'setForm' | 'reminders' | 'setReminders'>) {
  return (
    <Card>
      <CardHeader
        title="Automatic alerts"
        description="Security alerts are checked every minute. Expirations and reviews are grouped into a daily digest after your chosen hour."
      />
      <div className="space-y-4 p-5">
        {TEAMS_ALERT_KINDS.map((kind) => (
          <Checkbox
            key={kind}
            label={TEAMS_ALERT_LABELS[kind]}
            checked={form.alerts.includes(kind)}
            onChange={(e) =>
              setForm({
                ...form,
                alerts: e.currentTarget.checked ? [...form.alerts, kind] : form.alerts.filter((v) => v !== kind),
              })
            }
          />
        ))}
        <p className="text-sm text-muted">
          Breach notifications use Atlas's latest breach-check results. Confirmed infection events come from your
          monitoring integration. Password values and recovery keys are never included.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Reminder days" help="Days before the date; 0 includes overdue items.">
            {(p) => <Input {...p} value={reminders} onChange={(e) => setReminders(e.target.value)} />}
          </Field>
          <Field label="Daily digest hour (0–23)">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                max={23}
                value={form.digestHour}
                onChange={(e) => setForm({ ...form, digestHour: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Time zone" help="For example America/New_York.">
            {(p) => (
              <Input {...p} value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} />
            )}
          </Field>
        </div>
      </div>
    </Card>
  );
}

export function TeamsDeliveryHistory({
  deliveries,
  clients,
  busy,
  act,
  confirmRetry,
  setConfirmRetry,
}: Pick<TeamsEditor, 'deliveries' | 'clients' | 'busy' | 'act' | 'confirmRetry' | 'setConfirmRetry'>) {
  return (
    <Card>
      <CardHeader
        title="Delivery history"
        description="Recent notifications and delivery errors. Ambiguous deliveries are held to avoid duplicate posts."
      />
      <FormError message={deliveries.error?.message} />
      <div className="overflow-x-auto p-5">
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Created</th>
              <th>Client</th>
              <th>Alert</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.data?.map((d) => (
              <tr key={d.id} className="border-t border-border">
                <td className="py-3">{new Date(d.createdAt).toLocaleString()}</td>
                <td>{clients.data?.find((c) => c.id === d.clientId)?.name ?? 'Client'}</td>
                <td>{TEAMS_ALERT_LABELS[d.kind]}</td>
                <td>{d.status}</td>
                <td>
                  {d.error || `${d.attempts} attempts`}
                  {(d.status === 'failed' || d.status === 'uncertain') && (
                    <Button
                      variant="secondary"
                      disabled={!!busy}
                      onClick={() => {
                        if (d.status === 'uncertain' && confirmRetry !== d.id) {
                          setConfirmRetry(d.id);
                          return;
                        }
                        void act('retry', async () => {
                          await api(`${BASE}/deliveries/${d.id}/retry`, {
                            method: 'POST',
                            body: { confirmUncertain: d.status === 'uncertain' },
                          });
                          setConfirmRetry(null);
                          await deliveries.refetch();
                        });
                      }}
                    >
                      {confirmRetry === d.id ? 'I checked Teams; retry anyway' : 'Retry delivery'}
                    </Button>
                  )}
                  {confirmRetry === d.id && (
                    <p className="text-xs text-warning">Check the channel first. This may create a duplicate.</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {deliveries.data?.length === 0 && <p className="py-3 text-muted">No notifications yet.</p>}
      </div>
    </Card>
  );
}
