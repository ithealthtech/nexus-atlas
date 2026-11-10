import { useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { localDate, type AlertPause, type AlertSchedule, type ClientSummary } from '@atlas/shared';
import { Badge, Button, Card, CardHeader, Field, Input, Select } from '@/components/ui';
import { formatDate } from '@/lib/format';

const DAY = 86_400_000;
const LENGTHS: [string, string][] = [
  ['', 'Until resumed'],
  ['1', 'Today'],
  ['7', '1 week'],
  ['14', '2 weeks'],
  ['30', '30 days'],
];

/**
 * Clients whose alerts are paused, for onboarding, offboarding or a planned change: nothing sends or escalates for
 * them until the pause ends. Saved with the drafts and live once published.
 */
export function Pauses({
  pauses,
  schedule,
  clients,
  change,
}: {
  pauses: AlertPause[];
  schedule: AlertSchedule;
  clients: ClientSummary[];
  change: (pauses: AlertPause[]) => void;
}) {
  const [clientId, setClientId] = useState('');
  const [length, setLength] = useState('');
  const [note, setNote] = useState('');
  const today = localDate(new Date(), schedule.timeZone);
  const name = (id: string) => clients.find((c) => c.id === id)?.name ?? 'Unavailable client';
  const available = clients.filter((c) => !pauses.some((p) => p.clientId === c.id));
  const pause = () => {
    if (!clientId) return;
    const until = length ? localDate(new Date(Date.now() + (Number(length) - 1) * DAY), schedule.timeZone) : null;
    change([...pauses, { clientId, until, note: note.trim() }]);
    setClientId('');
    setNote('');
  };
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <PauseCircle className="size-4 text-muted" aria-hidden /> Paused clients
          </span>
        }
        description="Nothing sends or escalates for a paused client, breaches and infections included, until the pause ends. Whatever is still due when it ends sends then."
      />
      <div className="space-y-4 border-t border-border p-5">
        {pauses.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {pauses.map((p) => {
              const ended = p.until !== null && p.until < today;
              return (
                <li key={p.clientId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="font-medium">{name(p.clientId)}</span>
                  {ended ? (
                    <Badge tone="neutral">Ended</Badge>
                  ) : (
                    <Badge tone="warning">
                      {p.until ? `Paused through ${formatDate(`${p.until}T12:00:00`)}` : 'Paused until resumed'}
                    </Badge>
                  )}
                  {p.note && <span className="min-w-0 flex-1 truncate text-muted">{p.note}</span>}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-auto"
                    onClick={() => change(pauses.filter((v) => v.clientId !== p.clientId))}
                  >
                    {ended ? 'Remove' : 'Resume'}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">No clients are paused.</p>
        )}
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_10rem_1fr_auto]">
          <Field label="Client">
            {(p) => (
              <Select {...p} value={clientId} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Choose a client</option>
                {available.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="For">
            {(p) => (
              <Select {...p} value={length} onChange={(e) => setLength(e.target.value)}>
                {LENGTHS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Note (optional)">
            {(p) => (
              <Input
                {...p}
                value={note}
                maxLength={200}
                placeholder="Offboarding, migration…"
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          <Button variant="secondary" disabled={!clientId} onClick={pause}>
            Pause alerts
          </Button>
        </div>
      </div>
    </Card>
  );
}
