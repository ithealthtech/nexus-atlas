import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pause, Pencil, Play, Send, Trash2 } from 'lucide-react';
import {
  MAX_SCHEDULE_RECIPIENTS,
  REPORT_CADENCES,
  REPORT_CADENCE_LABELS,
  type ReportCadence,
  type ReportDefinition,
  type ReportScheduleView,
} from '@atlas/shared';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  Field,
  FormError,
  Input,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { useAction } from '@/lib/actions';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;
/** "Every month on the 1st at 07:00", the way the list and dialog describe a schedule. */
export function describeSchedule(s: Pick<ReportScheduleView, 'cadence' | 'day' | 'hour'>) {
  const when = s.cadence === 'weekly' ? `on ${WEEKDAYS[s.day]}` : `on day ${s.day}`;
  return `${REPORT_CADENCE_LABELS[s.cadence]} ${when} at ${hourLabel(s.hour)}`;
}
/** Addresses typed one per line or separated by commas or semicolons. */
const parseRecipients = (text: string) => [
  ...new Set(
    text
      .split(/[\s,;]+/)
      .map((r) => r.trim().toLowerCase())
      .filter(Boolean),
  ),
];
export const useSchedules = () =>
  useQuery({ queryKey: ['report-schedules'], queryFn: () => api<ReportScheduleView[]>('/reports/schedules') });

