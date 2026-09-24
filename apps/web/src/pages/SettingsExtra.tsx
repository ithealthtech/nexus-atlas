import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Palette, Plus, Trash2 } from 'lucide-react';
import { API_KEY_SCOPES, API_KEY_SCOPE_LABELS, type ApiKeyScope, type ApiKeyView, type Branding } from '@atlas/shared';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Dialog,
  Field,
  FormError,
  Input,
  Select,
  Textarea,
  useToast,
} from '@/components/ui';
import { api } from '@/lib/api';
import { applyBranding, useBranding } from '@/lib/branding';
import { formatDate, relativeTime } from '@/lib/format';

export function BrandingCard() {
  const toast = useToast();
  const client = useQueryClient();
  const current = useBranding().data;
  const [accent, setAccent] = useState<string | null | undefined>(undefined);
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!current) return null;
  const color = accent === undefined ? current.accent : accent;
  const image = logo === undefined ? current.logo : logo;
  const pickLogo = (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!/^image\/(png|jpeg|svg\+xml)$/.test(file.type)) return setError('Use a PNG, JPEG, or SVG image.');
    if (file.size > 150 * 1024) return setError('Use a logo under 150 KB.');
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  };
  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const welcome = String(new FormData(e.currentTarget).get('portalWelcome') ?? '');
    setBusy(true);
    setError(null);
    try {
      const body: Branding = { accent: color ?? null, logo: image ?? null, portalWelcome: welcome };
      await api('/branding', { method: 'PUT', body });
      await client.invalidateQueries({ queryKey: ['branding'] });
      setAccent(undefined);
      setLogo(undefined);
      toast('Branding saved.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Branding" description="Your logo and colour, shown to your team and in the client portal." />
      <form onSubmit={save} className="space-y-5 p-5" noValidate>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Logo" help="PNG, JPEG, or SVG, under 150 KB. Wide logos work best.">
            {(p) => (
              <div className="space-y-2">
                <div className="grid h-16 place-items-center rounded-lg border border-dashed border-border-strong bg-surface-2">
                  {image ? (
                    <img src={image} alt="Logo preview" className="max-h-12 max-w-48 object-contain" />
                  ) : (
                    <span className="text-xs text-muted">Using the Atlas logo</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    {...p}
                    type="file"
                    accept="image/png,image/jpeg,image/svg+xml"
                    className="pt-1.5"
                    onChange={(e) => pickLogo(e.target.files?.[0])}
                  />
                  {image && (
                    <Button variant="ghost" onClick={() => setLogo(null)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            )}
          </Field>
          <Field label="Accent colour" help="Buttons, links, and highlights. Text colour adjusts for contrast.">
            {(p) => (
              <div className="flex items-center gap-2">
                <input
                  {...p}
                  type="color"
                  value={color ?? '#205843'}
                  onChange={(e) => {
                    setAccent(e.target.value);
                    applyBranding(e.target.value);
                  }}
                  className="h-10 w-14 cursor-pointer rounded-lg border border-border-strong bg-surface"
                />
                <code className="font-mono text-sm">{color ?? 'Default'}</code>
                {color && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setAccent(null);
                      applyBranding(null);
                    }}
                  >
                    Use default
                  </Button>
                )}
              </div>
            )}
          </Field>
        </div>
        <Field label="Client portal welcome" help="Shown to client contacts at the top of their dashboard.">
          {(p) => (
            <Textarea
              {...p}
              name="portalWelcome"
              defaultValue={current.portalWelcome}
              maxLength={500}
              placeholder="Welcome! Here's the documentation we keep for you. Call us at (919) 555-0100 for help."
            />
          )}
        </Field>
        <FormError message={error} />
        <div className="flex justify-end">
          <Button type="submit" loading={busy}>
            <Palette /> Save branding
          </Button>
        </div>
      </form>
    </Card>
  );
}

function NewKeyDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [scopes, setScopes] = useState<Set<ApiKeyScope>>(new Set(['read']));
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const days = String(form.get('expires'));
      const key = await api<ApiKeyView & { token: string }>('/api-keys', {
        method: 'POST',
        body: { name: form.get('name'), scopes: [...scopes], expiresDays: days ? Number(days) : null },
      });
      setCreated(key.token);
      await client.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={created ? 'Copy your API key' : 'New API key'}
      footer={
        created ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="key-form" loading={busy}>
              Create key
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-3">
          <p className="text-sm text-text-2">
            This is the only time the key is shown. Store it in the tool that will use it. It acts as you, limited to
            the scopes you chose.
          </p>
          <code className="block rounded-lg border border-border bg-surface-2 p-3 font-mono text-[13px] break-all">
            {created}
          </code>
          <Button
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(created).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy key'}
          </Button>
        </div>
      ) : (
        <form id="key-form" onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Name" help="What will use it, for example “ConnectWise sync”.">
            {(p) => <Input {...p} name="name" required maxLength={80} autoFocus />}
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[13px] font-semibold">Scopes</legend>
            {API_KEY_SCOPES.map((s) => (
              <Checkbox
                key={s}
                label={API_KEY_SCOPE_LABELS[s]}
                checked={scopes.has(s)}
                onChange={(e) =>
                  setScopes((cur) => {
                    const next = new Set(cur);
                    if (e.target.checked) next.add(s);
                    else next.delete(s);
                    return next;
                  })
                }
              />
            ))}
          </fieldset>
          <Field label="Expires">
            {(p) => (
              <Select {...p} name="expires" defaultValue="365">
                <option value="90">In 90 days</option>
                <option value="365">In 1 year</option>
                <option value="">Never</option>
              </Select>
            )}
          </Field>
          <FormError message={error} />
        </form>
      )}
    </Dialog>
  );
}

export function ApiKeysCard() {
  const toast = useToast();
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<ApiKeyView[]>('/api-keys') });
  const [adding, setAdding] = useState(false);
  const revoke = async (key: ApiKeyView) => {
    try {
      await api(`/api-keys/${key.id}`, { method: 'DELETE' });
      await keys.refetch();
      toast(`“${key.name}” revoked. It stops working immediately.`);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <Card>
      <CardHeader
        title="API keys"
        description={
          <>
            For PSA, RMM, and scripts. The REST API is at <code className="font-mono">/api/v1</code>, described in{' '}
            <a
              className="font-semibold text-primary underline underline-offset-2"
              href="/api/v1/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              openapi.json
            </a>
            .
          </>
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <Plus /> New key
          </Button>
        }
      />
      {!keys.data?.length ? (
        <p className="px-5 py-4 text-sm text-muted">No API keys yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {keys.data.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <KeyRound className="size-5 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {k.name}
                  {k.revoked ? (
                    <Badge tone="danger">Revoked</Badge>
                  ) : k.expiresAt && k.expiresAt < new Date().toISOString() ? (
                    <Badge tone="warning">Expired</Badge>
                  ) : null}
                </p>
                <p className="text-xs text-muted">
                  <code className="font-mono">atlas_{k.prefix}_…</code> · {k.scopes.join(', ')} · {k.userName} ·{' '}
                  {k.lastUsedAt ? `used ${relativeTime(k.lastUsedAt)}` : 'never used'}
                  {k.expiresAt && ` · expires ${formatDate(k.expiresAt)}`}
                </p>
              </div>
              {!k.revoked && (
                <Button variant="ghost" size="sm" onClick={() => revoke(k)} aria-label={`Revoke ${k.name}`}>
                  <Trash2 /> Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {adding && <NewKeyDialog onClose={() => setAdding(false)} />}
    </Card>
  );
}
