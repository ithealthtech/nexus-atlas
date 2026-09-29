import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PasswordAttachmentView,
  PasswordFolderView,
  PasswordHistoryView,
  PasswordView,
  RevealResult,
  SendCreated,
  SendView,
  ShareView,
  VaultAuditView,
} from '@atlas/shared';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { ApiError, api, getCsrf } from './api';
import { DEMO } from './demo';

export const usePasswords = (filter: { client?: string; archived?: boolean }) =>
  useQuery({
    queryKey: ['passwords', filter],
    queryFn: () =>
      api<PasswordView[]>(
        `/passwords?${new URLSearchParams(Object.entries({ client: filter.client ?? '', archived: filter.archived ? 'true' : '' }).filter(([, v]) => v))}`,
      ),
  });
export const usePasswordFolders = (clientId: string | undefined) =>
  useQuery({
    queryKey: ['password-folders', clientId],
    queryFn: () => api<PasswordFolderView[]>(`/clients/${clientId}/password-folders`),
    enabled: !!clientId,
  });
export const usePassword = (id: string) =>
  useQuery({ queryKey: ['password', id], queryFn: () => api<PasswordView>(`/passwords/${id}`) });
export const usePasswordHistory = (id: string) =>
  useQuery({
    queryKey: ['password-history', id],
    queryFn: () => api<PasswordHistoryView[]>(`/passwords/${id}/history`),
  });
export const usePasswordAudit = (id: string) =>
  useQuery({ queryKey: ['password-audit', id], queryFn: () => api<VaultAuditView[]>(`/passwords/${id}/audit`) });
export const useShares = (id: string) =>
  useQuery({ queryKey: ['password-shares', id], queryFn: () => api<ShareView[]>(`/passwords/${id}/shares`) });
export const usePasswordFiles = (id: string) =>
  useQuery({
    queryKey: ['password-files', id],
    queryFn: () => api<PasswordAttachmentView[]>(`/passwords/${id}/attachments`),
  });
export const useSends = (all: boolean) =>
  useQuery({ queryKey: ['sends', all], queryFn: () => api<SendView[]>(`/sends${all ? '?all=true' : ''}`) });
export const useRotationDue = (enabled: boolean) =>
  useQuery({
    queryKey: ['passwords', 'rotation-due'],
    queryFn: () => api<PasswordView[]>('/passwords/rotation-due'),
    enabled,
  });
export const useVaultAudit = (enabled: boolean) =>
  useQuery({ queryKey: ['vault-audit'], queryFn: () => api<VaultAuditView[]>('/vault/audit'), enabled });

// ---------- reveal with an optional or required reason ----------
type Ask = (title: string) => Promise<string | null>;
const ReasonContext = createContext<Ask>(async () => null);

/** Provides a reason prompt used when a client requires reasons for reveals. */
export function ReasonProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ title: string; resolve: (v: string | null) => void } | null>(null);
  const [reason, setReason] = useState('');
  const ask = useCallback<Ask>((title) => new Promise((resolve) => setPending({ title, resolve })), []);
  const finish = (value: string | null) => {
    pending?.resolve(value);
    setPending(null);
    setReason('');
  };
  return (
    <ReasonContext.Provider value={ask}>
      {children}
      {pending && (
        <Dialog
          open
          onClose={() => finish(null)}
          size="sm"
          title={pending.title}
          description="This client asks for a reason each time a password is used. It's saved in the access history."
          footer={
            <>
              <Button variant="secondary" onClick={() => finish(null)}>
                Cancel
              </Button>
              <Button onClick={() => finish(reason.trim())} disabled={!reason.trim()}>
                Continue
              </Button>
            </>
          }
        >
          <Field label="Reason">
            {(p) => (
              <Input
                {...p}
                autoFocus
                value={reason}
                maxLength={300}
                placeholder="e.g. Ticket 4411: firewall firmware update"
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && reason.trim() && finish(reason.trim())}
              />
            )}
          </Field>
        </Dialog>
      )}
    </ReasonContext.Provider>
  );
}

/**
 * Reveals a field. Asks for a reason up front when the client requires one (and retries once if the server asks).
 * Returns null if the person cancels.
 */
