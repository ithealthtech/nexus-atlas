import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CwRmmCompany } from '@atlas/shared';
import { Button, FormError, Input, Select, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useClients } from '@/lib/queries';

/** What the admin picked for one company in the mapping table. '' leaves it undecided. */
type Choice = '' | 'skip' | 'create' | `client:${string}`;

const choiceOf = (c: CwRmmCompany): Choice =>
  c.action === 'skip' ? 'skip' : c.action === 'link' && c.clientId ? `client:${c.clientId}` : '';

/**
 * An integration's companies (ConnectWise RMM, Bitdefender GravityZone) and the Atlas client each syncs into.
 * `path` serves GET (the list) and PUT (decisions); `queryKey` is refetched by the connection card.
 */
export function CompanyMapping({ path, queryKey, product }: { path: string; queryKey: string; product: string }) {
  const toast = useToast();
  const clients = useClients();
  const companies = useQuery({
    queryKey: [queryKey],
    queryFn: () => api<CwRmmCompany[]>(path),
  });
  // Only what the admin changed is kept; everything else shows the saved choice.
  const [edits, setEdits] = useState<Record<string, Choice>>({});
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Undecided companies start on the suggested same-name client.
  const choices = useMemo(
    () =>
      Object.fromEntries(
        (companies.data ?? []).map((c) => [
          c.id,
          edits[c.id] ??
            (c.action ? choiceOf(c) : c.suggestedClientId ? (`client:${c.suggestedClientId}` as Choice) : ''),
        ]),
      ) as Record<string, Choice>,
    [companies.data, edits],
  );
  const setChoices = (update: (prev: Record<string, Choice>) => Record<string, Choice>) => setEdits(update(choices));
  const changed = useMemo(
    () => (companies.data ?? []).filter((c) => (choices[c.id] ?? '') !== choiceOf(c)),
    [companies.data, choices],
  );
  const shown = (companies.data ?? []).filter((c) => c.name.toLowerCase().includes(filter.trim().toLowerCase()));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(path, {
        method: 'PUT',
        body: {
          mappings: changed.map((c) => {
            const choice = choices[c.id] ?? '';
            return choice.startsWith('client:')
              ? { companyId: c.id, action: 'link', clientId: choice.slice(7) }
              : { companyId: c.id, action: choice || 'clear' };
          }),
        },
      });
      await companies.refetch();
      setEdits({});
      toast('Company links saved.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (companies.isLoading) return <Skeleton className="h-40" />;
  if (companies.error) return <FormError message={(companies.error as Error).message} />;
  const linked = (companies.data ?? []).filter((c) => c.action === 'link').length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto text-sm font-semibold">
          Companies{' '}
          <span className="font-normal text-muted">
            · {linked} linked of {companies.data?.length ?? 0}
          </span>
        </p>
        <label className="w-full sm:w-56">
          <span className="sr-only">Filter companies</span>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter companies…" />
        </label>
      </div>
      <div className="max-h-96 overflow-y-auto rounded-xl border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-surface-2 text-xs text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">{product} company</th>
              <th className="px-4 py-2.5 font-medium">Atlas client</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-2.5 font-medium">{c.name}</td>
                <td className="px-4 py-2">
                  <label>
                    <span className="sr-only">Atlas client for {c.name}</span>
                    <Select
                      value={choices[c.id] ?? ''}
                      onChange={(e) => setChoices((prev) => ({ ...prev, [c.id]: e.target.value as Choice }))}
                      className="h-8"
                    >
                      <option value="">Not decided (not synced)</option>
                      <option value="create">Create a new client</option>
                      <option value="skip">Don&rsquo;t sync</option>
                      <optgroup label="Link to">
                        {(clients.data ?? []).map((cl) => (
                          <option key={cl.id} value={`client:${cl.id}`}>
                            {cl.name}
                          </option>
                        ))}
                      </optgroup>
                    </Select>
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} loading={busy} disabled={!changed.length}>
          Save {changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'}` : 'links'}
        </Button>
        <p className="text-xs text-muted">Same-name clients are suggested. Nothing syncs until a company is linked.</p>
      </div>
      <FormError message={error} />
    </div>
  );
}
