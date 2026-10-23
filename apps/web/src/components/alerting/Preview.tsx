import {
  ALERT_KINDS,
  ALERT_KIND_LABELS,
  ALERT_ITEM_KINDS,
  ALERT_SEVERITIES,
  type AlertPreview,
  type AlertSample,
  type ClientSummary,
} from '@atlas/shared';
import { Badge, Button, Card, CardHeader, Field, Input, Select } from '@/components/ui';

export function Preview({
  sample,
  change,
  clients,
  result,
  run,
  busy,
}: {
  sample: AlertSample;
  change: (s: AlertSample) => void;
  clients: ClientSummary[];
  result: AlertPreview | null;
  run: () => void;
  busy: boolean;
}) {
  return (
    <Card>
      <CardHeader title="Preview & test rule" description="Synthetic example data. No email or Teams post is sent." />
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Example alert type">
            {(p) => (
              <Select
                {...p}
                value={sample.kind}
                onChange={(e) => change({ ...sample, kind: e.target.value as AlertSample['kind'] })}
              >
                {ALERT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ALERT_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Example client">
            {(p) => (
              <Select
                {...p}
                value={sample.clientId ?? ''}
                onChange={(e) => change({ ...sample, clientId: e.target.value || null })}
              >
                <option value="">Example client (no mapping)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Example item type">
            {(p) => (
              <Select
                {...p}
                value={sample.itemKind}
                onChange={(e) => change({ ...sample, itemKind: e.target.value as AlertSample['itemKind'] })}
              >
                {ALERT_ITEM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Example severity">
            {(p) => (
              <Select
                {...p}
                value={sample.severity}
                onChange={(e) => change({ ...sample, severity: e.target.value as AlertSample['severity'] })}
              >
                {ALERT_SEVERITIES.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Example days remaining">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={-365}
                max={365}
                value={sample.daysRemaining}
                onChange={(e) => change({ ...sample, daysRemaining: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        <Button variant="secondary" disabled={busy} loading={busy} onClick={run}>
          Run preview
        </Button>
        {result ? (
          <div className="space-y-5" aria-live="polite">
            <Badge tone={result.matched ? 'success' : 'warning'}>
              {result.matched ? 'Conditions match' : 'Conditions do not match'}
            </Badge>
            <ul className="list-inside list-disc text-sm text-text-2">
              {result.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {result.destinations.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold text-text">Potential destinations</h3>
                <ul className="space-y-3">
                  {result.destinations.map((d) => (
                    <li key={d.label} className="text-sm text-text-2">
                      <p className="font-medium">{d.label}</p>
                      <p>
                        {d.ready ? 'Ready' : 'Needs attention'}: {d.detail}
                      </p>
                    </li>
                  ))}
                </ul>
                {!result.matched && (
                  <p className="mt-2 text-sm text-muted">
                    This example would not be sent because the conditions do not match.
                  </p>
                )}
              </div>
            )}
            <section aria-label="Email preview" className="rounded-md border border-border p-4">
              <h3 className="text-sm font-semibold text-text">Email preview</h3>
              <p className="mt-3 text-sm font-semibold break-words text-text">{result.emailSubject}</p>
              <p className="mt-3 text-sm break-words whitespace-pre-wrap text-text-2">{result.emailBody}</p>
            </section>
            <section aria-label="Teams preview" className="rounded-md border border-border p-4">
              <h3 className="text-sm font-semibold text-text">Teams preview</h3>
              <p className="mt-3 text-sm break-words whitespace-pre-wrap text-text-2">{result.teamsBody}</p>
            </section>
          </div>
        ) : (
          <p className="text-sm text-muted">Run a preview after editing to see current messages and rule conditions.</p>
        )}
      </div>
    </Card>
  );
}
