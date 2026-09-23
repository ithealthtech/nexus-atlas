import type {
  ActivityView,
  AssetView,
  AttachmentView,
  ContactView,
  DocumentSummary,
  DocumentView,
  FolderView,
  ItemType,
  LayoutView,
  LocationView,
  RelationView,
  RevisionView,
  SearchResult,
} from '@atlas/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClientSummary, SecurityEventView, UserView } from '@atlas/shared';
import { api } from './api';

export const useClients = () => useQuery({ queryKey: ['clients'], queryFn: () => api<ClientSummary[]>('/clients') });
export const useClient = (id: string) =>
  useQuery({ queryKey: ['clients', id], queryFn: () => api<ClientSummary>(`/clients/${id}`) });
export const useUsers = (enabled = true) =>
  useQuery({ queryKey: ['users'], queryFn: () => api<UserView[]>('/users'), enabled });
export const useSecurityEvents = () =>
  useQuery({ queryKey: ['security-events'], queryFn: () => api<SecurityEventView[]>('/security-events') });

/** A mutation that refreshes the listed queries when it succeeds. */
export function useSave<TBody, TResult>(send: (body: TBody) => Promise<TResult>, invalidate: string[][]) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSuccess: () => Promise.all(invalidate.map((queryKey) => client.invalidateQueries({ queryKey }))),
  });
}

/** A strong, readable temporary password (four words plus digits) generated in the browser. */
export function generatePassphrase(): string {
  const words = [
    'amber',
    'basin',
    'cedar',
    'delta',
    'ember',
    'fjord',
    'grove',
    'harbor',
    'indigo',
    'juniper',
    'kestrel',
    'lumen',
    'maple',
    'north',
    'orbit',
    'pebble',
    'quartz',
    'river',
    'summit',
    'timber',
    'umber',
    'violet',
    'willow',
    'yonder',
    'zephyr',
    'copper',
    'meadow',
    'granite',
    'lantern',
    'harvest',
    'falcon',
    'glacier',
  ];
  const values = crypto.getRandomValues(new Uint32Array(5));
  const picked = Array.from(values.slice(0, 4), (v) => words[v % words.length]);
  return `${picked.join('-')}-${(values[4]! % 90) + 10}`;
}

// ---------- documentation ----------

const qs = (params: Record<string, string | undefined | boolean>) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== false) as [
    string,
    string,
  ][];
  return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}` : '';
};

export const useLayouts = () =>
  useQuery({ queryKey: ['layouts'], queryFn: () => api<LayoutView[]>('/layouts'), staleTime: 60_000 });
export const useAssets = (filter: { client?: string; layout?: string; archived?: boolean }) =>
  useQuery({ queryKey: ['assets', filter], queryFn: () => api<AssetView[]>(`/assets${qs(filter)}`) });
export const useAsset = (id: string) =>
  useQuery({ queryKey: ['asset', id], queryFn: () => api<AssetView>(`/assets/${id}`) });
export const useDocuments = (filter: { client?: string; folder?: string; archived?: boolean }) =>
  useQuery({ queryKey: ['documents', filter], queryFn: () => api<DocumentSummary[]>(`/documents${qs(filter)}`) });
export const useDocument = (id: string) =>
  useQuery({ queryKey: ['document', id], queryFn: () => api<DocumentView>(`/documents/${id}`) });
export const useFolders = (client: string | null) =>
  useQuery({
    queryKey: ['folders', client],
    queryFn: () => api<FolderView[]>(`/folders${qs({ client: client ?? undefined })}`),
  });
export const useContacts = (client: string) =>
  useQuery({ queryKey: ['contacts', client], queryFn: () => api<ContactView[]>(`/clients/${client}/contacts`) });
export const useLocations = (client: string) =>
  useQuery({ queryKey: ['locations', client], queryFn: () => api<LocationView[]>(`/clients/${client}/locations`) });
export const useRelations = (type: ItemType, id: string) =>
  useQuery({ queryKey: ['relations', type, id], queryFn: () => api<RelationView[]>(`/items/${type}/${id}/relations`) });
export const useAttachments = (type: ItemType, id: string) =>
  useQuery({
    queryKey: ['attachments', type, id],
    queryFn: () => api<AttachmentView[]>(`/items/${type}/${id}/attachments`),
  });
export const useRevisions = (type: 'assets' | 'documents', id: string, enabled = true) =>
  useQuery({
    queryKey: ['revisions', type, id],
    queryFn: () => api<RevisionView[]>(`/${type}/${id}/revisions`),
    enabled,
  });
export const useActivity = (filter: { client?: string; item?: string; limit?: string }) =>
  useQuery({ queryKey: ['activity', filter], queryFn: () => api<ActivityView[]>(`/activity${qs(filter)}`) });
export const useSearch = (q: string, client?: string) =>
  useQuery({
    queryKey: ['search', q, client],
    queryFn: () => api<SearchResult[]>(`/search${qs({ q, client })}`),
    enabled: q.trim().length > 0,
    placeholderData: (prev) => prev,
  });

/** Upload with fetch + FormData (the JSON helper doesn't handle files). */
export async function uploadFile(type: ItemType, id: string, file: File, csrf: string): Promise<AttachmentView[]> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch(`/api/items/${type}/${id}/attachments`, {
    method: 'POST',
    body: form,
    headers: { 'X-CSRF-Token': csrf },
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error ?? 'Upload failed.');
  return data;
}