export function useReveal() {
  const ask = useContext(ReasonContext);
  const queryClient = useQueryClient();
  const reveal = useCallback(
    async (
      item: Pick<PasswordView, 'id' | 'requireReason'>,
      body: { field?: 'secret' | 'notes' | 'totp' | 'custom'; fieldId?: string; copy?: boolean; historyId?: string },
      label = 'Why do you need this password?',
    ) => {
      let reason = '';
      if (item.requireReason) {
        const given = await ask(label);
        if (given === null) return null;
        reason = given;
      }
      const path = body.historyId
        ? `/passwords/${item.id}/history/${body.historyId}/reveal`
        : `/passwords/${item.id}/reveal`;
      try {
        return await api<RevealResult>(path, {
          method: 'POST',
          body: { field: body.field ?? 'secret', fieldId: body.fieldId, copy: body.copy ?? false, reason },
        });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'reason_required') {
          const given = await ask(label);
          if (given === null) return null;
          return api<RevealResult>(path, {
            method: 'POST',
            body: { field: body.field ?? 'secret', fieldId: body.fieldId, copy: body.copy ?? false, reason: given },
          });
        }
        throw e;
      }
    },
    [ask],
  );
  // Each reveal is recorded; refresh the access history shown beside it.
  return useCallback(
    async (...args: Parameters<typeof reveal>) => {
      const result = await reveal(...args);
      if (result) void queryClient.invalidateQueries({ queryKey: ['password-audit', args[0].id] });
      return result;
    },
    [reveal, queryClient],
  );
}
export function useAskReason() {
  return useContext(ReasonContext);
}

// ---------- files on entries ----------
/** Sends a form (with a file) through the session; the JSON helper doesn't handle files. */
async function postForm<T>(path: string, form: FormData): Promise<T> {
  if (DEMO) throw new ApiError(400, "File uploads aren't available in the demo.");
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    body: form,
    headers: { 'X-CSRF-Token': getCsrf() },
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error ?? 'Upload failed.', data?.code, data?.fields);
  return data as T;
}

/** Saves a blob under a file name through a temporary link. */
export function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export async function uploadPasswordFile(id: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return postForm<PasswordAttachmentView[]>(`/passwords/${id}/attachments`, form);
}

/**
 * Downloads a file from an entry. Like a reveal, it asks for a reason when the client requires one, and is recorded.
 * Returns false if the person cancels.
 */
export function useDownloadPasswordFile() {
  const ask = useContext(ReasonContext);
  const queryClient = useQueryClient();
  return useCallback(
    async (item: Pick<PasswordView, 'id' | 'requireReason'>, file: PasswordAttachmentView) => {
      if (DEMO) throw new ApiError(400, "Files aren't available in the demo.");
      const label = `Why do you need ${file.filename}?`;
      const send = (reason: string) =>
        fetch(`/api/passwords/${item.id}/attachments/${file.id}/download`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
          body: JSON.stringify({ reason }),
        });
      let reason = '';
      if (item.requireReason) {
        const given = await ask(label);
        if (given === null) return false;
        reason = given;
      }
      let response = await send(reason);
      let error = response.ok ? null : await response.json().catch(() => null);
      if (error?.code === 'reason_required') {
        const given = await ask(label);
        if (given === null) return false;
        response = await send(given);
        error = response.ok ? null : await response.json().catch(() => null);
      }
      if (!response.ok) throw new ApiError(response.status, error?.error ?? 'The download failed.', error?.code);
      saveBlob(await response.blob(), file.filename);
      void queryClient.invalidateQueries({ queryKey: ['password-audit', item.id] });
      return true;
    },
    [ask, queryClient],
  );
}

// ---------- clipboard ----------
let clearTimer: ReturnType<typeof setTimeout> | undefined;
/** Copies text and clears the clipboard after 30 seconds (if it still holds what we copied, where the browser lets us check). */
export async function copySecret(value: string) {
  await navigator.clipboard.writeText(value);
  clearTimeout(clearTimer);
  clearTimer = setTimeout(async () => {
    try {
      const current = await navigator.clipboard.readText().catch(() => value);
      if (current === value) await navigator.clipboard.writeText('');
    } catch {
      /* The page may not have focus; nothing more we can do. */
    }
  }, 30_000);
}

// ---------- generator ----------
const WORDS =
  'acid acre aged also amber anchor apple arch arena atlas autumn badge bamboo basin beacon birch blade bloom bolt brave breeze brick bridge brook cabin cable cactus camel canal candle canyon carbon cargo cedar chalk charm cider circle citrus clay cliff cloud clover cobalt comet copper coral cosmic cotton crane crater creek crisp crystal dawn delta denim desert dial dolphin dune eagle echo ember engine falcon fern fiber field fjord flame flint forest fossil frost galaxy garnet geyser glacier globe granite gravel grove harbor hazel honey horizon icicle indigo iron island ivory jade jasper jungle juniper kayak kernel kestrel lagoon lantern lava lemon lichen linen lotus lumen lunar maple marble meadow meteor mint mosaic moss nebula nectar noble north oasis ocean olive onyx orbit orchid otter oxide paddle pebble pepper pine pixel planet plaza polar prairie prism pulse quartz quiver radar raven reef ridge river rocket saddle sage salt sandal satin shadow shore signal silk slate solar spruce stone summit tango thunder tide timber topaz tundra velvet violet vista walnut willow winter yonder zephyr zinc'.split(
    ' ',
  );

