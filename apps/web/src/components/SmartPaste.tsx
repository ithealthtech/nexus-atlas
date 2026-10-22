import { useState } from 'react';
import { ClipboardPaste, X } from 'lucide-react';
import { parseMachineInfo, smartPasteFields, type LayoutField, type MachineInfo } from '@atlas/shared';
import { Button, Checkbox, Textarea } from '@/components/ui';

/** Every kind of value smart paste can find, to tell whether a layout has anywhere to put them. */
const EVERYTHING: MachineInfo = {
  hostname: 'x',
  ipAddresses: ['10.0.0.1'],
  macAddress: 'x',
  manufacturer: 'x',
  model: 'x',
  serialNumber: 'x',
  operatingSystem: 'x',
  domain: 'x',
};
/** Whether a layout has fields smart paste can fill (Configurations does; a Domains layout doesn't). */
export const canSmartPaste = (fields: LayoutField[]) => smartPasteFields(EVERYTHING, fields).length >= 2;

/** Pasted text that is clearly a command's output about a device, not a value for one field. */
export function looksLikeMachineInfo(text: string, fields: LayoutField[]) {
  return text.includes('\n') && smartPasteFields(parseMachineInfo(text), fields).length >= 3;
}

/**
 * Fills a new or existing asset from what a command printed on the device: ipconfig /all, systeminfo, or
 * Get-ComputerInfo on Windows, system_profiler on a Mac, hostnamectl on Linux. It's read in the browser. Empty fields
 * are ticked to fill; a field that already has a different value is shown with it, unticked.
 */
export function SmartPaste({
  fields,
  values,
  name,
  initial = '',
  onApply,
  onClose,
}: {
  fields: LayoutField[];
  values: Record<string, unknown>;
  name: string;
  initial?: string;
  onApply: (found: Record<string, string>, name: string | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const info = parseMachineInfo(text);
  const found = smartPasteFields(info, fields);
  const current = (key: string) => (values[key] === undefined || values[key] === null ? '' : String(values[key]));
  const suggestedName = !name.trim() && info.hostname ? info.hostname : null;
  // What's ticked: everything that fills a blank, until the person changes it.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const isTicked = (key: string) =>
    ticked.has(key) ||
    (!unticked.has(key) && (!current(key) || current(key) === found.find((f) => f.key === key)?.value));
  const chosen = found.filter((f) => isTicked(f.key) && current(f.key) !== f.value);
  const [useName, setUseName] = useState(true);

  return (
    <section aria-labelledby="smart-paste-title" className="rounded-lg border border-primary/30 bg-primary-soft/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 id="smart-paste-title" className="flex items-center gap-2 text-sm font-semibold">
            <ClipboardPaste className="size-4 text-primary" aria-hidden /> Smart paste
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            On the device, run <code>ipconfig /all</code>, <code>systeminfo</code>, or <code>Get-ComputerInfo</code> (on
            a Mac, <code>system_profiler SPHardwareDataType</code>; on Linux, <code>hostnamectl</code>) and paste what
            it prints. It&rsquo;s read here in your browser.
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close smart paste" onClick={onClose}>
          <X />
        </Button>
      </div>
      <Textarea
        aria-label="Command output"
        className="mt-3 font-mono text-xs"
        rows={text ? 5 : 4}
        value={text}
        autoFocus={!initial}
        onChange={(e) => setText(e.target.value)}
        placeholder={'Host Name . . . . : HDG-DC-01\nIPv4 Address. . . : 10.20.0.10'}
      />
      {text.trim() && !found.length && !suggestedName && (
        <p className="mt-3 text-xs text-muted">
          Nothing recognised yet. Paste the whole output, including the lines with the names.
        </p>
      )}
      {(found.length > 0 || suggestedName) && (
        <>
          <ul className="mt-3 divide-y divide-border rounded-md border border-border bg-surface">
            {suggestedName && (
              <li className="px-3 py-2.5">
                <Checkbox
                  label={
                    <>
                      Name: <strong>{suggestedName}</strong>
                    </>
                  }
                  checked={useName}
                  onChange={(e) => setUseName(e.currentTarget.checked)}
                />
              </li>
            )}
            {found.map((f) => {
              const now = current(f.key);
              const same = now === f.value;
              return (
                <li key={f.key} className="px-3 py-2.5">
                  <Checkbox
                    label={
                      <>
                        {f.label}: <strong className="break-all">{f.value}</strong>
                      </>
                    }
                    description={same ? 'Already filled in.' : now ? `Replaces ${now}` : undefined}
                    checked={isTicked(f.key)}
                    disabled={same}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setTicked((s) => {
                        const next = new Set(s);
                        if (on) next.add(f.key);
                        else next.delete(f.key);
                        return next;
                      });
                      setUnticked((s) => {
                        const next = new Set(s);
                        if (on) next.delete(f.key);
                        else next.add(f.key);
                        return next;
                      });
                    }}
                  />
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              disabled={!chosen.length && !(suggestedName && useName)}
              onClick={() =>
                onApply(
                  Object.fromEntries(chosen.map((f) => [f.key, f.value])),
                  suggestedName && useName ? suggestedName : null,
                )
              }
            >
              Fill in {chosen.length + (suggestedName && useName ? 1 : 0)}{' '}
              {chosen.length + (suggestedName && useName ? 1 : 0) === 1 ? 'field' : 'fields'}
            </Button>
            {info.ipAddresses.length > 1 && (
              <p className="text-xs text-muted">Other addresses: {info.ipAddresses.slice(1).join(', ')}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
