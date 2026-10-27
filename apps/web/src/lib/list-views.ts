import { useQueryClient } from '@tanstack/react-query';
import type { ListName, ListViewPrefs, WorkspacePrefs } from '@atlas/shared';
import { api } from '@/lib/api';
import { useWorkspacePrefs } from '@/lib/queries';

/**
 * A list's saved view (sort, grouping, columns), kept per person with the rest of their workspace so it follows
 * them to any computer. Changes show at once and are saved in the background; if saving fails, the change still
 * applies until the page reloads.
 */
export function useListView(list: ListName): [ListViewPrefs, (change: Partial<ListViewPrefs>) => void] {
  const prefs = useWorkspacePrefs();
  const queryClient = useQueryClient();
  const view = prefs.data?.listViews?.[list] ?? {};
  const change = (next: Partial<ListViewPrefs>) => {
    const merged = { ...view, ...next };
    queryClient.setQueryData<WorkspacePrefs>(['workspace'], (old) =>
      old ? { ...old, listViews: { ...old.listViews, [list]: merged } } : old,
    );
    void api<WorkspacePrefs>(`/account/list-views/${list}`, { method: 'PUT', body: merged }).catch(() => undefined);
  };
  return [view, change];
}
