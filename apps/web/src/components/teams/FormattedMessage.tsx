import { formattedTeamsHtml } from '@atlas/shared';

export function FormattedMessage({ content }: { content: string }) {
  // HTML is generated locally from an escaping formatter, never trusted from Graph or the preview response.
  return (
    <div
      className="space-y-2 text-sm break-words text-text-2 [&_a]:font-semibold [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold"
      dangerouslySetInnerHTML={{ __html: formattedTeamsHtml(content) }}
    />
  );
}
