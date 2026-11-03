import { useMemo } from 'react';
import { Clock } from 'lucide-react';
import type { AlertSchedule } from '@atlas/shared';
import { Card, CardHeader, Field, Select } from '@/components/ui';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

/**
 * When alerts go, for the whole workspace: the time zone, quiet hours (routine reminders wait; breaches and
 * infections never do) and the hour daily summaries go. Saved with the drafts and live once published.
 */
export function ScheduleEditor({ schedule, change }: { schedule: AlertSchedule; change: (s: AlertSchedule) => void }) {
  const zones = useMemo(() => {
    const list = Intl.supportedValuesOf?.('timeZone') ?? [];
    return list.includes(schedule.timeZone) ? list : [schedule.timeZone, ...list];
  }, [schedule.timeZone]);
  const quiet = schedule.quietStart !== schedule.quietEnd;
  const hour = (key: 'quietStart' | 'quietEnd' | 'summaryHour', label: string, help?: string) => (
    <Field label={label} help={help}>
      {(p) => (
        <Select {...p} value={schedule[key]} onChange={(e) => change({ ...schedule, [key]: Number(e.target.value) })}>
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {hourLabel(h)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Clock className="size-4 text-muted" aria-hidden /> Timing
          </span>
        }
        description={
          quiet
            ? `Routine reminders wait from ${hourLabel(schedule.quietStart)} to ${hourLabel(schedule.quietEnd)}. Breaches and infections always go straight away.`
            : 'No quiet hours: reminders go as they fall due. Breaches and infections always go straight away.'
        }
      />
      <div className="grid gap-4 border-t border-border p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Time zone">
          {(p) => (
            <Select
              {...p}
              value={schedule.timeZone}
              onChange={(e) => change({ ...schedule, timeZone: e.target.value })}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {hour('quietStart', 'Quiet from', 'Set both to the same hour for no quiet hours.')}
        {hour('quietEnd', 'Quiet until')}
        {hour('summaryHour', 'Daily summaries at')}
      </div>
    </Card>
  );
}
