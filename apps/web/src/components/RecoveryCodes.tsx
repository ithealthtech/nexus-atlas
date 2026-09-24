import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Button } from '@/components/ui';

/** Shows new recovery codes once, with copy and save-to-file options. */
export function RecoveryCodes({
  codes,
  onDone,
  doneLabel = "I've saved these codes",
}: {
  codes: string[];
  onDone: () => void;
  doneLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const text = `MSP Atlas recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`;
  return (
    <div className="space-y-4">
      <p className="text-sm text-text-2">
        If you lose your authenticator app or passkey, each of these codes signs you in once. Store them in a safe
        place, such as your personal password manager. They won&rsquo;t be shown again.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface-2 p-4 font-mono text-[15px] tracking-wide"
      >
        {codes.map((c) => (
          <li key={c} className="text-center">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(text).catch(() => undefined);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy all'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            Object.assign(document.createElement('a'), { href: url, download: 'atlas-recovery-codes.txt' }).click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          <Download /> Save as file
        </Button>
      </div>
      <Button size="lg" className="w-full" onClick={onDone}>
        {doneLabel}
      </Button>
    </div>
  );
}
