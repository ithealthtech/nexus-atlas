import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Library } from 'lucide-react';
import { GUIDE_AUDIENCES, GUIDE_AUDIENCE_LABELS, type TemplateView } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Badge, Button, FormError, Skeleton, useToast, Drawer } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

/** The knowledge base's library lists runbooks, then guides for each audience, under their own headings. */
const documentGroups = [
  { heading: 'Runbooks', match: (t: TemplateView) => t.kind === 'runbook' },
  ...GUIDE_AUDIENCES.map((a) => ({
    heading: `Guides for ${GUIDE_AUDIENCE_LABELS[a].toLowerCase()}s`,
    match: (t: TemplateView) => t.kind === 'guide' && t.audience === a,
  })),
];

/**
 * Built-in checklists, or runbooks and guides, for common MSP work. Adding one copies it into the MSP's checklists
 * or knowledge base, where the team edits it like their own.
 */
export function TemplateLibrary({ kind }: { kind: 'checklist' | 'runbook' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const library = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<TemplateView[]>('/templates'),
    enabled: open,
  });
  const items = library.data?.filter((t) => (kind === 'checklist' ? t.kind === 'checklist' : t.kind !== 'checklist'));
  const missing = items?.filter((t) => !t.addedId) ?? [];
  const noun = kind === 'checklist' ? 'checklist' : 'template';
  const groups =
    kind === 'checklist'
      ? [{ heading: null, items: items ?? [] }]
      : documentGroups.map((g) => ({ heading: g.heading, items: items?.filter(g.match) ?? [] }));
  const add = async (keys: string[], what: string) => {
    setBusy(keys.length === 1 ? keys[0]! : 'all');
    setError(null);
    try {
      queryClient.setQueryData(
        ['templates'],
        await api<TemplateView[]>('/templates', { method: 'POST', body: { keys } }),
      );
      await Promise.all(
        ['checklists', 'documents', 'folders'].map((k) => queryClient.invalidateQueries({ queryKey: [k] })),
      );
      toast(keys.length === 1 ? `${what} added.` : `${keys.length} ${noun}s added.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t add the templates. Try again.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Library /> Template library
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={kind === 'checklist' ? 'Checklist templates' : 'Runbooks and guides'}
        description={
          kind === 'checklist'
            ? 'Ready-made checklists for common MSP work. Adding one makes it your own to edit and run for any client.'
            : 'Ready-made runbooks go in the Runbooks folder, and how-to guides for technicians, clients and admins go in the Atlas guides folder, for you to edit. Clients don’t see the knowledge base, so share a client guide with its Share link.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              disabled={!missing.length}
              loading={busy === 'all'}
              onClick={() =>
                add(
                  missing.map((t) => t.key),
                  `All ${noun}s`,
                )
              }
            >
              Add all
            </Button>
          </>
        }
      >
        <FormError message={error} />
        {!items ? (
          <Skeleton className="h-40" />
        ) : (
          groups.map(
            (g) =>
              g.items.length > 0 && (
                <section key={g.heading ?? 'all'} aria-label={g.heading ?? undefined}>
                  {g.heading && (
                    <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-muted first:mt-0">
                      {g.heading}
                    </h3>
                  )}
                  <ul className="divide-y divide-border">
                    {g.items.map((t) => (
                      <li key={t.key} className="flex items-center gap-3 py-3 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{t.title}</p>
                          <p className="text-xs text-muted">
                            {t.size} {kind === 'checklist' ? 'steps' : 'sections'} · {t.description}
                          </p>
                        </div>
                        {t.addedId ? (
                          kind === 'runbook' ? (
                            <AppLink
                              to={`/documents/${t.addedId}`}
                              className="text-sm font-semibold text-primary hover:underline"
                            >
                              Open
                            </AppLink>
                          ) : (
                            <Badge tone="success">Added</Badge>
                          )
                        ) : (
                          <Button
                            variant="secondary"
                            size="sm"
                            loading={busy === t.key}
                            onClick={() => add([t.key], t.title)}
                          >
                            Add
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ),
          )
        )}
      </Drawer>
    </>
  );
}
