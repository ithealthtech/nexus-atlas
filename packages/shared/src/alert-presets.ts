import type { AlertKind, AlertTemplate } from './alerting.js';

const content: Record<AlertKind, { title: string; summary: string; steps: string[]; facts: string }> = {
  expiration: {
    title: 'Expiration reminder',
    summary: 'An item needs attention before its recorded expiry date.',
    facts: '**Due date:** {{dueDate}}\n**Days remaining:** {{daysRemaining}}',
    steps: [
      'Open the record and confirm the renewal or rotation requirements.',
      'Assign an owner and record the planned completion date.',
      'Update the record after completion so future reminders reflect the new date.',
    ],
  },
  review: {
    title: 'Documentation review',
    summary: 'A document is approaching or has passed its review date.',
    facts: '**Review date:** {{dueDate}}\n**Days remaining:** {{daysRemaining}}',
    steps: [
      'Check the document against the current client environment.',
      'Correct outdated instructions, links and contacts.',
      'Record the review and next review date in Atlas.',
    ],
  },
  breach: {
    title: 'Password breach alert',
    summary: 'A stored password was found in a breach. Review the affected record in Atlas.',
    facts: '**Privacy:** Credential details are available only in Atlas.',
    steps: [
      'Have an authorized technician review the affected credential.',
      'Follow the client’s approved credential response procedure.',
      'Record actions and follow-up in Atlas; never paste credentials into this thread.',
    ],
  },
  infection: {
    title: 'Confirmed infection alert',
    summary: 'A confirmed infection event needs review by the response team.',
    facts: '**Item:** {{itemName}}',
    steps: [
      'Open Atlas and verify the event details and affected asset.',
      'Follow the client’s approved incident response procedure.',
      'Record the owner, actions taken and next update in the incident record.',
    ],
  },
};
export interface AlertPreset {
  id: string;
  name: string;
  description: string;
  template: Omit<AlertTemplate, 'id'>;
}
export const ALERT_PRESETS: AlertPreset[] = (Object.keys(content) as AlertKind[]).flatMap((kind) => {
  const c = content[kind];
  return (['detailed', 'compact'] as const).map((style) => {
    const title = `${c.title} — ${style}`;
    const facts = `**Client:** {{clientName}}\n**Severity:** {{severity}}\n${kind === 'infection' || kind === 'breach' ? '' : '**Item:** {{itemName}}\n'}${c.facts}`;
    const teamsBody =
      style === 'detailed'
        ? `## ${c.title}\n${c.summary}\n\n${facts}\n\n## Next steps\n${c.steps.map((s) => '- ' + s).join('\n')}\n\n## Coordinate in this thread\nReply with the responsible person and next update time. Keep sensitive details in Atlas.\n\n{{atlasUrl}}`
        : `## ${c.title}\n${facts}\n\n${c.steps[0]}\n{{atlasUrl}}`;
    return {
      id: `${kind}-${style}`,
      name: title,
      description:
        style === 'detailed'
          ? 'Facts, response checklist, Atlas link and a thread coordination prompt.'
          : 'A short channel notice with key facts and an Atlas link.',
      template: {
        name: title,
        kind,
        teamsFormat: 'formatted',
        teamsBody,
        emailSubject: `{{clientName}}: ${c.title}`,
        emailBody: `${c.summary}\n\nClient: {{clientName}}\nSeverity: {{severity}}\n${c.facts.replaceAll('**', '')}\n\n${c.steps.join('\n')}\n\nOpen Atlas: {{atlasUrl}}`,
      },
    };
  });
});
