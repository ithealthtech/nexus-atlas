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