/** Make or change a schedule for a report definition. */
export function ScheduleDialog({
  definition,
  schedule,
  onClose,
}: {
  definition: ReportDefinition;
  schedule?: ReportScheduleView;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { busy, error, act } = useAction();
  const [name, setName] = useState(schedule?.name ?? definition.title);
  const [cadence, setCadence] = useState<ReportCadence>(schedule?.cadence ?? 'monthly');
  const [day, setDay] = useState(schedule?.day ?? 1);
  const [hour, setHour] = useState(schedule?.hour ?? 7);
  const [recipients, setRecipients] = useState((schedule?.recipients ?? []).join('\n'));
  const [attachPdf, setAttachPdf] = useState(schedule?.attachPdf ?? true);
  const [clientLink, setClientLink] = useState(schedule?.clientLink ?? false);
  const oneClient = (schedule?.definition ?? definition).clientIds.length === 1;
  const list = parseRecipients(recipients);
  const changeCadence = (next: ReportCadence) => {
    setCadence(next);
    // Keep the day valid: weekdays run 0–6, days of the month 1–28.
    if (next === 'weekly' && day > 6) setDay(1);
    if (next !== 'weekly' && day < 1) setDay(1);
  };
  const save = () =>
    act('save', async () => {
      const body = {
        name,
        definition: schedule?.definition ?? definition,
        cadence,
        day,
        hour,
        recipients: list,
        attachPdf,
        clientLink: oneClient && clientLink,
        enabled: schedule?.enabled ?? true,
        ...(schedule ? { version: schedule.version } : {}),
      };
      await api(`/reports/schedules${schedule ? `/${schedule.id}` : ''}`, {
        method: schedule ? 'PUT' : 'POST',
        body,
      });
      await qc.invalidateQueries({ queryKey: ['report-schedules'] });
      toast(schedule ? 'Schedule updated.' : 'Report scheduled.');
      onClose();
    });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={schedule ? 'Change scheduled report' : 'Schedule this report'}
      description="Atlas runs the report with your access at the time, keeps the snapshot in your history, and emails it."
      footer={
        <Button loading={busy === 'save'} disabled={!name.trim() || !list.length} onClick={() => void save()}>
          <CalendarClock /> {schedule ? 'Save changes' : 'Schedule report'}
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          {(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="How often">
            {(p) => (
              <Select {...p} value={cadence} onChange={(e) => changeCadence(e.target.value as ReportCadence)}>
                {REPORT_CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {REPORT_CADENCE_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={cadence === 'weekly' ? 'Day of the week' : 'Day of the month'}>
            {(p) => (
              <Select {...p} value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {cadence === 'weekly'
                  ? WEEKDAYS.map((label, i) => (
                      <option key={label} value={i}>
                        {label}
                      </option>
                    ))
                  : Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
              </Select>
            )}
          </Field>
          <Field label="Time" help="The server's time zone.">
            {(p) => (
              <Select {...p} value={hour} onChange={(e) => setHour(Number(e.target.value))}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {cadence === 'quarterly' && (
          <p className="text-xs text-muted">Quarterly reports go out in January, April, July and October.</p>
        )}
        <Field
          label="Send to"
          help={`One address per line: staff or client contacts. ${list.length} of ${MAX_SCHEDULE_RECIPIENTS}.`}
        >
          {(p) => (
            <Textarea
              {...p}
              rows={4}
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="office.manager@client.example"
              spellCheck={false}
            />
          )}
        </Field>
        <Checkbox
          label="Attach the whole report as a PDF"
          description="Branded with your logo and colours, with summary, charts, and every section."
          checked={attachPdf}
          onChange={(e) => setAttachPdf(e.currentTarget.checked)}
        />
        <Checkbox
          label="Include a link the client can open without an account"
          description={
            oneClient
              ? 'A new link to this run, working for 30 days. Needs edit access to the client.'
              : 'Only for a report about one client.'
          }
          checked={oneClient && clientLink}
          disabled={!oneClient}
          onChange={(e) => setClientLink(e.currentTarget.checked)}
        />
        <FormError message={error} />
      </div>
    </Dialog>
  );
}

/** The Scheduled tab of the report library: each schedule, when it next runs, and how the last one went. */
export function ScheduleList({
  scoped,
  onEdit,
}: {
  /** Whether a schedule belongs on this page (a client's Reports tab shows only that client's). */
  scoped: (clientIds: string[]) => boolean;
  onEdit: (schedule: ReportScheduleView) => void;
}) {
  const schedules = useSchedules();
  const toast = useToast();
  const { busy, act } = useAction({ toast: true, after: () => schedules.refetch() });
  const shown = (schedules.data ?? []).filter((s) => scoped(s.definition.clientIds));
  const save = (s: ReportScheduleView, changes: Partial<ReportScheduleView>) =>
    api(`/reports/schedules/${s.id}`, { method: 'PUT', body: { ...s, ...changes } });
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted">Reports emailed on a schedule. Private to your account.</p>
      {schedules.isLoading && <Skeleton className="h-20" />}
      <FormError message={schedules.error?.message} />
      {shown.map((s) => (
        <div key={s.id} className="space-y-1.5 border-b border-border pb-2.5">
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{s.name}</p>
              <p className="text-xs text-muted">{describeSchedule(s)}</p>
            </div>
            {!s.enabled ? (
              <Badge>Paused</Badge>
            ) : s.lastStatus === 'failed' ? (
              <Badge tone="danger">Last failed</Badge>
            ) : s.lastStatus === 'sent' ? (
              <Badge tone="success">Sent</Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted">
            {s.enabled ? `Next ${formatDateTime(s.nextRunAt)}` : 'Not sending'} · {s.recipients.length} recipient
            {s.recipients.length === 1 ? '' : 's'}
            {s.lastRunAt && ` · last ${formatDateTime(s.lastRunAt)}`}
          </p>
          {s.lastError && <p className="text-xs text-danger">{s.lastError}</p>}
          <div className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant="secondary"
              loading={busy === `send-${s.id}`}
              onClick={() =>
                void act(`send-${s.id}`, async () => {
                  const result = await api<ReportScheduleView>(`/reports/schedules/${s.id}/send`, { method: 'POST' });
                  toast(
                    result.lastStatus === 'sent' ? 'Report sent.' : 'The report was not sent. See the note below it.',
                  );
                })
              }
            >
              <Send /> Send now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${s.enabled ? 'Pause' : 'Resume'} ${s.name}`}
              loading={busy === `toggle-${s.id}`}
              onClick={() => void act(`toggle-${s.id}`, () => save(s, { enabled: !s.enabled }))}
            >
              {s.enabled ? <Pause /> : <Play />} {s.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button size="sm" variant="ghost" aria-label={`Change ${s.name}`} onClick={() => onEdit(s)}>
              <Pencil /> Change
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete schedule ${s.name}`}
              loading={busy === `delete-${s.id}`}
              onClick={() =>
                void act(`delete-${s.id}`, () =>
                  api(`/reports/schedules/${s.id}`, { method: 'DELETE', body: { version: s.version } }),
                )
              }
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      {!schedules.isLoading && !shown.length && (
        <p className="py-3 text-sm text-muted">
          Nothing scheduled yet. Choose clients, then <strong>Schedule</strong> to email a report regularly.
        </p>
      )}
    </div>
  );
}
