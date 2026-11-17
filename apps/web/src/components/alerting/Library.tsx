import { useState } from 'react';
import { FileText, Mail, MessageSquare, Plus } from 'lucide-react';
import { ALERT_KINDS, ALERT_KIND_LABELS, ALERT_PRESETS, type AlertKind } from '@atlas/shared';
import { Badge, Button, Card, Field, Input, Select } from '@/components/ui';
import type { AlertEditor } from './useAlertEditor';

export function Library({ editor: e, onUseTemplate }: { editor: AlertEditor; onUseTemplate: (id: string) => void }) {
  const [presetId, setPresetId] = useState(ALERT_PRESETS[0]!.id);
  const [search, setSearch] = useState('');
  const savedTemplates = new Map(e.savedTemplates.map((t) => [t.id, t]));
  const templates = e.workspace.templates
    .toReversed()
    .filter((t) => `${t.name} ${ALERT_KIND_LABELS[t.kind]}`.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <div className="space-y-5">
      <section
        aria-label="Saved template library"
        className="overflow-hidden rounded-lg border border-border-strong bg-surface"
      >
        <div className="space-y-4 border-b border-border-strong bg-surface-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Your template library</h2>
              <p className="mt-1 text-sm text-text-2">
                {e.workspace.templates.length} templates · Email and Teams messages together
              </p>
            </div>
            <Badge tone="neutral">{e.savedTemplates.length} saved</Badge>
          </div>
          <Field label="Find a template">
            {(p) => (
              <Input
                {...p}
                type="search"
                placeholder="Search by name or alert type"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
          </Field>
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
        </div>
        <ul
          tabIndex={0}
          aria-label="Available templates"
          className="grid max-h-[var(--alert-library-height)] gap-3 overflow-y-auto p-4"
        >
          {templates.map((t) => (
            <li
              key={t.id}
              className={`min-w-0 rounded-lg border p-4 ${e.template?.id === t.id ? 'border-primary bg-primary-soft' : 'border-border-strong bg-surface'}`}
            >
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 size-5 shrink-0 text-text-2" aria-hidden />
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold break-words">{t.name}</h3>
                  <p className="mt-1 text-sm text-text-2">
                    {ALERT_KIND_LABELS[t.kind]} ·{' '}
                    {JSON.stringify(savedTemplates.get(t.id)) === JSON.stringify(t)
                      ? 'Saved'
                      : savedTemplates.has(t.id)
                        ? 'Unsaved edits'
                        : 'Not saved yet'}
                  </p>
                  <div className="mt-3 flex gap-3 text-xs font-medium text-text-2">
                    <span className="flex items-center gap-1">
                      <Mail className="size-3.5" aria-hidden /> Email
                    </span>
                    <span className="flex items-center gap-1">
                      <MessageSquare className="size-3.5" aria-hidden /> Teams
                    </span>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => e.selectTemplate(t.id)}>
                  Edit template
                </Button>
                <Button size="sm" disabled={e.workspace.rules.length >= 200} onClick={() => onUseTemplate(t.id)}>
                  Use in new rule
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {!templates.length && (
          <p className="p-5 text-sm text-text-2">No templates match. Clear the search or create a template below.</p>
        )}
      </section>
      <Card className="space-y-4 border-border-strong bg-surface-2 p-5">
        <h2 className="flex items-center gap-2 font-semibold">
          <Plus className="size-4" aria-hidden /> Create a template
        </h2>
        <div className="flex flex-wrap items-end gap-3">
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
          <Button variant="secondary" disabled={e.workspace.templates.length >= 100} onClick={e.addTemplate}>
            New template
          </Button>
          <Button
            variant="secondary"
            disabled={!e.template || e.workspace.rules.length >= 200}
            onClick={() => e.template && onUseTemplate(e.template.id)}
          >
            New rule from template
          </Button>
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
        <p className="text-sm text-text-2">
          Templates used by a rule cannot be removed. Save drafts to keep new templates and edits.
        </p>
        <details className="rounded-lg border border-border-strong bg-surface p-4">
          <summary className="cursor-pointer font-semibold">Browse ready-made Teams templates</summary>
          <div className="mt-4 space-y-3">
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
            <p className="text-sm text-text-2">Creates an editable copy in your library, with an email companion.</p>
          </div>
        </details>
      </Card>
    </div>
  );
}
