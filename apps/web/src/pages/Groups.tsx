import { useMemo, useState, type FormEvent } from 'react';
import { Plus, Trash2, UsersRound } from 'lucide-react';
import { ACCESS_LEVELS, LEVEL_INFO, ROLE_INFO, type AccessLevel, type GroupView } from '@atlas/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormError,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Dialog,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useClients, useGroups, useSave, useUsers } from '@/lib/queries';

function GroupDialog({ group, onClose }: { group?: GroupView; onClose: () => void }) {
  const toast = useToast();
  const users = useUsers();
  const clients = useClients();
  const staff = (users.data ?? []).filter((u) => ROLE_INFO[u.role].staff && !ROLE_INFO[u.role].admin);
  const [members, setMembers] = useState(() => new Set(group?.memberIds ?? []));
  const [grants, setGrants] = useState<Record<string, AccessLevel>>(() =>
    Object.fromEntries((group?.grants ?? []).map((g) => [g.clientId, g.level])),
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSave(
    (body: object) =>
      api<GroupView>(group ? `/groups/${group.id}` : '/groups', { method: group ? 'PUT' : 'POST', body }),
    [['groups'], ['clients'], ['security-events']],
  );
  const remove = useSave(() => api(`/groups/${group!.id}`, { method: 'DELETE' }), [['groups'], ['clients']]);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    try {
      await save.mutateAsync({
        name: form.get('name'),
        description: form.get('description'),
        memberIds: [...members],
        grants: Object.entries(grants)
          .filter(([, level]) => level !== 'none')
          .map(([clientId, level]) => ({ clientId, level })),
      });
      toast(group ? 'Group saved. Access changes apply right away.' : 'Group created.');
      onClose();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={group ? `Edit ${group.name}` : 'New group'}
      description="Members get this access on top of their own. Each person's role still caps what they can do."
      footer={
        <>
          {group &&
            (confirmDelete ? (
              <Button
                variant="danger"
                className="mr-auto"
                loading={remove.isPending}
                onClick={async () => {
                  await remove.mutateAsync(undefined);
                  toast('Group deleted.');
                  onClose();
                }}
              >
                Confirm delete
              </Button>
            ) : (
              <Button variant="ghost" className="mr-auto" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete group
              </Button>
            ))}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="group-form" loading={save.isPending}>
            {group ? 'Save group' : 'Create group'}
          </Button>
        </>
      }
    >
      <form id="group-form" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={error?.fields?.name}>
            {(p) => <Input {...p} name="name" defaultValue={group?.name} required maxLength={80} autoFocus />}
          </Field>
          <Field label="Description" help="Optional">
            {(p) => <Input {...p} name="description" defaultValue={group?.description} maxLength={300} />}
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">Members</legend>
          <div className="max-h-56 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {users.isLoading && <Skeleton className="m-3 h-8" />}
            {!users.isLoading && !staff.length && (
              <p className="p-4 text-sm text-muted">
                Add technicians on the People &amp; access page first. Administrators already have full access.
              </p>
            )}
            {staff.map((u) => (
              <label key={u.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-surface-2">
                <input
                  type="checkbox"
                  className="size-4 accent-(--primary)"
                  checked={members.has(u.id)}
                  onChange={(e) =>
                    setMembers((m) => {
                      const next = new Set(m);
                      if (e.target.checked) next.add(u.id);
                      else next.delete(u.id);
                      return next;
                    })
                  }
                />
                <Avatar name={u.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{u.name}</span>
                  <span className="block truncate text-xs text-muted">{ROLE_INFO[u.role].label}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">Client access</legend>
          <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
            {clients.data?.length === 0 && <p className="p-4 text-sm text-muted">No clients yet.</p>}
            {clients.data?.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="truncate text-sm">{c.name}</span>
                <Select
                  aria-label={`Group access to ${c.name}`}
                  className="h-8 w-44 text-[13px]"
                  value={grants[c.id] ?? 'none'}
                  onChange={(e) => setGrants((g) => ({ ...g, [c.id]: e.target.value as AccessLevel }))}
                >
                  {ACCESS_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {LEVEL_INFO[l].label}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        </fieldset>
        <FormError message={error && !error.fields?.name ? error.message : null} />
      </form>
    </Dialog>
  );
}

export function Groups() {
  const groups = useGroups();
  const users = useUsers();
  const clients = useClients();
  const [editing, setEditing] = useState<GroupView | null>(null);
  const [adding, setAdding] = useState(false);
  const userNames = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u.name])), [users.data]);
  const clientNames = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Groups"
        description="Give a team access to a set of clients in one place, and restrict passwords to a group."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> New group
          </Button>
        }
      />
      <Card>
        {groups.isLoading ? (
          <div className="space-y-3 p-5">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : !groups.data?.length ? (
          <EmptyState
            icon={UsersRound}
            title="No groups yet"
            description="For example, a Tier 1 group with read access to every client, or a team that looks after a few clients."
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus /> New group
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {groups.data.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <span className="grid size-10 place-items-center rounded-lg bg-primary-soft text-primary">
                  <UsersRound className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{g.name}</p>
                  <p className="truncate text-sm text-muted">
                    {g.description ||
                      (g.memberIds.length
                        ? g.memberIds
                            .map((id) => userNames.get(id))
                            .filter(Boolean)
                            .join(', ')
                        : 'No members')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Badge>
                    {g.memberIds.length} member{g.memberIds.length === 1 ? '' : 's'}
                  </Badge>
                  <Badge tone="primary">
                    {g.grants.length === 1
                      ? `${clientNames.get(g.grants[0]!.clientId) ?? '1 client'} · ${LEVEL_INFO[g.grants[0]!.level].label}`
                      : `${g.grants.length} clients`}
                  </Badge>
                </div>
                <Button variant="secondary" size="sm" onClick={() => setEditing(g)}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <GroupDialog onClose={() => setAdding(false)} />}
      {editing && <GroupDialog key={editing.id} group={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
