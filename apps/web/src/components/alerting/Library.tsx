import { useState } from 'react';
import { ALERT_KINDS, ALERT_KIND_LABELS, ALERT_PRESETS, type AlertKind } from '@atlas/shared';
import { Button, Card, CardHeader, Field, Select } from '@/components/ui';
import type { AlertEditor } from './useAlertEditor';

export function Library({ editor: e }: { editor: AlertEditor }) {
  const [presetId, setPresetId] = useState(ALERT_PRESETS[0]!.id);
  return (
    <Card>
      <CardHeader
        title="Rules & templates"
        description={`${e.workspace.rules.length} draft rules · ${e.workspace.templates.length} templates`}
      />
      <div className="space-y-4 p-5">
        <Field label="Ready-made Teams template" help={ALERT_PRESETS.find((p) => p.id === presetId)?.description}>
          {(p) => (
            <Select {...p} value={presetId} onChange={(event) => setPresetId(event.target.value)}>
              {ALERT_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          variant="secondary"
          disabled={e.workspace.templates.length >= 100}
          onClick={() => e.addPreset(presetId)}
        >
          Use template
        </Button>
        <p className="text-xs text-muted">
          Creates an editable copy with an email companion. Review, preview and save before using it in a rule.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Template library">
            {(p) => (
              <Select {...p} value={e.template?.id ?? ''} onChange={(event) => e.selectTemplate(event.target.value)}>
                <option value="" disabled>
                  Choose a template
                </option>
                {e.workspace.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Draft rule">
            {(p) => (
              <Select {...p} value={e.ruleId} onChange={(event) => e.selectRule(event.target.value)}>
                <option value="">Template preview only</option>
                {e.workspace.rules.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="New template alert type">
            {(p) => (
              <Select {...p} value={e.kind} onChange={(event) => e.setKind(event.target.value as AlertKind)}>
                {ALERT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ALERT_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" disabled={e.workspace.templates.length >= 100} onClick={e.addTemplate}>
            New template
          </Button>
          <Button variant="secondary" disabled={!e.template || e.workspace.rules.length >= 200} onClick={e.addRule}>
            New rule from template
          </Button>
          {e.rule && (
            <Button variant="ghost" onClick={e.removeRule}>
              Remove draft rule
            </Button>
          )}
          {e.template && !e.rule && (
            <Button
              variant="ghost"
              disabled={e.workspace.rules.some((r) => r.templateId === e.template!.id)}
              onClick={e.removeTemplate}
            >
              Remove template
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">
          Templates used by a rule cannot be removed. Removing an unsaved draft can be undone by reloading.
        </p>
      </div>
    </Card>
  );
}
