import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PasswordFolderView,
  PasswordHistoryView,
  PasswordView,
  RevealResult,
  ShareView,
  VaultAuditView,
} from '@atlas/shared';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { ApiError, api } from './api';

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
  mode: 'characters' | 'passphrase';
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

/** Unbiased random index using rejection sampling over crypto.getRandomValues. */
function randomIndex(max: number) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do crypto.getRandomValues(buffer);
  while (buffer[0]! >= limit);
  return buffer[0]! % max;
}
export function generatePassword(o: GeneratorOptions): string {
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

export async function decryptShare(ciphertext: string, key: string): Promise<SharedPayload> {
  const bytes = fromB64url(ciphertext);
  const cryptoKey = await crypto.subtle.importKey('raw', fromB64url(key), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, cryptoKey, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain)) as SharedPayload;
}
