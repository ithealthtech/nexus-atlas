import { describe, expect, it } from 'vitest';
import {
  alertPreviewSchema,
  alertRuleSchema,
  alertSampleValues,
  alertTemplateSchema,
  alertWorkspaceSchema,
  defaultAlertWorkspace,
  matchAlertRule,
  renderAlertTemplate,
  type AlertSample,
  type AlertRule,
} from '../src/alerting.js';

const CLIENT = '01000000-0000-4000-8000-000000000001';
const OTHER = '01000000-0000-4000-8000-000000000002';
const template = defaultAlertWorkspace().templates[0]!;
const rule: AlertRule = {
  id: OTHER,
  name: 'Certificate reminders',
  kind: 'expiration',
  templateId: template.id,
  clientIds: [CLIENT],
  itemKinds: ['asset'],
  daysBefore: [14, 0],
  includeOverdue: false,
  severities: ['warning', 'critical'],
  emailUserIds: [],
  teams: true,
};
const sample: AlertSample = {
  kind: 'expiration',
  clientId: CLIENT,
  itemKind: 'asset',
  daysRemaining: 14,
  severity: 'warning',
};

describe('alert drafts', () => {
  it('creates independent valid starter templates for all four alert types without active rules', () => {
    const workspace = defaultAlertWorkspace();
    expect(alertWorkspaceSchema.parse(workspace).rules).toEqual([]);
    expect(workspace.templates.map((t) => t.kind)).toEqual(['expiration', 'review', 'breach', 'infection']);
    workspace.templates[0]!.name = 'Edited';
    expect(defaultAlertWorkspace().templates[0]!.name).not.toBe('Edited');
  });
  it.each([
    '{{password}}',
    '{{secret}}',
    '{{token}}',
    '{{constructor}}',
    '{{client.name}}',
    '{{itemName',
    '{{#if overdue}}',
    '{{itemName}}}}',
  ])('rejects unsupported or malformed fields: %s', (emailBody) => {
    expect(alertTemplateSchema.safeParse({ ...template, emailBody }).success).toBe(false);
  });
  it('renders fields once and leaves supplied markup and template-like values as plain text', () => {
    const values = alertSampleValues(sample, '<script>{{severity}}</script>', 'https://atlas.example/expirations');
    const rendered = renderAlertTemplate({ ...template, emailBody: '{{clientName}} / {{ clientName }}' }, values);
    expect(rendered.emailBody).toBe('<script>{{severity}}</script> / <script>{{severity}}</script>');
    expect(rendered.teamsBody).toContain('<script>{{severity}}</script>');
    expect(values.dueDate).toBe('2030-06-15');
  });
  it('prevents subject line breaks and bounds the expanded message length', () => {
    expect(alertTemplateSchema.safeParse({ ...template, emailSubject: 'Hello\r\nBcc: elsewhere' }).success).toBe(false);
    const values = alertSampleValues(sample, 'Client\r\nname', 'https://atlas.example');
    expect(renderAlertTemplate(template, values).emailSubject).not.toContain('\n');
    expect(() =>
      renderAlertTemplate(
        { ...template, teamsBody: '{{clientName}}'.repeat(800) },
        { ...values, clientName: 'A very long example client name' },
      ),
    ).toThrow('too long');
  });
  it('keeps password examples generic and never accepts secret data as template fields', () => {
    const values = alertSampleValues({ ...sample, itemKind: 'password' }, 'Example', 'https://atlas.example');
    expect(values.itemName).toBe('A password needs attention');
    expect(Object.keys(values)).not.toContain('secret');
  });
  it('requires a matching template, unique record IDs, valid milestones, and a destination', () => {
    expect(alertRuleSchema.safeParse({ ...rule, daysBefore: [366] }).success).toBe(false);
    expect(alertRuleSchema.safeParse({ ...rule, teams: false }).success).toBe(false);
    expect(alertRuleSchema.safeParse({ ...rule, daysBefore: [] }).success).toBe(false);
    expect(alertRuleSchema.safeParse({ ...rule, daysBefore: [], includeOverdue: true }).success).toBe(true);
    expect(alertWorkspaceSchema.safeParse({ revision: 0, templates: [template, template], rules: [] }).success).toBe(
      false,
    );
    expect(alertWorkspaceSchema.safeParse({ revision: 0, templates: [], rules: [rule] }).success).toBe(false);
    expect(alertPreviewSchema.safeParse({ template: { ...template, kind: 'breach' }, rule, sample }).success).toBe(
      false,
    );
  });
});

describe('rule dry runs', () => {
  it('explains every condition and applies selected client, type and severity filters', () => {
    expect(matchAlertRule(rule, sample).matched).toBe(true);
    for (const change of [
      { clientId: OTHER },
      { kind: 'review' as const },
      { itemKind: 'password' as const },
      { severity: 'info' as const },
      { daysRemaining: 13 },
    ]) {
      const result = matchAlertRule(rule, { ...sample, ...change });
      expect(result.matched).toBe(false);
      expect(result.reasons).toHaveLength(5);
    }
    expect(matchAlertRule(rule, { ...sample, clientId: null }).matched).toBe(false);
    expect(matchAlertRule({ ...rule, clientIds: [] }, { ...sample, clientId: null }).matched).toBe(true);
  });
  it('distinguishes due today from overdue and requires explicit overdue inclusion', () => {
    expect(matchAlertRule(rule, { ...sample, daysRemaining: 0 }).matched).toBe(true);
    expect(matchAlertRule(rule, { ...sample, daysRemaining: -1 }).matched).toBe(false);
    expect(matchAlertRule({ ...rule, includeOverdue: true }, { ...sample, daysRemaining: -1 }).matched).toBe(true);
  });
  it('applies review milestones and does not apply due dates to security events', () => {
    for (const kind of ['review', 'breach', 'infection'] as const) {
      const result = matchAlertRule({ ...rule, kind }, { ...sample, kind, daysRemaining: 99 });
      expect(result.matched).toBe(kind !== 'review');
    }
  });
});
