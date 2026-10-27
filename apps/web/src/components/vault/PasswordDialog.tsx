import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, HardDrive, KeyRound, Plus, RefreshCw, Search, X, StickyNote } from 'lucide-react';
import {
  PASSWORD_CATEGORIES,
  MAX_CUSTOM_FIELDS,
  MAX_NOTE_LENGTH,
  PASSWORD_CATEGORY_LABELS,
  type PasswordKind,
  type PasswordView,
  type RelationView,
} from '@atlas/shared';
import { Button, Checkbox, Field, FormError, Input, Select, Textarea, useToast, Drawer } from '@/components/ui';
import { useGo } from '@/components/AppLink';
import { ApiError, api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useActor } from '@/lib/session';
import { useAssets } from '@/lib/queries';
import { usePasswordFolders, useReveal } from '@/lib/vault';

import { StrengthMeter, Generator } from '@/components/vault/Generator';

// Adding and editing a password: the form, its custom fields and linked assets.
type EditableField = { key: string; id?: string; label: string; secret: boolean; value: string };

/** Extra labelled values: a tenant ID, a PIN, a recovery email. Hidden ones are encrypted like the password. */
function CustomFieldsEditor({
  fields,
  onChange,
  error,
}: {
  fields: EditableField[];
  onChange: (fields: EditableField[]) => void;
  error?: string;
}) {
  const set = (key: string, patch: Partial<EditableField>) =>
    onChange(fields.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Custom fields</legend>
      {fields.map((f, i) => (
        <div
          key={f.key}
          className="grid gap-2 rounded-lg border border-border p-2.5 sm:grid-cols-[10rem_minmax(0,1fr)_auto_auto] sm:items-center"
        >
          <Input
            aria-label={`Field ${i + 1} label`}
            value={f.label}
            onChange={(e) => set(f.key, { label: e.target.value })}
            placeholder="Label"
            maxLength={100}
          />
          <Input
            aria-label={`${f.label || `Field ${i + 1}`} value`}
            value={f.value}
            onChange={(e) => set(f.key, { value: e.target.value })}
            type={f.secret ? 'password' : 'text'}
            autoComplete="off"
            maxLength={5000}
            placeholder={f.id && f.secret ? 'Unchanged, type to replace' : 'Value'}
          />
          <label className="flex items-center gap-2 text-sm text-text-2">
            <input
              type="checkbox"
              className="size-4 rounded accent-(--primary)"
              checked={f.secret}
              onChange={(e) => set(f.key, { secret: e.target.checked })}
            />
            Hidden
          </label>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${f.label || `field ${i + 1}`}`}
            onClick={() => onChange(fields.filter((x) => x.key !== f.key))}
          >
            <X />
          </Button>
        </div>
      ))}
      {error && <p className="text-sm text-danger">{error}</p>}
      {fields.length < MAX_CUSTOM_FIELDS && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange([...fields, { key: crypto.randomUUID(), label: '', secret: false, value: '' }])}
        >
          <Plus /> Add a field
        </Button>
      )}
    </fieldset>
  );
}

/** Adds and removes asset links so they match `next`; returns a message if any link couldn't be changed. */
async function syncAssetLinks(passwordId: string, before: string[], next: string[]): Promise<string | null> {
  const add = next.filter((id) => !before.includes(id));
  const remove = before.filter((id) => !next.includes(id));
  if (!add.length && !remove.length) return null;
  const base = `/items/password/${passwordId}/relations`;
  const failed: string[] = [];
  for (const id of add)
    await api(base, { method: 'POST', body: { type: 'asset', id } }).catch((e: Error) => failed.push(e.message));
  if (remove.length) {
    const links = await api<RelationView[]>(base);
    for (const link of links.filter((l) => l.type === 'asset' && remove.includes(l.id)))
      await api(`${base}/${link.relationId}`, { method: 'DELETE' }).catch((e: Error) => failed.push(e.message));
  }
  return failed.length ? `Saved, but some asset links didn't change: ${[...new Set(failed)].join(' ')}` : null;
}

/** Pick the client's assets this password belongs to (a firewall, a server, a tenant…). */
function AssetLinksField({
  clientId,
  value,
  onChange,
}: {
  clientId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const assets = useAssets({ client: clientId });
  const [query, setQuery] = useState('');
  const all = assets.data ?? [];
  const chosen = value.map((id) => all.find((a) => a.id === id) ?? { id, name: 'Asset', layoutName: '' });
  const q = query.trim().toLowerCase();
  const matches = q
    ? all.filter((a) => !value.includes(a.id) && `${a.name} ${a.layoutName}`.toLowerCase().includes(q)).slice(0, 8)
    : [];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Linked assets</legend>
      {chosen.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Linked assets">
          {chosen.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-1 rounded-full bg-surface-3 py-0.5 pr-1 pl-2.5 text-xs font-medium"
            >
              {a.name}
              <button
                type="button"
                className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-text"
                aria-label={`Unlink ${a.name}`}
                onClick={() => onChange(value.filter((id) => id !== a.id))}
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="relative block">
        <span className="sr-only">Find an asset to link</span>
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={all.length ? 'Find an asset to link…' : 'This client has no assets yet'}
          disabled={!all.length}
          className="pl-9"
          autoComplete="off"
        />
      </label>
      {q && (
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-border" aria-label="Matching assets">
          {matches.length ? (
            matches.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2"
                  onClick={() => {
                    onChange([...value, a.id]);
                    setQuery('');
                  }}
                >
                  <span className="truncate font-medium">{a.name}</span>
                  <span className="shrink-0 text-xs text-muted">{a.layoutName}</span>
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-sm text-muted">No matching assets.</li>
          )}
        </ul>
      )}
    </fieldset>
  );
}

export function PasswordDialog({
  clientId,
  item,
  onClose,
}: {
  clientId: string;
  item?: PasswordView;
  onClose: () => void;
}) {
  const actor = useActor();
  const toast = useToast();
  const go = useGo();
  const queryClient = useQueryClient();
  const reveal = useReveal();
  const [kind, setKind] = useState<PasswordKind>(item?.kind ?? 'login');
  const note = kind === 'note';
  const folders = usePasswordFolders(clientId).data ?? [];
  const [folderId, setFolderId] = useState(item?.folderId ?? '');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(!item);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<EditableField[]>(
    item?.customFields.map((f) => ({ key: f.id, id: f.id, label: f.label, secret: f.secret, value: f.value ?? '' })) ??
      [],
  );
  const [assetIds, setAssetIds] = useState<string[]>(item?.linkedAssets.map((a) => a.id) ?? []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '');
    const rotation = text('rotationDays');
    const body: Record<string, unknown> = {
      name: text('name'),
      username: note ? '' : text('username'),
      url: kind === 'login' ? text('url') : '',
      rotationDays: rotation ? Number(rotation) : null,
      expiresOn: text('expiresOn') || null,
      ...(actor.isAdmin ? { restricted: form.get('restricted') === 'on' } : {}),
      clientVisible: form.get('clientVisible') === 'on',
      ...(kind === 'login' ? { category: text('category') || null } : {}),
      // An existing secret left empty keeps its stored value.
      customFields: fields.map((f) => ({
        ...(f.id ? { id: f.id } : {}),
        label: f.label,
        secret: f.secret,
        ...(f.id && f.secret && !f.value ? {} : { value: f.value }),
      })),
      folderId: text('folderId') || null,
    };
    // On edit, secrets are sent only when changed, so unrevealed values are never round-tripped.
    if (!item || (secret && secret !== shownNote)) body.secret = secret;
    if (!note && (!item || form.get('notes') !== null)) body.notes = text('notes');
    if (kind === 'login' && (!item || text('totp'))) body.totp = text('totp');
    setBusy(true);
    setError(null);
    try {
      const saved = item
        ? await api<PasswordView>(`/passwords/${item.id}`, {
            method: 'PATCH',
            body: { ...body, version: item.version },
          })
        : await api<PasswordView>(`/clients/${clientId}/passwords`, { method: 'POST', body: { ...body, kind } });
      const linkFailed = await syncAssetLinks(saved.id, item?.linkedAssets.map((a) => a.id) ?? [], assetIds);
      if (linkFailed) toast(linkFailed, 'error');
      queryClient.setQueryData(['password', saved.id], saved);
      await Promise.all(
        [
          'passwords',
          'password',
          'password-history',
          'password-audit',
          'password-folders',
          'activity',
          'relations',
        ].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      );
      toast(item ? 'Saved.' : `${saved.name} saved to the vault.`);
      onClose();
      if (!item) go(`/passwords/${saved.id}`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const [notes, setNotes] = useState<string | null>(item ? null : '');
  const loadNotes = async () => {
    const result = item && (await reveal(item, { field: 'notes' }, 'Why do you need to see these notes?'));
    if (result) setNotes(result.value);
  };
  // A secure note is edited in place: shown (and recorded as viewed) first, then saved only if it changed.
  const [shownNote, setShownNote] = useState<string | null>(null);
  const loadNote = async () => {
    const result = item && (await reveal(item, {}, 'Why do you need to see this note?'));
    if (result) {
      setShownNote(result.value);
      setSecret(result.value);
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={item ? `Edit ${item.name}` : 'Add to the vault'}
      description="Secrets are encrypted before they're stored. Every view and copy is recorded."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="password-form" loading={busy}>
            {item ? 'Save changes' : 'Save to vault'}
          </Button>
        </>
      }
    >
      <form id="password-form" onSubmit={submit} className="space-y-4" noValidate>
        {!item && (
          <div role="group" aria-label="Type" className="flex gap-1 rounded-lg bg-surface-3 p-1">
            {(
              [
                ['login', 'Login', KeyRound],
                ['bitlocker', 'BitLocker recovery key', HardDrive],
                ['note', 'Secure note', StickyNote],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className="flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium aria-pressed:bg-surface"
              >
                <Icon className="size-4" aria-hidden /> {label}
              </button>
            ))}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={error?.fields?.name}>
            {(p) => (
              <Input
                {...p}
                name="name"
                defaultValue={item?.name}
                required
                maxLength={200}
                autoFocus
                placeholder={
                  kind === 'bitlocker' ? 'e.g. HDG-DC-01 · C:' : note ? 'e.g. Alarm panel codes' : 'e.g. Firewall admin'
                }
              />
            )}
          </Field>
          {!note && (
            <Field label={kind === 'bitlocker' ? 'Recovery key ID' : 'Username'} error={error?.fields?.username}>
              {(p) => (
                <Input
                  {...p}
                  name="username"
                  defaultValue={item?.username}
                  maxLength={254}
                  autoComplete="off"
                  className={kind === 'bitlocker' ? 'font-mono' : undefined}
                />
              )}
            </Field>
          )}
        </div>
        {kind === 'login' && (
          <Field
            label="Type"
            help="What this login is for. Left on automatic, Atlas guesses from the name, username, and address."
            error={error?.fields?.category}
          >
            {(p) => (
              <Select {...p} name="category" defaultValue={item && !item.categoryGuessed ? item.category : ''}>
                <option value="">
                  Automatic
                  {item?.categoryGuessed ? ` (${PASSWORD_CATEGORY_LABELS[item.category]})` : ''}
                </option>
                {PASSWORD_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {PASSWORD_CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field
          label="Folder"
          help={
            folders.length ? undefined : 'This client has no folders yet. Add them with Folders in the password list.'
          }
          error={error?.fields?.folderId}
        >
          {(p) => (
            // Controlled, and the current folder is always an option, so a slow folder list can't unfile it.
            <Select {...p} name="folderId" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">No folder</option>
              {item?.folderId && !folders.some((f) => f.id === item.folderId) && (
                <option value={item.folderId}>{item.folderName}</option>
              )}
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {note && item && shownNote === null ? (
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="text-muted">The note is encrypted.</span>
            <Button variant="ghost" size="sm" onClick={loadNote}>
              <Eye /> Show to edit
            </Button>
          </div>
        ) : note ? (
          <Field label="Note (encrypted)" error={error?.fields?.secret}>
            {(p) => (
              <Textarea
                {...p}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                rows={8}
                maxLength={MAX_NOTE_LENGTH}
                spellCheck={false}
                required
              />
            )}
          </Field>
        ) : (
          <Field
            label={kind === 'bitlocker' ? 'Recovery key' : item ? 'New password' : 'Password'}
            error={error?.fields?.secret}
            help={item ? 'Leave empty to keep the current one. Changing it keeps the old one in history.' : undefined}
          >
            {(p) => (
              <div>
                <div className="flex gap-2">
                  <Input
                    {...p}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    type={showSecret ? 'text' : 'password'}
                    autoComplete="new-password"
                    spellCheck={false}
                    className="font-mono"
                    placeholder={
                      kind === 'bitlocker' ? '000000-000000-000000-000000-000000-000000-000000-000000' : undefined
                    }
                    required={!item}
                  />
                  <Button
                    variant="secondary"
                    size="icon"
                    aria-label={showSecret ? 'Hide' : 'Show'}
                    onClick={() => setShowSecret((v) => !v)}
                  >
                    {showSecret ? <EyeOff /> : <Eye />}
                  </Button>
                  {kind === 'login' && (
                    <Button variant="secondary" onClick={() => setGenerating((v) => !v)} aria-expanded={generating}>
                      <RefreshCw /> Generate
                    </Button>
                  )}
                </div>
                {kind === 'login' && <StrengthMeter value={secret} />}
              </div>
            )}
          </Field>
        )}
        {generating && (
          <Generator
            onUse={(value) => {
              setSecret(value);
              setShowSecret(true);
              setGenerating(false);
            }}
          />
        )}
        {kind === 'login' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Website or address" error={error?.fields?.url}>
              {(p) => (
                <Input {...p} name="url" type="url" defaultValue={item?.url} maxLength={2000} placeholder="https://" />
              )}
            </Field>
            <Field
              label="Authenticator setup key (TOTP)"
              error={error?.fields?.totp}
              help={
                item?.hasTotp
                  ? 'Set. Enter a new key to replace it.'
                  : 'Optional. Atlas will show the current 6-digit code.'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  name="totp"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono uppercase"
                  maxLength={200}
                />
              )}
            </Field>
          </div>
        )}
        {note ? null : notes === null ? (
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 text-sm">
            <span className="text-muted">{item?.hasNotes ? 'Notes are encrypted.' : 'No notes.'}</span>
            {item?.hasNotes ? (
              <Button variant="ghost" size="sm" onClick={loadNotes}>
                <Eye /> Show to edit
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setNotes('')}>
                <Plus /> Add notes
              </Button>
            )}
          </div>
        ) : (
          <Field label="Notes (encrypted)" error={error?.fields?.notes}>
            {(p) => (
              <Textarea
                {...p}
                name="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={20000}
              />
            )}
          </Field>
        )}
        <CustomFieldsEditor fields={fields} onChange={setFields} error={error?.fields?.customFields} />
        <AssetLinksField clientId={item?.clientId ?? clientId} value={assetIds} onChange={setAssetIds} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Rotate every"
            help={
              item ? `Counted from the last change, ${formatDate(item.changedAt)}.` : 'Flags it for change when due.'
            }
          >
            {(p) => (
              <Select {...p} name="rotationDays" defaultValue={item?.rotationDays ? String(item.rotationDays) : ''}>
                <option value="">Don&rsquo;t remind me</option>
                {[30, 60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Account expires"
            help="Optional. For logins that stop working on a date, like a trial or a temporary account."
            error={error?.fields?.expiresOn}
          >
            {(p) => <Input {...p} name="expiresOn" type="date" defaultValue={item?.expiresOn ?? ''} />}
          </Field>
          {actor.isAdmin && (
            <div className="pt-6">
              <Checkbox
                name="restricted"
                defaultChecked={item?.restricted}
                label="Restrict to specific people"
                description="Only administrators and the people you list can see it."
              />
            </div>
          )}
        </div>
        <Checkbox
          name="clientVisible"
          defaultChecked={item?.clientVisible}
          label="Share with the client's own accounts"
          description="Client contacts with access to this client can view it (read-only) in their portal. Not used for restricted entries."
        />
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Drawer>
  );
}
