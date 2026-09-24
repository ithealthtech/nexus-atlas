import { useMemo, useState, type FormEvent } from 'react';
import { KeyRound, LogOut, Plus, RefreshCw, ShieldCheck, UserPlus, Users as UsersIcon } from 'lucide-react';
import {
  ACCESS_LEVELS,
  LEVEL_INFO,
  ROLES,
  ROLE_INFO,
  levelRank,
  type AccessLevel,
  type Role,
  type UserView,
} from '@atlas/shared';
import {
  Avatar,
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
import { ApiError, api } from '@/lib/api';
import { useActor } from '@/lib/session';
import { generatePassphrase, useClients, useSave, useUsers } from '@/lib/queries';
import { formatDate } from '@/lib/format';
import { accessTone } from './Clients';

function accessSummary(user: UserView, clientNames: Map<string, string>) {
  if (ROLE_INFO[user.role].admin) return 'Everything';
  const parts: string[] = [];
  if (user.allClients !== 'none') parts.push(`All clients · ${LEVEL_INFO[user.allClients].label}`);
  const specific = user.grants.filter((g) => levelRank(g.level) > levelRank(user.allClients));
  if (specific.length === 1)
    parts.push(`${clientNames.get(specific[0]!.clientId) ?? 'One client'} · ${LEVEL_INFO[specific[0]!.level].label}`);
  else if (specific.length > 1) parts.push(`${specific.length} specific clients`);
  return parts.join(' + ') || 'No clients';
}

function TempPassword({ name = 'password' }: { name?: string }) {
  const [value, setValue] = useState(generatePassphrase);
  return (
    <Field label="Temporary password" help="Share it privately. They'll choose their own password at first sign-in.">
      {(p) => (
        <div className="flex gap-2">
          <Input
            {...p}
            name={name}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="font-mono"
            autoComplete="off"
            minLength={12}
            required
          />
          <Button
            variant="secondary"
            size="icon"
            onClick={() => setValue(generatePassphrase())}
            aria-label="Generate another password"
          >
            <RefreshCw />
          </Button>
        </div>
      )}
    </Field>
  );
}

function UserDialog({ user, open, onClose }: { user?: UserView; open: boolean; onClose: () => void }) {
  const actor = useActor();
  const toast = useToast();
  const clients = useClients();
  const [role, setRole] = useState<Role>(user?.role ?? 'technician');
  const [allClients, setAllClients] = useState<AccessLevel>(user?.allClients ?? 'none');
  const [grants, setGrants] = useState<Record<string, AccessLevel>>(() =>
    Object.fromEntries((user?.grants ?? []).map((g) => [g.clientId, g.level])),
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [resetting, setResetting] = useState(false);
  const info = ROLE_INFO[role];
  const levels = ACCESS_LEVELS.filter((l) => levelRank(l) <= levelRank(info.cap));
  const roles = ROLES.filter((r) => r !== 'owner' || actor.role === 'owner');
  const save = useSave(
    (body: object) => api<UserView>(user ? `/users/${user.id}` : '/users', { method: user ? 'PATCH' : 'POST', body }),
    [['users'], ['security-events']],
  );

  const changeRole = (next: Role) => {
    setRole(next);
    const cap = ROLE_INFO[next].cap;
    const clamp = (l: AccessLevel) => (levelRank(l) > levelRank(cap) ? cap : l);
    setAllClients((l) => (ROLE_INFO[next].staff ? clamp(l) : 'none'));
    setGrants((g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, clamp(v)])));
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const form = new FormData(e.currentTarget);
    const body = {
      name: form.get('name'),
      role,
      allClients: info.admin ? 'none' : allClients,
      grants: info.admin
        ? []
        : Object.entries(grants)
            .filter(([, level]) => level !== 'none')
            .map(([clientId, level]) => ({ clientId, level })),
      ...(user
        ? { disabled: form.get('disabled') === 'on' }
        : { email: form.get('email'), password: form.get('password') }),
    };
    try {
      await save.mutateAsync(body);
      toast(
        user ? 'Changes saved. They apply right away.' : 'Account created. Share the temporary password privately.',
      );
      onClose();
    } catch (err) {
      setError(err as ApiError);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={user ? `Manage ${user.name}` : 'Add a person'}
      description={user ? user.email : 'Give a teammate or client contact their own sign-in.'}
      footer={
        <>
          {user && user.id !== actor.id && (
            <div className="mr-auto flex flex-wrap gap-1">
              <Button variant="ghost" onClick={() => setResetting(true)}>
                <KeyRound /> Reset sign-in
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await api(`/users/${user.id}/sign-out`, { method: 'POST', body: {} });
                    toast(`${user.name} was signed out everywhere.`);
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  }
                }}
              >
                <LogOut /> Sign out everywhere
              </Button>
            </div>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="user-form" loading={save.isPending}>
            {user ? 'Save changes' : 'Create account'}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={error?.fields?.name}>
            {(p) => <Input {...p} name="name" defaultValue={user?.name} required maxLength={120} autoFocus />}
          </Field>
          {!user && (
            <Field label="Email" error={error?.fields?.email}>
              {(p) => <Input {...p} name="email" type="email" required autoComplete="off" />}
            </Field>
          )}
        </div>
        <fieldset>
          <legend className="mb-2 text-[13px] font-semibold">Role</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <label
                key={r}
                className="flex cursor-pointer gap-3 rounded-lg border border-border p-3 has-checked:border-primary has-checked:bg-primary-soft/60"
              >
                <input
                  type="radio"
                  name="role-choice"
                  value={r}
                  checked={role === r}
                  onChange={() => changeRole(r)}
                  className="mt-1 accent-(--primary)"
                  disabled={user?.id === actor.id}
                />
                <span>
                  <span className="block text-sm font-semibold">{ROLE_INFO[r].label}</span>
                  <span className="block text-xs text-muted">{ROLE_INFO[r].description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {info.admin ? (
          <div className="flex gap-3 rounded-lg bg-primary-soft/70 p-3.5 text-sm text-text-2">
            <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden /> {info.label}s can open every client and
            password, and manage people and settings.
          </div>
        ) : (
          <fieldset className="space-y-3">
            <legend className="text-[13px] font-semibold">Client access</legend>
            {info.staff && (
              <Field
                label="Every client (including new ones)"
                help="Specific clients below can be given more than this."
              >
                {(p) => (
                  <Select {...p} value={allClients} onChange={(e) => setAllClients(e.target.value as AccessLevel)}>
                    {levels.map((l) => (
                      <option key={l} value={l}>
                        {LEVEL_INFO[l].label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <div className="overflow-hidden rounded-lg border border-border">
              <div className="max-h-64 divide-y divide-border overflow-y-auto">
                {clients.isLoading && <Skeleton className="m-3 h-8" />}
                {clients.data?.length === 0 && (
                  <p className="p-4 text-sm text-muted">Add a client first, then give people access to it.</p>
                )}
                {clients.data?.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="truncate text-sm">{c.name}</span>
                    <Select
                      aria-label={`Access to ${c.name}`}
                      className="h-8 w-44 text-[13px]"
                      value={grants[c.id] ?? 'none'}
                      onChange={(e) => setGrants((g) => ({ ...g, [c.id]: e.target.value as AccessLevel }))}
                    >
                      {levels.map((l) => (
                        <option key={l} value={l}>
                          {l === 'none' && allClients !== 'none'
                            ? `Default (${LEVEL_INFO[allClients].label})`
                            : LEVEL_INFO[l].label}
                        </option>
                      ))}
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          </fieldset>
        )}
        {!user && <TempPassword />}
        {user && user.id !== actor.id && (
          <Checkbox
            name="disabled"
            defaultChecked={user.disabled}
            label="Disable this account"
            description="They're signed out everywhere and can't sign in until re-enabled."
          />
        )}
        <FormError
          message={
            error && (!error.fields || !Object.keys(error.fields).some((k) => k === 'name' || k === 'email'))
              ? error.message
              : null
          }
        />
      </form>
      {user && <ResetDialog user={user} open={resetting} onClose={() => setResetting(false)} />}
    </Dialog>
  );
}

function ResetDialog({ user, open, onClose }: { user: UserView; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (body: object) => api<UserView>(`/users/${user.id}/reset`, { method: 'POST', body }),
    [['users'], ['security-events']],
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await save.mutateAsync({ password: form.get('password'), resetMfa: form.get('resetMfa') === 'on' });
      toast(`${user.name} was signed out and must choose a new password.`);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title={`Reset ${user.name}'s sign-in`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="reset-form" variant="danger" loading={save.isPending}>
            Reset sign-in
          </Button>
        </>
      }
    >
      <form id="reset-form" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">They'll be signed out everywhere and must choose a new password next time.</p>
        <TempPassword />
        <Checkbox
          name="resetMfa"
          label="Also reset two-step verification"
          description="Use this when they've lost their authenticator app."
        />
        <FormError message={error} />
      </form>
    </Dialog>
  );
}

export function Users() {
  const users = useUsers();
  const clients = useClients();
  const [editing, setEditing] = useState<UserView | null>(null);
  const [adding, setAdding] = useState(false);
  const names = useMemo(() => new Map((clients.data ?? []).map((c) => [c.id, c.name])), [clients.data]);
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="People & access"
        description="Decide who can see each client, and who can change it. Changes apply immediately."
        actions={
          <Button onClick={() => setAdding(true)}>
            <UserPlus /> Add person
          </Button>
        }
      />
      <Card>
        {users.isLoading ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : !users.data?.length ? (
          <EmptyState
            icon={UsersIcon}
            title="No people yet"
            description="Add your team and client contacts."
            action={
              <Button onClick={() => setAdding(true)}>
                <Plus /> Add person
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-surface-2 text-xs text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">Person</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Access</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 font-medium">Last sign-in</th>
                  <th className="px-5 py-3">
                    <span className="sr-only">Manage</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {users.data.map((u) => (
                  <tr key={u.id} className="hover:bg-surface-2">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <Avatar name={u.name} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{u.name}</p>
                          <p className="truncate text-xs text-muted">{u.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap">{ROLE_INFO[u.role].label}</td>
                    <td className="max-w-64 px-5 py-3.5 text-text-2">
                      <Badge tone={accessTone(ROLE_INFO[u.role].admin ? 'edit_passwords' : u.allClients)}>
                        {accessSummary(u, names)}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {u.disabled ? (
                          <Badge>Disabled</Badge>
                        ) : u.locked ? (
                          <Badge tone="danger">Locked</Badge>
                        ) : u.mustChangePassword ? (
                          <Badge tone="warning">Invited</Badge>
                        ) : (
                          <Badge tone="success">Active</Badge>
                        )}
                        {u.mfa && (
                          <Badge tone="primary">
                            <ShieldCheck /> 2FA
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-muted">{formatDate(u.lastLoginAt)}</td>
                    <td className="px-5 py-3.5 text-right">
                      <Button variant="secondary" size="sm" onClick={() => setEditing(u)}>
                        Manage
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {adding && <UserDialog open onClose={() => setAdding(false)} />}
      {editing && <UserDialog key={editing.id} user={editing} open onClose={() => setEditing(null)} />}
    </>
  );
}
