import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import type { FavoriteItem, FavoriteType } from '@atlas/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useFavorites } from '@/lib/queries';
import { AppLink } from './AppLink';
import { ItemIcon, itemHref } from './ItemIcon';
import { Card, CardHeader, EmptyState, Skeleton, useToast } from './ui';

/** A personal star for a client, document, or asset: pins it to your dashboard (nobody else sees it). */
export function FavoriteStar({ type, id, name }: { type: FavoriteType; id: string; name: string }) {
  const favorites = useFavorites();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const on = !!favorites.data?.some((f) => f.type === type && f.id === id);
  const toggle = async () => {
    setBusy(true);
    try {
      await api(`/favorites/${type}/${id}`, { method: on ? 'DELETE' : 'PUT', ...(on ? {} : { body: {} }) });
      await queryClient.invalidateQueries({ queryKey: ['favorites'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy || favorites.isLoading}
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      title={on ? 'Favorite' : 'Add to favorites'}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-warning aria-pressed:text-warning disabled:opacity-60"
    >
      <Star className={cn('size-5', on && 'fill-current')} aria-hidden />
    </button>
  );
}

const GROUPS: [FavoriteItem['type'], string][] = [
  ['client', 'Clients'],
  ['document', 'Documents'],
  ['asset', 'Assets'],
  ['password', 'Passwords'],
];

/** The dashboard card listing everything the viewer starred. */
export function FavoritesCard() {
  const favorites = useFavorites();
  const list = favorites.data ?? [];
  return (
    <Card>
      <CardHeader title="Favorites" description="What you starred, for quick access. Only you see these." />
      {favorites.isLoading ? (
        <div className="space-y-3 p-5">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Star}
          title="No favorites yet"
          description="Star a client, document, asset, or password and it shows up here."
          action={
            <AppLink to="/clients" className="text-sm font-semibold text-primary hover:underline">
              Browse clients
            </AppLink>
          }
        />
      ) : (
        <div className="divide-y divide-border">
          {GROUPS.filter(([type]) => list.some((f) => f.type === type)).map(([type, label]) => (
            <section key={type} aria-label={label} className="px-3 py-2">
              <h3 className="px-2 pt-1 pb-1.5 text-xs font-bold tracking-wide text-muted uppercase">{label}</h3>
              <ul className="grid gap-1 sm:grid-cols-2">
                {list
                  .filter((f) => f.type === type)
                  .map((f) => (
                    <li key={`${f.type}-${f.id}`}>
                      <AppLink
                        to={itemHref(f)}
                        className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2"
                      >
                        <ItemIcon type={f.type} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{f.name}</span>
                          {type !== 'client' && (
                            <span className="block truncate text-xs text-muted">
                              {f.clientName ?? 'Knowledge base'}
                            </span>
                          )}
                        </span>
                      </AppLink>
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
