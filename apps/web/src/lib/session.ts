import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLE_INFO, atLeast, type AccessLevel, type SessionView } from '@atlas/shared';
import { ApiError, api, setCsrf } from './api';

export const sessionKey = ['session'] as const;

export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: async () => {
      try {
        const session = await api<SessionView>('/session');
        setCsrf(session.csrf);
        return session;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });
}

export function useSetupNeeded(enabled: boolean) {
  return useQuery({
    queryKey: ['setup'],
    queryFn: () => api<{ needed: boolean; passwordReset: boolean }>('/setup'),
    enabled,
    staleTime: Infinity,
  });
}

/** Stores a fresh session view (after sign-in, MFA, or password change). */
export function useApplySession() {
  const client = useQueryClient();
  return (session: SessionView | null) => {
    if (session) setCsrf(session.csrf);
    else setCsrf('');
    client.setQueryData(sessionKey, session);
    if (!session) client.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
  };
}

export function useActor() {
  const { data } = useSession();
  if (!data) throw new Error('useActor needs a signed-in session.');
  const actor = data.actor;
  const info = ROLE_INFO[actor.role];
  return {
    ...actor,
    organization: data.organization,
    isAdmin: info.admin,
    isStaff: info.staff,
    roleLabel: info.label,
    /** Can edit everything, e.g. create clients. */
    canEditAll: info.admin || atLeast(actor.allClients, 'edit'),
    can: (level: AccessLevel, required: AccessLevel) => atLeast(level, required),
  };
}
