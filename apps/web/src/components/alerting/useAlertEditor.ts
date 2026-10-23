import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ALERT_KIND_LABELS,
  ALERT_PRESETS,
  ALERT_ITEM_KINDS,
  ALERT_SEVERITIES,
  alertWorkspaceSchema,
  defaultAlertWorkspace,
  type AlertKind,
  type AlertPreview,
  type AlertRule,
  type AlertSample,
  type AlertTemplate,
  type AlertWorkspace,
} from '@atlas/shared';
import { useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';
import { useActor } from '@/lib/session';

export const ALERTING_BASE = '/settings/alerting';
function newRule(template: AlertTemplate, userId: string): AlertRule {
  return {
    id: crypto.randomUUID(),
    name: `${ALERT_KIND_LABELS[template.kind]} rule`,
    kind: template.kind,
    templateId: template.id,
    clientIds: [],
    itemKinds: [...ALERT_ITEM_KINDS],
    daysBefore: [30, 14, 7, 0],
    includeOverdue: false,
    severities: [...ALERT_SEVERITIES],
    emailUserIds: [userId],
    teams: false,
  };
}

export function useAlertEditor(initial: AlertWorkspace) {
  const queries = useQueryClient();
  const actor = useActor();
  const toast = useToast();
  const [workspace, setWorkspace] = useState(initial);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [templateId, setTemplateId] = useState(initial.templates[0]?.id ?? '');
  const [ruleId, setRuleId] = useState('');
  const [kind, setKind] = useState<AlertKind>('expiration');
  const [sample, setSample] = useState<AlertSample>({
    kind: 'expiration',
    clientId: null,
    itemKind: 'asset',
    daysRemaining: 14,
    severity: 'warning',
  });
  const [preview, setPreview] = useState<{ key: string; result: AlertPreview } | null>(null);
  const { busy, error, act } = useAction();
  const rule = workspace.rules.find((r) => r.id === ruleId);
  const template = workspace.templates.find((t) => t.id === (rule?.templateId ?? templateId));
  const previewBody = template ? { template, ...(rule ? { rule } : {}), sample } : null;
  const previewKey = JSON.stringify(previewBody);
  const dirty = JSON.stringify(workspace) !== saved;
  const replaceWorkspace = (next: AlertWorkspace) => {
    setWorkspace(next);
    setSaved(JSON.stringify(next));
    queries.setQueryData(['alerting'], next);
    setTemplateId(next.templates[0]?.id ?? '');
    setRuleId('');
    setPreview(null);
  };
  const changeTemplate = (next: AlertTemplate) =>
    setWorkspace((w) => ({ ...w, templates: w.templates.map((t) => (t.id === next.id ? next : t)) }));
  const changeRule = (next: AlertRule) =>
    setWorkspace((w) => ({ ...w, rules: w.rules.map((r) => (r.id === next.id ? next : r)) }));
  const selectTemplate = (id: string) => {
    setTemplateId(id);
    setRuleId('');
  };
  const selectRule = (id: string) => {
    setRuleId(id);
    const selected = workspace.rules.find((r) => r.id === id);
    if (selected) {
      setTemplateId(selected.templateId);
      setSample((s) => ({ ...s, kind: selected.kind }));
    }
  };
  const addTemplate = () => {
    const starter = defaultAlertWorkspace().templates.find((t) => t.kind === kind)!;
    const next = { ...starter, id: crypto.randomUUID(), name: `${ALERT_KIND_LABELS[kind]} — custom` };
    setWorkspace((w) => ({ ...w, templates: [...w.templates, next] }));
    selectTemplate(next.id);
    setSample((s) => ({ ...s, kind }));
  };
  const addPreset = (id: string) => {
    const preset = ALERT_PRESETS.find((p) => p.id === id);
    if (!preset || workspace.templates.length >= 100) return;
    const next = { ...preset.template, id: crypto.randomUUID() };
    setWorkspace((w) => ({ ...w, templates: [...w.templates, next] }));
    selectTemplate(next.id);
    setSample((s) => ({
      ...s,
      kind: next.kind,
      itemKind: next.kind === 'review' ? 'document' : next.kind === 'breach' ? 'password' : 'asset',
      severity: ['breach', 'infection'].includes(next.kind) ? 'critical' : 'warning',
    }));
  };
  const addRule = () => {
    if (!template) return;
    const next = newRule(template, actor.id);
    setWorkspace((w) => ({ ...w, rules: [...w.rules, next] }));
    setRuleId(next.id);
    setSample((s) => ({ ...s, kind: template.kind }));
  };
  const removeRule = () => {
    if (!rule) return;
    setWorkspace((w) => ({ ...w, rules: w.rules.filter((r) => r.id !== rule.id) }));
    selectTemplate(rule.templateId);
  };
  const removeTemplate = () => {
    if (!template || workspace.rules.some((r) => r.templateId === template.id)) return;
    const remaining = workspace.templates.filter((t) => t.id !== template.id);
    setWorkspace((w) => ({ ...w, templates: remaining }));
    selectTemplate(remaining[0]?.id ?? '');
  };
  const save = () =>
    act('save', async () => {
      const parsed = alertWorkspaceSchema.safeParse(workspace);
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .slice(0, 3)
            .map((i) => i.message)
            .join(' '),
        );
      const result = await api<AlertWorkspace>(ALERTING_BASE, { method: 'PUT', body: parsed.data });
      setWorkspace(result);
      queries.setQueryData(['alerting'], result);
      setSaved(JSON.stringify(result));
      toast('Alert drafts saved.');
    });
  const run = () =>
    act('preview', async () => {
      if (!previewBody) return;
      const result = await api<AlertPreview>(ALERTING_BASE + '/preview', { method: 'POST', body: previewBody });
      setPreview({ key: previewKey, result });
    });
  return {
    workspace,
    replaceWorkspace,
    template,
    rule,
    ruleId,
    kind,
    setKind,
    sample,
    setSample,
    result: preview?.key === previewKey ? preview.result : null,
    busy,
    error,
    dirty,
    changeTemplate,
    changeRule,
    selectTemplate,
    selectRule,
    addTemplate,
    addPreset,
    addRule,
    removeRule,
    removeTemplate,
    save,
    run,
  };
}
export type AlertEditor = ReturnType<typeof useAlertEditor>;
