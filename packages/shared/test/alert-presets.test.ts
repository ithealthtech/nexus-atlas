import { describe, expect, it } from 'vitest';
import { ALERT_PRESETS } from '../src/alert-presets.js';
import { alertTemplateSchema, alertSampleValues, renderAlertTemplate } from '../src/alerting.js';
import { formattedTeamsHtml } from '../src/teams-format.js';

describe('Teams template library', () => {
  it.each(ALERT_PRESETS)('renders the $id preset with supported fields and a companion email', (preset) => {
    const template = alertTemplateSchema.parse({ ...preset.template, id: '01000000-0000-4000-8000-000000000001' });
    const values = alertSampleValues(
      { kind: template.kind, clientId: null, itemKind: 'asset', daysRemaining: -3, severity: 'critical' },
      'Example & Co',
      'https://atlas.example/clients/example',
    );
    const result = renderAlertTemplate(template, values);
    expect(result.teamsHtml).toContain('<strong>');
    expect(result.teamsHtml).toContain('Example &amp; Co');
    expect(result.teamsHtml).toContain('href="https://atlas.example/clients/example"');
    expect(result.teamsHtml).not.toContain('{{');
    expect(result.emailBody).not.toContain('**');
    expect(result.emailSubject).toContain('Example & Co');
    if (template.kind === 'breach') expect(result.teamsBody).not.toContain('Example certificate');
  });
  it('escapes raw HTML, attributes and hostile URLs without generating executable markup', () => {
    const html = formattedTeamsHtml(
      '## <img src=x onerror=alert(1)>\n**<script>alert(1)</script>**\njavascript:alert(1)\nhttps://example.test/"onmouseover="bad\nhttps://user:pass@example.test',
    );
    expect(html).not.toMatch(/<img|<script|href="javascript:|href="https:\/\/user/);
    expect(html).toContain('&lt;img');
    expect(html).toContain('%22');
  });
  it('escapes interpolated values and keeps legacy templates plain', () => {
    const template = { ...ALERT_PRESETS[0]!.template, id: '01000000-0000-4000-8000-000000000001' };
    const values = alertSampleValues(
      { kind: 'expiration', clientId: null, itemKind: 'asset', daysRemaining: 7, severity: 'warning' },
      '<script>attack</script>',
      'https://atlas.example',
    );
    expect(renderAlertTemplate(template, values).teamsHtml).not.toContain('<script>');
    expect(renderAlertTemplate({ ...template, teamsFormat: undefined }, values)).not.toHaveProperty('teamsHtml');
    expect(new Set(ALERT_PRESETS.map((p) => p.id)).size).toBe(ALERT_PRESETS.length);
  });
});
