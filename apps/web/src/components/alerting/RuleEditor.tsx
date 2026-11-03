import { useState } from 'react';
import {
  ALERT_DELIVERY_STYLES,
  ALERT_DELIVERY_STYLE_LABELS,
  ALERT_ITEM_KINDS,
  ALERT_SEVERITIES,
  type AlertDeliveryStyle,
  type GroupView,
  type AlertRule,
  type AlertTemplate,
  type ClientSummary,
  type UserView,
} from '@atlas/shared';
import { Card, CardHeader, Checkbox, Field, Input, Select } from '@/components/ui';
import { Audience } from './Audience';

function toggle<T>(items: T[], item: T) {
  return items.includes(item) ? items.filter((v) => v !== item) : [...items, item];
}

export function RuleEditor({
  rule,
  templates,
  clients,
  users,
  groups,
  change,
}: {
  rule: AlertRule;
  templates: AlertTemplate[];
  clients: ClientSummary[];
  users: UserView[];
  groups: GroupView[];
  change: (r: AlertRule) => void;
}) {
  const [days, setDays] = useState(rule.daysBefore.join(', '));
  return (
    <Card>
      <CardHeader
        title="Rule editor"
        description="Conditions and destinations. Changes send once published, while the alerting center is live."
      />
      <div className="space-y-5 p-5">
        <Field label="Rule name">
          {(p) => (
            <Input
              {...p}
              value={rule.name}
              maxLength={100}
              onChange={(e) => change({ ...rule, name: e.target.value })}
            />
          )}
        </Field>
        <Field label="Message template">
          {(p) => (
            <Select {...p} value={rule.templateId} onChange={(e) => change({ ...rule, templateId: e.target.value })}>
              {templates
                .filter((t) => t.kind === rule.kind)
                .map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Audience rule={rule} clients={clients} users={users} groups={groups} change={change} />
        <fieldset>
          <legend className="mb-3 text-sm font-semibold text-text">Item types</legend>
          <div className="flex flex-wrap gap-4">
            {ALERT_ITEM_KINDS.map((kind) => (
              <Checkbox
                key={kind}
                label={kind}
                checked={rule.itemKinds.includes(kind)}
                onChange={() => change({ ...rule, itemKinds: toggle(rule.itemKinds, kind) })}
              />
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-3 text-sm font-semibold text-text">Severities</legend>
          <div className="flex flex-wrap gap-4">
            {ALERT_SEVERITIES.map((severity) => (
              <Checkbox
                key={severity}
                label={severity}
                checked={rule.severities.includes(severity)}
                onChange={() => change({ ...rule, severities: toggle(rule.severities, severity) })}
              />
            ))}
          </div>
        </fieldset>
        {['expiration', 'review'].includes(rule.kind) && (
          <>
            <Field
              label="Reminder days"
              help="Days before the due date, separated by commas. Use 0 for the due date; up to 12 days, from 0 to 365."
            >
              {(p) => (
                <Input
                  {...p}
                  value={days}
                  onChange={(e) => {
                    setDays(e.target.value);
                    change({ ...rule, daysBefore: e.target.value.split(/[ ,]+/).filter(Boolean).map(Number) });
                  }}
                />
              )}
            </Field>
            <Checkbox
              label="Include overdue items"
              checked={rule.includeOverdue}
              onChange={(e) => change({ ...rule, includeOverdue: e.target.checked })}
            />
          </>
        )}
        {rule.kind !== 'breach' && rule.kind !== 'infection' && (
          <Field
            label="Send as"
            help="A daily summary goes at the summary hour under Timing, one per person or channel. Breaches and infections always go straight away."
          >
            {(p) => (
              <Select
                {...p}
                value={rule.delivery}
                onChange={(e) => change({ ...rule, delivery: e.target.value as AlertDeliveryStyle })}
              >
                {ALERT_DELIVERY_STYLES.map((s) => (
                  <option key={s} value={s}>
                    {ALERT_DELIVERY_STYLE_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Checkbox
          label="Microsoft Teams client channel"
          description="Uses this client's saved Teams mapping and connected account."
          checked={rule.teams}
          onChange={(e) => change({ ...rule, teams: e.target.checked })}
        />
      </div>
    </Card>
  );
}
