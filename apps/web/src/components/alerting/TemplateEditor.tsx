import { useRef, useState } from 'react';
import { ALERT_FIELDS, ALERT_KIND_LABELS, type AlertField, type AlertTemplate } from '@atlas/shared';
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from '@/components/ui';

type TextField = 'emailSubject' | 'emailBody' | 'teamsBody';
const TEXT_FIELDS: { key: TextField; label: string; max: number }[] = [
  { key: 'emailSubject', label: 'Email subject', max: 200 },
  { key: 'emailBody', label: 'Email message', max: 12000 },
  { key: 'teamsBody', label: 'Teams message', max: 12000 },
];

export function TemplateEditor({ template, change }: { template: AlertTemplate; change: (t: AlertTemplate) => void }) {
  const [target, setTarget] = useState<TextField>('emailBody');
  const [field, setField] = useState<AlertField>('clientName');
  const controls = useRef<Partial<Record<TextField, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const insert = () => {
    const control = controls.current[target];
    const text = template[target];
    const start = control?.selectionStart ?? text.length;
    const end = control?.selectionEnd ?? start;
    change({ ...template, [target]: text.slice(0, start) + `{{${field}}}` + text.slice(end) });
    control?.focus();
  };
  return (
    <Card>
      <CardHeader
        title="Template editor"
        description={`${ALERT_KIND_LABELS[template.kind]} · messages with safe fields`}
      />
      <div className="space-y-4 p-5">
        <Field
          label="Teams formatting"
          help="Formatted messages support ## headings, **bold**, - list items and a web address on its own line. Raw HTML is displayed as text."
        >
          {(p) => (
            <Select
              {...p}
              value={template.teamsFormat ?? 'text'}
              onChange={(e) => change({ ...template, teamsFormat: e.target.value as 'text' | 'formatted' })}
            >
              <option value="text">Plain text</option>
              <option value="formatted">Formatted message</option>
            </Select>
          )}
        </Field>
        <Field label="Template name">
          {(p) => (
            <Input
              {...p}
              value={template.name}
              maxLength={100}
              onChange={(e) => change({ ...template, name: e.target.value })}
            />
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Insert into">
            {(p) => (
              <Select {...p} value={target} onChange={(e) => setTarget(e.target.value as TextField)}>
                {TEXT_FIELDS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Field to insert">
            {(p) => (
              <Select {...p} value={field} onChange={(e) => setField(e.target.value as AlertField)}>
                {Object.entries(ALERT_FIELDS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Button variant="secondary" onClick={insert}>
          Insert field
        </Button>
        {TEXT_FIELDS.map(({ key, label, max }) => (
          <Field key={key} label={label}>
            {(p) =>
              key === 'emailSubject' ? (
                <Input
                  {...p}
                  ref={(el) => {
                    controls.current[key] = el;
                  }}
                  value={template[key]}
                  maxLength={max}
                  onFocus={() => setTarget(key)}
                  onChange={(e) => change({ ...template, [key]: e.target.value })}
                />
              ) : (
                <Textarea
                  {...p}
                  ref={(el) => {
                    controls.current[key] = el;
                  }}
                  value={template[key]}
                  maxLength={max}
                  rows={7}
                  onFocus={() => setTarget(key)}
                  onChange={(e) => change({ ...template, [key]: e.target.value })}
                />
              )
            }
          </Field>
        ))}
        <p className="text-xs text-muted">
          Fields never include passwords, recovery keys, or tokens. HTML appears as text. Each channel has its own
          message.
        </p>
      </div>
    </Card>
  );
}
