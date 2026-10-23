import { z } from 'zod';
import { TEAMS_ALERT_KINDS, TEAMS_ALERT_LABELS } from './teams.js';
import { formattedTeamsHtml } from './teams-format.js';

export const ALERT_KINDS = TEAMS_ALERT_KINDS;
export const ALERT_KIND_LABELS = TEAMS_ALERT_LABELS;
export type AlertKind = (typeof ALERT_KINDS)[number];
export const ALERT_FIELDS = {
  clientName: 'Client name',
  eventName: 'Alert type',
  itemName: 'Item name (safe summary)',
  itemType: 'Item type',
  dueDate: 'Due date',
  daysRemaining: 'Days remaining',
  severity: 'Severity',
  atlasUrl: 'Atlas link',
} as const;
export type AlertField = keyof typeof ALERT_FIELDS;
export type AlertValues = Record<AlertField, string>;

/** Only simple, named fields are supported: no expressions, HTML execution, or object traversal. */
export function alertTemplateFields(text: string): AlertField[] {
  const fields: AlertField[] = [];
  const remaining = text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_match, field: string) => {
    if (!Object.hasOwn(ALERT_FIELDS, field)) throw new Error(`Unknown field: ${field}. Use Insert field.`);
    fields.push(field as AlertField);
    return '';
  });
  if (remaining.includes('{{') || remaining.includes('}}'))
    throw new Error('Use Insert field to add a supported template field.');
  return fields;
}
const templateText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .superRefine((text, ctx) => {
      try {
        alertTemplateFields(text);
      } catch (error) {
        ctx.addIssue({ code: 'custom', message: (error as Error).message });
      }
    });
export const alertTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(ALERT_KINDS),
  emailSubject: templateText(200).refine((v) => !/[\r\n]/.test(v), 'The subject must be a single line.'),
  emailBody: templateText(12000),
  teamsBody: templateText(12000),
  teamsFormat: z.enum(['text', 'formatted']).optional(),
});
export type AlertTemplate = z.infer<typeof alertTemplateSchema>;
export const ALERT_ITEM_KINDS = ['asset', 'document', 'password'] as const;
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
const uniqueIds = z
  .array(z.string().uuid())
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, 'Remove duplicate selections.');

export const alertRuleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    kind: z.enum(ALERT_KINDS),
    templateId: z.string().uuid(),
    clientIds: uniqueIds.default([]),
    itemKinds: z.array(z.enum(ALERT_ITEM_KINDS)).min(1).max(3),
    daysBefore: z.array(z.number().int().min(0).max(365)).max(12),
    includeOverdue: z.boolean().default(false),
    severities: z.array(z.enum(ALERT_SEVERITIES)).min(1).max(3),
    emailUserIds: uniqueIds.default([]),
    teams: z.boolean().default(false),
  })
  .superRefine((rule, ctx) => {
    if (!rule.teams && !rule.emailUserIds.length)
      ctx.addIssue({
        code: 'custom',
        path: ['emailUserIds'],
        message: 'Choose an email recipient or Microsoft Teams.',
      });
    if (['expiration', 'review'].includes(rule.kind) && !rule.daysBefore.length && !rule.includeOverdue)
      ctx.addIssue({
        code: 'custom',
        path: ['daysBefore'],
        message: 'Choose a reminder day or include overdue items.',
      });
  });
export type AlertRule = z.infer<typeof alertRuleSchema>;

export const alertWorkspaceSchema = z
  .object({
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    templates: z.array(alertTemplateSchema).max(100),
    rules: z.array(alertRuleSchema).max(200),
  })
  .superRefine((workspace, ctx) => {
    for (const key of ['templates', 'rules'] as const) {
      if (new Set(workspace[key].map((v) => v.id)).size !== workspace[key].length)
        ctx.addIssue({ code: 'custom', path: [key], message: 'Each entry must have its own ID.' });
    }
    workspace.rules.forEach((rule, index) => {
      const template = workspace.templates.find((v) => v.id === rule.templateId);
      if (!template || template.kind !== rule.kind)
        ctx.addIssue({
          code: 'custom',
          path: ['rules', index, 'templateId'],
          message: 'Choose a template for this alert type.',
        });
    });
  });
export type AlertWorkspace = z.infer<typeof alertWorkspaceSchema>;

