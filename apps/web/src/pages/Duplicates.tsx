import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, Merge } from 'lucide-react';
import { DUPLICATE_TYPES, type DuplicateGroup, type DuplicateType, type MergeResult } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  FormError,
  PageHeader,
  Select,
  Skeleton,
  useToast,
} from '@/components/ui';
import { AppLink } from '@/components/AppLink';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const TYPE_LABELS: Record<DuplicateType, string> = {
  assets: 'Assets',
  clients: 'Clients',
  contacts: 'Contacts',
  locations: 'Locations',
};
const WHAT_HAPPENS: Record<DuplicateType, string> = {
  assets:
    'Blank fields are filled from the others; values its layout has no field for get a new field. Links, files, and Hudu/ConnectWise IDs move to it. The others are archived (they can be restored).',
  clients:
    'Everything in the others (contacts, locations, assets, documents, passwords, files, access) moves to it, and the emptied clients are removed.',
  contacts: 'Blank details are filled from the others, notes joined, and links moved. The others are removed.',
  locations: 'Blank details are filled from the others, notes joined, and links moved. The others are removed.',
};
const hrefFor = (type: DuplicateType, id: string, clientId: string | null) =>
  type === 'assets'
    ? `/assets/${id}`
    : type === 'clients'
      ? `/clients/${id}`
      : `/clients/${clientId}/${type === 'contacts' ? 'contacts' : 'locations'}`;

/** One group: choose the record to keep, merge the rest into it. */
function GroupCard({ group, onMerged }: { group: DuplicateGroup; onMerged: () => void }) {
  const toast = useToast();
  // Suggest the fullest record, then the oldest.
  const suggested = [...group.items].sort((a, b) => b.filled - a.filled || a.createdAt.localeCompare(b.createdAt))[0]!;
  const [keepId, setKeepId] = useState(suggested.id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keep = group.items.find((i) => i.id === keepId)!;
  const merge = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<MergeResult>('/duplicates/merge', {
        method: 'POST',
        body: { type: group.type, keepId, mergeIds: group.items.filter((i) => i.id !== keepId).map((i) => i.id) },
      });
      toast(
        `Merged into ${keep.name}.${result.fieldsAdded.length ? ` Fields added: ${result.fieldsAdded.join(', ')}.` : ''}`,
      );
      onMerged();
    } catch (err) {
      setError((err as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{TYPE_LABELS[group.type]}</Badge>
        <p className="font-semibold">{group.name}</p>
        {group.clientName && <span className="text-sm text-muted">· {group.clientName}</span>}
        <span className="ml-auto text-xs text-muted">{group.items.length} records</span>
      </div>
      <fieldset>
        <legend className="sr-only">Record to keep for {group.name}</legend>
        <ul className="divide-y divide-border rounded-lg border border-border">
          {group.items.map((item) => (
            <li key={item.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-surface-2">
                <input
                  type="radio"
                  name={`keep-${group.type}-${group.name}-${group.clientId}`}
                  className="size-4 accent-(--primary)"
                  checked={keepId === item.id}
                  onChange={() => {
                    setKeepId(item.id);
                    setConfirming(false);
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {item.detail} · {item.filled} filled · updated {formatDateTime(item.updatedAt)}
                  </span>
                </span>
                {keepId === item.id ? (
                  <Badge tone="success">Keep</Badge>
                ) : (
                  <span className="text-xs text-muted">Merge in</span>
                )}
                <AppLink
                  to={hrefFor(group.type, item.id, group.clientId)}
                  className="text-xs font-medium text-primary hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  Open
                </AppLink>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="text-xs text-muted">{WHAT_HAPPENS[group.type]}</p>
      <div className="flex flex-wrap items-center gap-2">
        {!confirming ? (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            <Merge /> Merge into “{keep.name}”…
          </Button>
        ) : (
          <>
            <Button onClick={() => void merge()} loading={busy}>
              <Merge /> Merge {group.items.length - 1} into “{keep.name}” ({keep.detail})
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </>
        )}
      </div>
      <FormError message={error} />
    </li>
  );
}

/** Likely duplicates, grouped by name, with a merge that keeps every value. */
export function Duplicates() {
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ['duplicates'], queryFn: () => api<DuplicateGroup[]>('/duplicates') });
  const [type, setType] = useState<DuplicateType | ''>('');
  const counts = useMemo(() => {
    const c = new Map<DuplicateType, number>();
    for (const g of groups.data ?? []) c.set(g.type, (c.get(g.type) ?? 0) + 1);
    return c;
  }, [groups.data]);
  const shown = (groups.data ?? []).filter((g) => !type || g.type === type);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['duplicates'] });
    void queryClient.invalidateQueries({ queryKey: ['assets'] });
    void queryClient.invalidateQueries({ queryKey: ['clients'] });
  };
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Duplicates"
        description="Records with the same name in the same client, often from importing twice or from Hudu and ConnectWise RMM both. Choose the one to keep; the rest are merged into it."
      />
      <Card className="max-w-4xl">
        <CardHeader
          title={
            groups.data ? `${groups.data.length} possible duplicate${groups.data.length === 1 ? '' : 's'}` : 'Looking…'
          }
          actions={
            <label>
              <span className="sr-only">Show</span>
              <Select
                value={type}
                onChange={(e) => setType(e.target.value as DuplicateType | '')}
                className="h-8 w-auto"
              >
                <option value="">All types</option>
                {DUPLICATE_TYPES.filter((t) => counts.has(t)).map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]} ({counts.get(t)})
                  </option>
                ))}
              </Select>
            </label>
          }
        />
        {groups.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-24" />
            <Skeleton className="h-24" />
          </div>
        ) : shown.length ? (
          <ul className="divide-y divide-border">
            {shown.map((g) => (
              <GroupCard
                key={`${g.type}|${g.clientId}|${g.name}|${g.items.map((i) => i.id).join()}`}
                group={g}
                onMerged={refresh}
              />
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={groups.data?.length ? Copy : CheckCircle2}
            title="No duplicates found"
            description="Nothing shares a name within a client."
          />
        )}
      </Card>
    </>
  );
}
