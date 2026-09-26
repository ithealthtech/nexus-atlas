import { useMemo, useState } from 'react';
import type { HuduImportOptions, HuduPreview } from '@atlas/shared';
import { Button, Checkbox, Input } from '@/components/ui';

const KINDS: [
  keyof Pick<HuduImportOptions, 'clients' | 'locations' | 'assets' | 'documents' | 'passwords'>,
  string,
  string,
][] = [
  ['clients', 'Clients', 'Companies become clients. Off: the rest only goes to clients imported before.'],
  ['locations', 'Locations', "Each company's address, as its main location."],
  ['assets', 'Assets', 'Assets of the asset layouts chosen below, with their layouts.'],
  ['documents', 'Documents', 'Articles: company ones into each client, the rest into the knowledge base.'],
  ['passwords', 'Passwords', "Into each client's password list, in folders like Hudu's."],
];

/** A tick list with "all" and "none", used for companies and asset layouts. */
function PickList({
  label,
  items,
  chosen,
  onChange,
}: {
  label: string;
  items: { id: number; name: string; hint?: string }[];
  chosen: number[] | null;
  onChange: (next: number[] | null) => void;
}) {
  const [filter, setFilter] = useState('');
  const selected = new Set(chosen ?? items.map((i) => i.id));
  const shown = items.filter((i) => i.name.toLowerCase().includes(filter.trim().toLowerCase()));
  // Everything ticked is stored as null, so items added in Hudu later are included too.
  const set = (next: Set<number>) => onChange(next.size === items.length ? null : [...next]);
  return (
    <fieldset className="space-y-2">
      <legend className="flex w-full items-center gap-2 text-sm font-semibold">
        {label}
        <span className="font-normal text-muted">
          {selected.size} of {items.length}
        </span>
        <span className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => set(new Set(items.map((i) => i.id)))}>
            All
          </Button>
          <Button size="sm" variant="ghost" onClick={() => set(new Set())}>
            None
          </Button>
        </span>
      </legend>
      {items.length > 8 && (
        <label className="block">
          <span className="sr-only">Filter {label.toLowerCase()}</span>
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${label.toLowerCase()}…`}
          />
        </label>
      )}
      <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border bg-surface p-2">
        {shown.map((i) => (
          <li key={i.id}>
            <Checkbox
              label={i.hint ? `${i.name} (${i.hint})` : i.name}
              checked={selected.has(i.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(i.id);
                else next.delete(i.id);
                set(next);
              }}
            />
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** What a Hudu import brings in: kinds of data, companies, and asset layouts. */
export function HuduImportChoices({
  preview,
  value,
  onChange,
}: {
  preview: HuduPreview;
  value: HuduImportOptions;
  onChange: (next: HuduImportOptions) => void;
}) {
  const layouts = useMemo(
    () =>
      preview.layoutList.map((l) => ({
        id: l.id,
        name: l.name,
        hint: `${l.assets} asset${l.assets === 1 ? '' : 's'}`,
      })),
    [preview.layoutList],
  );
  const nothing = !KINDS.some(([k]) => value[k]);
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">What to import</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {KINDS.map(([key, label, help]) => (
            <Checkbox
              key={key}
              label={label}
              description={help}
              checked={value[key]}
              onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
            />
          ))}
        </div>
        {nothing && <p className="text-sm text-warning">Choose at least one kind of data to import.</p>}
      </fieldset>
      <div className="grid gap-4 lg:grid-cols-2">
        <PickList
          label="Companies"
          items={preview.companyList}
          chosen={value.companyIds}
          onChange={(companyIds) => onChange({ ...value, companyIds })}
        />
        {value.assets && (
          <PickList
            label="Asset layouts"
            items={layouts}
            chosen={value.layoutIds}
            onChange={(layoutIds) => onChange({ ...value, layoutIds })}
          />
        )}
      </div>
    </div>
  );
}
