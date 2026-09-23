import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Building2, Plus, Search } from 'lucide-react';
import { LEVEL_INFO, type ClientSummary } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  useToast,
  type Tone,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { useClients, useSave } from '@/lib/queries';
import { relativeTime } from '@/lib/format';

export const statusTone: Record<ClientSummary['status'], Tone> = {
  active: 'success',
  prospect: 'info',
  inactive: 'neutral',
};
export const accessTone = (level: string): Tone =>
  level === 'edit_passwords' ? 'primary' : level === 'edit' ? 'info' : 'neutral';

export function ClientForm({ client, open, onClose }: { client?: ClientSummary; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiError | null>(null);
  const save = useSave(
    (body: Record<string, string>) =>
      api<ClientSummary>(client ? `/clients/${client.id}` : '/clients', { method: client ? 'PATCH' : 'POST', body }),
    [['clients']],
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      const saved = await save.mutateAsync(Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
      toast(client ? 'Client updated.' : `${saved.name} added.`);
      onClose();
      if (!client) navigate({ to: '/clients/$clientId', params: { clientId: saved.id } });
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={client ? 'Edit client' : 'Add a client'}
      description={client ? undefined : 'Each client gets its own workspace for assets, documentation, and passwords.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="client-form" loading={save.isPending}>
            {client ? 'Save changes' : 'Create client'}
          </Button>
        </>
      }
    >
      <form id="client-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Client name" error={error?.fields?.name}>
          {(p) => (
            <Input
              {...p}
              name="name"
              defaultValue={client?.name}
              required
              maxLength={200}
              autoFocus
              placeholder="e.g. Harbor Dental Group"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type">
            {(p) => (
              <Input {...p} name="type" defaultValue={client?.type ?? 'Customer'} maxLength={80} list="client-types" />
            )}
          </Field>
          <datalist id="client-types">
            {['Customer', 'Internal', 'Vendor', 'Partner'].map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <Field label="Status">
            {(p) => (
              <Select {...p} name="status" defaultValue={client?.status ?? 'active'}>
                <option value="active">Active</option>
                <option value="prospect">Prospect</option>
                <option value="inactive">Inactive</option>
              </Select>
            )}
          </Field>
        </div>
        <Field
          label="Quick notes"
          help="Shown at the top of the client. Don't put passwords here."
          error={error?.fields?.notes}
        >
          {(p) => <Textarea {...p} name="notes" defaultValue={client?.notes} maxLength={5000} rows={4} />}
        </Field>
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Dialog>
  );
}

export function Clients() {
  const actor = useActor();
  const { data, isLoading } = useClients();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | ClientSummary['status']>('all');
  const [adding, setAdding] = useState(false);
  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (c) =>
          (status === 'all' || c.status === status) &&
          `${c.name} ${c.type}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [data, query, status],
  );
  return (
    <>
      <PageHeader
        eyebrow="Clients"
        title="Client workspaces"
        description="Every environment you support, organized and easy to find."
        actions={
          actor.canEditAll && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add client
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-4">
          <label className="relative min-w-56 flex-1">
            <span className="sr-only">Search clients</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search clients…"
              className="pl-9"
            />
          </label>
          <div role="group" aria-label="Filter by status" className="flex gap-1 rounded-lg bg-surface-3 p-1">
            {(['all', 'active', 'prospect', 'inactive'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                aria-pressed={status === s}
                className="rounded-md px-3 py-1.5 text-[13px] font-medium text-text-2 capitalize aria-pressed:bg-surface aria-pressed:text-text aria-pressed:shadow-sm"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title={data?.length ? 'No clients match' : 'No clients yet'}
            description={
              data?.length
                ? 'Try a different search or filter.'
                : actor.canEditAll
                  ? 'Add your first client to start documenting.'
                  : 'Ask an administrator to give you access to a client.'
            }
            action={
              !data?.length &&
              actor.canEditAll && (
                <Button onClick={() => setAdding(true)}>
                  <Plus /> Add client
                </Button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Client</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="hidden px-5 py-3 font-medium sm:table-cell">Your access</th>
                  <th className="hidden px-5 py-3 font-medium md:table-cell">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-surface-2">
                    <td className="px-5 py-3.5">
                      <Link to="/clients/$clientId" params={{ clientId: c.id }} className="flex items-center gap-3">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-soft text-xs font-bold text-primary">
                          {c.name.slice(0, 2).toUpperCase()}
                        </span>
                        <span>
                          <span className="block font-semibold text-text hover:underline">{c.name}</span>
                          <span className="block text-xs text-muted">{c.type}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge tone={statusTone[c.status]} className="capitalize">
                        {c.status}
                      </Badge>
                    </td>
                    <td className="hidden px-5 py-3.5 sm:table-cell">
                      <Badge tone={accessTone(c.access)}>{LEVEL_INFO[c.access].label}</Badge>
                    </td>
                    <td className="hidden px-5 py-3.5 whitespace-nowrap text-muted md:table-cell">
                      {relativeTime(c.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <ClientForm open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