export interface GeneratorOptions {
  mode: 'characters' | 'passphrase' | 'pin';
  length: number;
  symbols: boolean;
  digits: boolean;
  words: number;
}
export const DEFAULT_GENERATOR: GeneratorOptions = {
  mode: 'characters',
  length: 24,
  symbols: true,
  digits: true,
  words: 5,
};

/** Common starting points. Each can still be adjusted before use. */
export const GENERATOR_PRESETS: { id: string; label: string; hint: string; options: GeneratorOptions }[] = [
  { id: 'strong', label: 'Strong', hint: '24 characters, all types', options: DEFAULT_GENERATOR },
  {
    id: 'admin',
    label: 'Admin / service account',
    hint: '32 characters, all types',
    options: { ...DEFAULT_GENERATOR, length: 32 },
  },
  {
    id: 'typeable',
    label: 'Easy to type',
    hint: '16 letters and numbers, no symbols',
    options: { ...DEFAULT_GENERATOR, length: 16, symbols: false },
  },
  {
    id: 'wifi',
    label: 'Wi-Fi / spoken',
    hint: '4-word passphrase',
    options: { ...DEFAULT_GENERATOR, mode: 'passphrase', words: 4 },
  },
  {
    id: 'pin',
    label: 'PIN',
    hint: '6 digits',
    options: { ...DEFAULT_GENERATOR, mode: 'pin', length: 6 },
  },
];
export const presetFor = (o: GeneratorOptions) =>
  GENERATOR_PRESETS.find((p) => JSON.stringify(p.options) === JSON.stringify(o))?.id ?? null;

const GENERATOR_KEY = 'atlas-generator';
/** The last settings used in this browser, if any; falls back to the default. */
export function loadGeneratorOptions(): GeneratorOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(GENERATOR_KEY) ?? 'null') as Partial<GeneratorOptions> | null;
    if (saved && ['characters', 'passphrase', 'pin'].includes(saved.mode ?? ''))
      return { ...DEFAULT_GENERATOR, ...saved };
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_GENERATOR;
}
export function saveGeneratorOptions(o: GeneratorOptions) {
  try {
    localStorage.setItem(GENERATOR_KEY, JSON.stringify(o));
  } catch {
    /* storage unavailable */
  }
}

/** Unbiased random index using rejection sampling over crypto.getRandomValues. */
function randomIndex(max: number) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer);
  while (buffer[0]! >= limit);
  return buffer[0]! % max;
}
export function generatePassword(o: GeneratorOptions): string {
  if (o.mode === 'pin') return Array.from({ length: o.length }, () => String(randomIndex(10))).join('');
  if (o.mode === 'passphrase') {
    const words = Array.from({ length: o.words }, () => WORDS[randomIndex(WORDS.length)]!);
    words[randomIndex(words.length)] = words[randomIndex(words.length)]!.replace(/^./, (c) => c.toUpperCase());
    return `${words.join('-')}-${randomIndex(90) + 10}`;
  }
  const sets = [
    'abcdefghijkmnopqrstuvwxyz',
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    ...(o.digits ? ['23456789'] : []),
    ...(o.symbols ? ['!@#$%^&*-_=+?'] : []),
  ];
  const all = sets.join('');
  // At least one character from each chosen set, then shuffle.
  const chars = [
    ...sets.map((set) => set[randomIndex(set.length)]!),
    ...Array.from({ length: Math.max(o.length, sets.length) - sets.length }, () => all[randomIndex(all.length)]!),
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

// ---------- share-link encryption (key stays in the browser and the link's #fragment) ----------
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export interface SharedPayload {
  name: string;
  username: string;
  url: string;
  secret: string;
  kind: string;
}
export async function encryptShare(payload: SharedPayload): Promise<{ ciphertext: string; key: string }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))),
  );
  const combined = new Uint8Array(iv.length + data.length);
  combined.set(iv);
  combined.set(data, iv.length);
  return { ciphertext: b64url(combined), key: b64url(rawKey) };
}

/**
 * Creates a one-time share link for a password: reveals it (audited), encrypts it in the browser, and stores only
 * the ciphertext. The decryption key is after the # in the link, so it never reaches the server.
 */