export const alertSampleSchema = z.object({
  kind: z.enum(ALERT_KINDS),
  clientId: z.string().uuid().nullable(),
  itemKind: z.enum(ALERT_ITEM_KINDS),
  daysRemaining: z.number().int().min(-365).max(365),
  severity: z.enum(ALERT_SEVERITIES),
});
export type AlertSample = z.infer<typeof alertSampleSchema>;
export function alertSampleValues(sample: AlertSample, clientName: string, atlasUrl: string): AlertValues {
  const names: Record<AlertSample['itemKind'], string> = {
    asset: 'Example certificate',
    document: 'Example review document',
    password: 'A password needs attention',
  };
  const due = new Date('2030-06-01T00:00:00Z');
  due.setUTCDate(due.getUTCDate() + sample.daysRemaining);
  return {
    clientName,
    eventName: ALERT_KIND_LABELS[sample.kind],
    itemName: names[sample.itemKind],
    itemType: sample.itemKind,
    dueDate: due.toISOString().slice(0, 10),
    daysRemaining: String(sample.daysRemaining),
    severity: sample.severity,
    atlasUrl,
  };
}
export const alertPreviewSchema = z
  .object({
    template: alertTemplateSchema,
    rule: alertRuleSchema.optional(),
    sample: alertSampleSchema,
  })
  .superRefine((v, ctx) => {
    if (v.rule && (v.rule.templateId !== v.template.id || v.rule.kind !== v.template.kind))
      ctx.addIssue({ code: 'custom', path: ['rule'], message: 'The rule and template must use the same alert type.' });
  });
export interface AlertPreview {
  teamsHtml?: string;
  emailSubject: string;
  emailBody: string;
  teamsBody: string;
  matched: boolean;
  reasons: string[];
  destinations: { label: string; ready: boolean; detail: string }[];
}

export function renderAlertTemplate(template: AlertTemplate, values: AlertValues) {
  const render = (text: string, max: number) => {
    alertTemplateFields(text);
    const result = text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_m, key: AlertField) => values[key]);
    if (result.length > max) throw new Error('The rendered message is too long. Shorten the template.');
    return result;
  };
  const teamsBody = render(template.teamsBody, 12000);
  return {
    ...(template.teamsFormat === 'formatted' ? { teamsHtml: formattedTeamsHtml(teamsBody) } : {}),
    emailSubject: render(template.emailSubject, 300).replace(/[\r\n]+/g, ' '),
    emailBody: render(template.emailBody, 20000),
    teamsBody,
  };
}

export function matchAlertRule(rule: AlertRule, sample: AlertSample): { matched: boolean; reasons: string[] } {
  const checks = [
    { passed: rule.kind === sample.kind, label: 'Alert type matches', failure: 'Alert type does not match' },
    {
      passed: !rule.clientIds.length || (sample.clientId !== null && rule.clientIds.includes(sample.clientId)),
      label: 'Client is included',
      failure: 'Client is outside this rule',
    },
    {
      passed: rule.itemKinds.includes(sample.itemKind),
      label: 'Item type is included',
      failure: 'Item type is excluded',
    },
    {
      passed: rule.severities.includes(sample.severity),
      label: 'Severity is included',
      failure: 'Severity is excluded',
    },
  ];
  if (['expiration', 'review'].includes(rule.kind))
    checks.push({
      passed: rule.daysBefore.includes(sample.daysRemaining) || (rule.includeOverdue && sample.daysRemaining < 0),
      label: 'Reminder day matches',
      failure: 'This is not a selected reminder day',
    });
  return { matched: checks.every((v) => v.passed), reasons: checks.map((v) => (v.passed ? v.label : v.failure)) };
}

export function defaultAlertWorkspace(): AlertWorkspace {
  const ids: Record<AlertKind, string> = {
    expiration: 'd839c4ad-7ba0-49d0-b749-1f64caf23801',
    review: 'd839c4ad-7ba0-49d0-b749-1f64caf23802',
    breach: 'd839c4ad-7ba0-49d0-b749-1f64caf23803',
    infection: 'd839c4ad-7ba0-49d0-b749-1f64caf23804',
  };
  return {
    revision: 0,
    rules: [],
    templates: ALERT_KINDS.map((kind) => ({
      id: ids[kind],
      name: `${ALERT_KIND_LABELS[kind]} — starter`,
      kind,
      emailSubject: '{{clientName}}: {{eventName}}',
      emailBody:
        '{{eventName}} for {{clientName}}\n\n{{itemName}} ({{itemType}})\nSeverity: {{severity}}\n\nOpen Atlas for details: {{atlasUrl}}',
      teamsBody: '{{clientName}} — {{eventName}}\n{{itemName}}\nSeverity: {{severity}}\n{{atlasUrl}}',
    })),
  };
}
