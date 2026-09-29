import { useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Download, Eye, FileText, Plus, Send as SendIcon, ShieldCheck, Type } from 'lucide-react';
import { MAX_SEND_TEXT, type SendView } from '@atlas/shared';
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
  Textarea,
  useToast,
} from '@/components/ui';
import { Logo } from '@/components/Logo';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { useActor } from '@/lib/session';
import { createFileSend, createTextSend, openSend, saveBlob, useSends, type OpenedSend } from '@/lib/vault';

const VIEW_CHOICES = [1, 2, 3, 5];
const EXPIRY_CHOICES: [number, string][] = [
  [1, '1 hour'],
  [24, '1 day'],
  [72, '3 days'],
  [168, '7 days'],
];

function status(s: SendView) {
  if (s.revoked) return <Badge>Revoked</Badge>;
  if (s.views >= s.maxViews) return <Badge>Used</Badge>;
  if (!s.active) return <Badge>Expired</Badge>;
  return <Badge tone="success">Active</Badge>;
}

/** Staff page: send text or a file to someone without an account, with a one-time link. */
export function Sends() {
  const actor = useActor();
  const [all, setAll] = useState(false);
  const { data, isLoading } = useSends(all);
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();
  return (
    <>
      <PageHeader
        eyebrow="Vault"
        title="Send"
        description="Share text or a file once, with someone who doesn't sign in to Atlas. It's encrypted in your browser; the key is only in the link."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New Send
          </Button>
        }
      />
      {actor.isAdmin && (
        <div className="mb-4">
          <Checkbox label="Show everyone's Sends" checked={all} onChange={(e) => setAll(e.target.checked)} />
        </div>
      )}
      <Card>
        {isLoading ? (
          <Skeleton className="m-4 h-16" />
        ) : !data?.length ? (
          <EmptyState
            icon={SendIcon}
            title="Nothing sent yet"
            description="Send a license key, a config file, or instructions without pasting them into email."
            action={
              <Button onClick={() => setCreating(true)}>
                <Plus /> New Send
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {data.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-text-2">
                  {s.kind === 'file' ? (
                    <FileText className="size-4" aria-hidden />
                  ) : (
                    <Type className="size-4" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {status(s)}
                  </span>
                  <span className="block text-xs text-muted">
                    {s.views} of {s.maxViews} view{s.maxViews === 1 ? '' : 's'} used ·{' '}
                    {s.active ? `expires ${formatDateTime(s.expiresAt)}` : `sent ${relativeTime(s.createdAt)}`}
                    {all && ` · by ${s.createdByName}`}
                  </span>
                </span>
                {s.active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      try {
                        await api(`/sends/${s.id}`, { method: 'DELETE' });
                        await queryClient.invalidateQueries({ queryKey: ['sends'] });
                        toast('Send revoked. Its content is deleted.');
                      } catch (e) {
                        toast((e as Error).message, 'error');
                      }
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {creating && <NewSendDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function NewSendDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'text' | 'file'>('text');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [maxViews, setMaxViews] = useState(1);
  const [hours, setHours] = useState(24);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const create = async () => {
    setError(null);
    if (kind === 'text' && !text.trim()) return setError(new Error('Write the text to send.'));
    if (kind === 'file' && !file) return setError(new Error('Choose a file to send.'));
    setBusy(true);
    try {
      const options = { name: name.trim() || (kind === 'file' ? file!.name : 'Text'), maxViews, hours };
      setLink(kind === 'text' ? await createTextSend(text, options) : await createFileSend(file!, options));
      await queryClient.invalidateQueries({ queryKey: ['sends'] });
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const fields = error instanceof ApiError ? error.fields : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="New Send"
      description="Encrypted in your browser before it's uploaded. Atlas never has the key; it's the part of the link after the #."
      footer={
        link ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={create} loading={busy}>
              Create link
            </Button>
          </>
        )
      }
    >
      {link ? (
        <Field
          label="Send link"
          help="Copy it now. It isn't shown again, and anyone with it can open it until it's used up or expires."
        >
          {(p) => (
            <div className="flex gap-2">
              <Input {...p} readOnly value={link} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(link);
                    toast('Link copied.');
                  } catch {
                    toast('The browser blocked copying. Select the link and copy it.', 'error');
                  }
                }}
              >
                <Copy /> Copy
              </Button>
            </div>
          )}
        </Field>
      ) : (
        <div className="space-y-4">
          <div role="group" aria-label="What to send" className="flex gap-1 rounded-lg bg-surface-3 p-1">
            {(
              [
                ['text', 'Text', Type],
                ['file', 'File', FileText],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
                className="flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium aria-pressed:bg-surface aria-pressed:shadow-sm"
              >
                <Icon className="size-4" aria-hidden /> {label}
              </button>
            ))}
          </div>
          <Field label="Name" help="Only you see it, in this list and the security log." error={fields?.name}>
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={120}
                placeholder={kind === 'file' ? 'e.g. VPN profile for Jordan' : 'e.g. Wi-Fi for the auditor'}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          {kind === 'text' ? (
            <Field label="Text" error={fields?.ciphertext}>
              {(p) => (
                <Textarea
                  {...p}
                  value={text}
                  rows={6}
                  maxLength={MAX_SEND_TEXT}
                  spellCheck={false}
                  onChange={(e) => setText(e.target.value)}
                />
              )}
            </Field>
          ) : (
            <Field label="File">
              {(p) => (
                <div className="flex items-center gap-3">
                  <input
                    ref={input}
                    type="file"
                    className="sr-only"
                    aria-label="Choose a file to send"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  />
                  <Button {...p} variant="secondary" onClick={() => input.current?.click()}>
                    Choose file
                  </Button>
                  <span className="truncate text-sm text-muted">{file?.name ?? 'No file chosen'}</span>
                </div>
              )}
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Can be opened">
              {(p) => (
                <Select {...p} value={maxViews} onChange={(e) => setMaxViews(Number(e.target.value))}>
                  {VIEW_CHOICES.map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? 'Once' : `${n} times`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Expires after">
              {(p) => (
                <Select {...p} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {EXPIRY_CHOICES.map(([h, label]) => (
                    <option key={h} value={h}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <FormError message={error ? error.message : null} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * Public page for a Send. The key is in the URL #fragment, which browsers never send to the server; opening uses
 * one of the Send's views.
 */
export function SendPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  // Read the key once and remove it from the address bar and history.
  const [key] = useState(() => {
    const k = location.hash.slice(1);
    if (k) history.replaceState(null, '', location.pathname);
    return k;
  });
  const [opened, setOpened] = useState<OpenedSend | null>(null);
  const [error, setError] = useState<string | null>(
    key ? null : 'This link is incomplete. Ask the sender for the full link.',
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await openSend(token, key);
      setOpened(result);
      if (result.kind === 'file') saveBlob(result.blob, result.name);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'This link could not be decrypted. It may have been copied incompletely.',
      );
    } finally {
      setBusy(false);
    }
  };
  const remaining = opened?.remainingViews ?? null;
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-lg">
        <Logo className="mb-8" />
        <Card className="p-6 sm:p-8">
          {!opened ? (
            <>
              <span className="mb-4 grid size-11 place-items-center rounded-xl bg-primary-soft text-primary">
                <SendIcon className="size-5" aria-hidden />
              </span>
              <h1 className="text-xl font-semibold">Someone sent you something</h1>
              <p className="mt-2 text-sm text-muted">
                It&rsquo;s encrypted, and this link can only be opened a limited number of times. Open it when
                you&rsquo;re ready to save it.
              </p>
              {error ? (
                <p
                  role="alert"
                  className="mt-5 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
                </p>
              ) : (
                <Button size="lg" className="mt-6 w-full" onClick={open} loading={busy}>
                  <Eye /> Open
                </Button>
              )}
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">{opened.kind === 'file' ? opened.name : 'Text sent to you'}</h1>
              <p className="mt-1 text-sm text-muted">
                {remaining === 0
                  ? `This link has now been used up. ${opened.kind === 'file' ? 'Keep the downloaded file' : 'Save the text'} somewhere safe before closing this page.`
                  : `This link can be opened ${remaining} more time${remaining === 1 ? '' : 's'}.`}
              </p>
              {opened.kind === 'text' ? (
                <div className="mt-5 rounded-xl border border-border">
                  <p className="max-h-96 overflow-auto px-4 py-3 text-sm break-words whitespace-pre-wrap">
                    {opened.text}
                  </p>
                  <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
                    {copied && (
                      <span className="text-xs text-success" role="status">
                        Copied.
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigator.clipboard.writeText(opened.text).then(() => setCopied(true))}
                    >
                      <Copy /> Copy
                    </Button>
                  </div>
                </div>
              ) : (
                <Button className="mt-5 w-full" variant="secondary" onClick={() => saveBlob(opened.blob, opened.name)}>
                  <Download /> Download again
                </Button>
              )}
            </>
          )}
          <p className="mt-6 flex items-start gap-2 border-t border-border pt-4 text-xs text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            Decrypted in your browser. The server never had the key to read it.
          </p>
        </Card>
      </div>
    </main>
  );
}