export async function createShareLink(
  item: Pick<PasswordView, 'id' | 'name' | 'username' | 'url' | 'kind'>,
  options: { maxViews: number; hours: number; reason: string },
): Promise<string> {
  const { value } = await api<{ value: string }>(`/passwords/${item.id}/reveal`, {
    method: 'POST',
    body: { reason: options.reason || 'Creating a share link' },
  });
  const { ciphertext, key } = await encryptShare({
    name: item.name,
    username: item.username,
    url: item.url,
    secret: value,
    kind: item.kind,
  });
  const share = await api<{ token: string }>(`/passwords/${item.id}/shares`, {
    method: 'POST',
    body: { ciphertext, maxViews: options.maxViews, expiresHours: options.hours, reason: options.reason },
  });
  return `${location.origin}/share/${share.token}#${key}`;
}

// ---------- Send: one-time text and files (encrypted here; the key is after the # in the link) ----------
async function sealRaw(rawKey: Uint8Array<ArrayBuffer>, plain: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const combined = new Uint8Array(iv.length + data.length);
  combined.set(iv);
  combined.set(data, iv.length);
  return combined;
}
async function openRaw(rawKey: Uint8Array<ArrayBuffer>, sealed: Uint8Array<ArrayBuffer>) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, key, sealed.slice(12)),
  );
}
const utf8 = (text: string) => new TextEncoder().encode(text);
const sendLink = (created: SendCreated, rawKey: Uint8Array) =>
  `${location.origin}/send/${created.token}#${b64url(rawKey)}`;

export interface SendOptions {
  name: string;
  maxViews: number;
  hours: number;
}
/** Encrypts text in the browser and stores only the ciphertext. Returns the link, which holds the key. */
export async function createTextSend(text: string, options: SendOptions): Promise<string> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const ciphertext = b64url(await sealRaw(rawKey, utf8(JSON.stringify({ text }))));
  const created = await api<SendCreated>('/sends', {
    method: 'POST',
    body: { name: options.name, ciphertext, maxViews: options.maxViews, expiresHours: options.hours },
  });
  return sendLink(created, rawKey);
}
/** Encrypts a file (and its name) in the browser and uploads only the ciphertext. */
export async function createFileSend(file: File, options: SendOptions): Promise<string> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const meta = b64url(await sealRaw(rawKey, utf8(JSON.stringify({ name: file.name, type: file.type }))));
  const sealed = await sealRaw(rawKey, new Uint8Array(await file.arrayBuffer()));
  const form = new FormData();
  // Fields before the file: the server reads them first.
  form.append('name', options.name);
  form.append('meta', meta);
  form.append('maxViews', String(options.maxViews));
  form.append('expiresHours', String(options.hours));
  form.append('file', new Blob([sealed], { type: 'application/octet-stream' }), 'send.bin');
  return sendLink(await postForm<SendCreated>('/sends/file', form), rawKey);
}

export type OpenedSend =
  | { kind: 'text'; text: string; remainingViews: number }
  | { kind: 'file'; name: string; blob: Blob; remainingViews: number };
/** Opens a Send (using one view) and decrypts it. */
export async function openSend(token: string, key: string): Promise<OpenedSend> {
  const response = await fetch(`/api/sends/${encodeURIComponent(token)}/open`, { method: 'POST' });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error ?? 'This Send could not be opened.');
  }
  const rawKey = fromB64url(key);
  if (response.headers.get('content-type')?.includes('application/json')) {
    const data = (await response.json()) as { ciphertext: string; remainingViews: number };
    const { text } = JSON.parse(new TextDecoder().decode(await openRaw(rawKey, fromB64url(data.ciphertext))));
    return { kind: 'text', text: String(text), remainingViews: data.remainingViews };
  }
  const meta = JSON.parse(
    new TextDecoder().decode(await openRaw(rawKey, fromB64url(response.headers.get('x-send-meta') ?? ''))),
  ) as { name?: string; type?: string };
  const plain = await openRaw(rawKey, new Uint8Array(await response.arrayBuffer()));
  return {
    kind: 'file',
    // Only a file name, never a path, whatever the sender's browser put there.
    name:
      String(meta.name ?? 'file')
        .split(/[\\/]/)
        .pop() || 'file',
    blob: new Blob([plain], { type: 'application/octet-stream' }),
    remainingViews: Number(response.headers.get('x-send-remaining-views') ?? 0),
  };
}

export async function decryptShare(ciphertext: string, key: string): Promise<SharedPayload> {
  const bytes = fromB64url(ciphertext);
  const cryptoKey = await crypto.subtle.importKey('raw', fromB64url(key), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain)) as SharedPayload;
}
