import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, LayoutTemplate, Plus, Trash2 } from 'lucide-react';
import { FIELD_TYPES, FIELD_TYPE_LABELS, type FieldType, type LayoutField, type LayoutView } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { ItemIcon, LAYOUT_ICONS } from '@/components/ItemIcon';
import { ApiError, api } from '@/lib/api';
import { useLayouts } from '@/lib/queries';

const toKey = (label: string, taken: Set<string>) => {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'f_$1')
      .slice(0, 36) || 'field';
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
};

function LayoutEditor({ layout, onClose }: { layout?: LayoutView; onClose: () => void }) {
  const [name, setName] = useState(layout?.name ?? '');
  const [icon, setIcon] = useState(layout?.icon ?? 'box');
  const [description, setDescription] = useState(layout?.description ?? '');
  // Existing field keys stay fixed so stored values keep matching; new fields get keys from their labels.
  const [fields, setFields] = useState<(LayoutField & { isNew?: boolean })[]>(layout?.fields ?? []);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  const update = (i: number, patch: Partial<LayoutField>) =>
    setFields((all) => all.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) =>
    setFields((all) => {
      const next = [...all];
      const [f] = next.splice(i, 1);
      next.splice(i + by, 0, f!);
      return next;
    });
  const save = async () => {
    setBusy(true);
    setError(null);
    const taken = new Set(fields.filter((f) => !f.isNew).map((f) => f.key));
    const cleaned = fields.map(({ isNew, ...f }) => {
      if (!isNew) return f;
      const key = toKey(f.label, taken);
      taken.add(key);
      return { ...f, key };
    });
    try {
      await api(layout ? `/layouts/${layout.id}` : '/layouts', {
        method: layout ? 'PATCH' : 'POST',
        body: { name, icon, description, fields: cleaned },
      });
      await queryClient.invalidateQueries({ queryKey: ['layouts'] });
      toast(layout ? 'Layout saved.' : 'Layout created.');
      onClose();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={layout ? `Edit ${layout.name}` : 'New asset layout'}
      description="Fields appear on the asset form in this order. Removing a field hides its stored values."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!name.trim()}>
            Save layout
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
          <Field label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
                placeholder="e.g. Door access systems"
              />
            )}
          </Field>
          <Field label="Icon">
            {(p) => (
              <Select {...p} value={icon} onChange={(e) => setIcon(e.target.value)}>
                {Object.keys(LAYOUT_ICONS).map((k) => (
                  <option key={k} value={k}>
                    {k.replace(/-/g, ' ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Description">
          {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />}
        </Field>
        <fieldset className="space-y-3">
          <legend className="mb-1 text-[13px] font-semibold">Fields</legend>
          {fields.map((f, i) => (
            <div key={i} className="rounded-xl border border-border p-3">
              <div className="grid gap-3 sm:grid-cols-[1fr_170px_auto]">
                <Input
                  aria-label={`Field ${i + 1} label`}
                  value={f.label}
                  onChange={(e) => update(i, { label: e.target.value })}
                  placeholder="Label"
                  maxLength={80}
                />
                <Select
                  aria-label={`Field ${i + 1} type`}
                  value={f.type}
                  onChange={(e) => update(i, { type: e.target.value as FieldType })}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FIELD_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Move down"
                    disabled={i === fields.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${f.label || 'field'}`}
                    onClick={() => setFields((all) => all.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
              {(f.type === 'select' || f.type === 'multiselect') && (
                <Input
                  className="mt-2"
                  aria-label={`Field ${i + 1} options`}
                  value={f.options.join(', ')}
                  onChange={(e) =>
                    update(i, {
                      options: e.target.value
                        .split(',')
                        .map((o) => o.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="Options, separated by commas"
                />
              )}
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                <Checkbox
                  label="Required"
                  checked={f.required}
                  onChange={(e) => update(i, { required: e.target.checked })}
                />
                <Checkbox
                  label="Show in lists"
                  checked={f.showInList}
                  onChange={(e) => update(i, { showInList: e.target.checked })}
                />
                {f.type === 'date' && (
                  <Checkbox
                    label="Expiry date"
                    checked={f.expires}
                    onChange={(e) => update(i, { expires: e.target.checked })}
                  />
                )}
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setFields((all) => [
                ...all,
                {
                  key: '',
                  label: '',
                  type: 'text',
                  required: false,
                  options: [],
                  help: '',
                  showInList: false,
                  expires: false,
                  isNew: true,
                },
              ])
            }
          >
            <Plus /> Add field
          </Button>
        </fieldset>
        <FormError message={error?.message ?? null} />
      </div>
    </Dialog>
  );
}

export function Layouts() {
  const { data, isLoading } = useLayouts();
  const [editing, setEditing] = useState<LayoutView | 'new' | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const setArchived = async (l: LayoutView, archived: boolean) => {
    await api(`/layouts/${l.id}`, { method: 'PATCH', body: { archived } });
    await queryClient.invalidateQueries({ queryKey: ['layouts'] });
    toast(archived ? `${l.name} archived. Existing assets keep working.` : `${l.name} restored.`);
  };
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Asset layouts"
        description="Templates that decide which fields each kind of asset has. Changes apply to every client."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> New layout
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton className="h-40" />
      ) : !data?.length ? (
        <Card>
          <EmptyState icon={LayoutTemplate} title="No layouts" description="Create one to start documenting assets." />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {data.map((l) => (
            <Card key={l.id} className={l.archived ? 'opacity-60' : undefined}>
              <div className="flex items-start gap-3 p-5">
                <ItemIcon type="asset" icon={l.icon} className="size-10 rounded-xl" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-semibold">
                    {l.name}
                    {l.builtIn && <Badge>Built-in</Badge>}
                    {l.archived && <Badge tone="warning">Archived</Badge>}
                  </p>
                  <p className="mt-0.5 text-sm text-muted">{l.description}</p>
                  <p className="mt-2 text-xs text-muted">
                    {l.fields.length} fields · {l.assetCount} assets
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
                <Button variant="ghost" size="sm" onClick={() => setArchived(l, !l.archived)}>
                  {l.archived ? <ArchiveRestore /> : <Archive />} {l.archived ? 'Restore' : 'Archive'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setEditing(l)}>
                  Edit fields
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <LayoutEditor
          key={editing === 'new' ? 'new' : editing.id}
          layout={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
