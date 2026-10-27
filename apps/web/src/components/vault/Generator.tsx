import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { STRENGTH_LABELS, passwordStrength, type VaultPolicy } from '@atlas/shared';
import { Button, Checkbox, Skeleton, type Tone } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  DEFAULT_GENERATOR,
  applyGeneratorPolicy,
  generatePassword,
  loadGeneratorOptions,
  presetFor,
  presetsFor,
  saveGeneratorOptions,
  useVaultPolicy,
  type GeneratorOptions,
} from '@/lib/vault';

// The strength meter and the password generator, shared by the vault and the personal vault.
export const strengthTone: Tone[] = ['danger', 'danger', 'warning', 'success', 'success'];

export function StrengthMeter({ value }: { value: string }) {
  const score = passwordStrength(value);
  return (
    <div className="mt-1.5 flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              'h-1.5 flex-1 rounded-full bg-surface-3',
              value && i < Math.max(score, 1) && (score <= 1 ? 'bg-danger' : score === 2 ? 'bg-warning' : 'bg-success'),
            )}
          />
        ))}
      </div>
      <span className="w-24 text-right text-xs text-muted">{value ? STRENGTH_LABELS[score] : ''}</span>
    </div>
  );
}

export function Generator({ onUse }: { onUse: (value: string) => void }) {
  const { data } = useVaultPolicy();
  // Starts again if the policy changes while it's open.
  return data ? (
    <PolicyGenerator key={JSON.stringify(data.generator)} policy={data.generator} onUse={onUse} />
  ) : (
    <Skeleton className="h-36" />
  );
}

function PolicyGenerator({ policy, onUse }: { policy: VaultPolicy['generator']; onUse: (value: string) => void }) {
  const [options, setOptions] = useState<GeneratorOptions>(() => applyGeneratorPolicy(loadGeneratorOptions(), policy));
  const [value, setValue] = useState(() => generatePassword(options));
  const update = (patch: Partial<GeneratorOptions>) => {
    const next = { ...options, ...patch };
    // Switching into PIN mode starts from a PIN-sized length; leaving it restores a sensible one.
    if (patch.mode === 'pin' && options.mode !== 'pin') next.length = 6;
    if (patch.mode && patch.mode !== 'pin' && options.mode === 'pin') next.length = DEFAULT_GENERATOR.length;
    const allowed = applyGeneratorPolicy(next, policy);
    setOptions(allowed);
    setValue(generatePassword(allowed));
  };
  const presets = presetsFor(policy);
  const preset = presetFor(options, presets);
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-2 p-4">
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded-md bg-surface px-3 py-2 font-mono text-sm"
          aria-label="Generated password"
        >
          {value}
        </code>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Generate another"
          onClick={() => setValue(generatePassword(options))}
        >
          <RefreshCw />
        </Button>
        <Button
          size="sm"
          onClick={() => {
            saveGeneratorOptions(options);
            onUse(value);
          }}
        >
          Use
        </Button>
      </div>
      <div role="group" aria-label="Presets" className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={preset === p.id}
            title={p.hint}
            onClick={() => {
              setOptions(p.options);
              setValue(generatePassword(p.options));
            }}
            className="rounded-full border border-border px-2.5 py-1 text-xs font-medium text-text-2 hover:bg-surface-3 aria-pressed:border-primary aria-pressed:bg-primary-soft aria-pressed:text-text"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <div role="group" aria-label="Generator type" className="flex gap-1 rounded-lg bg-surface-3 p-1">
          {(['characters', 'passphrase', 'pin'] as const)
            .filter((mode) => mode !== 'pin' || policy.allowPins)
            .map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={options.mode === mode}
                onClick={() => update({ mode })}
                className="rounded-md px-2.5 py-1 text-xs font-medium capitalize aria-pressed:bg-surface"
              >
                {mode === 'pin' ? 'PIN' : mode}
              </button>
            ))}
        </div>
        {options.mode === 'pin' ? (
          <label className="flex items-center gap-2">
            Digits
            <input
              type="range"
              min={4}
              max={12}
              value={options.length}
              onChange={(e) => update({ length: Number(e.target.value) })}
              className="accent-(--primary)"
            />
            <span className="w-6 tabular-nums">{options.length}</span>
          </label>
        ) : options.mode === 'characters' ? (
          <>
            <label className="flex items-center gap-2">
              Length
              <input
                type="range"
                min={policy.minLength}
                max={64}
                value={options.length}
                onChange={(e) => update({ length: Number(e.target.value) })}
                className="accent-(--primary)"
              />
              <span className="w-6 tabular-nums">{options.length}</span>
            </label>
            <Checkbox
              label="Numbers"
              checked={options.digits}
              disabled={policy.requireDigits}
              onChange={(e) => update({ digits: e.target.checked })}
            />
            <Checkbox
              label="Symbols"
              checked={options.symbols}
              disabled={policy.requireSymbols}
              onChange={(e) => update({ symbols: e.target.checked })}
            />
          </>
        ) : (
          <label className="flex items-center gap-2">
            Words
            <input
              type="range"
              min={4}
              max={10}
              value={options.words}
              onChange={(e) => update({ words: Number(e.target.value) })}
              className="accent-(--primary)"
            />
            <span className="w-6 tabular-nums">{options.words}</span>
          </label>
        )}
      </div>
    </div>
  );
}
