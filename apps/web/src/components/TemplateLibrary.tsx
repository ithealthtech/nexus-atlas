import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Library } from 'lucide-react';
import type { TemplateView } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Badge, Button, Dialog, FormError, Skeleton, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

/**
 * Built-in checklists or runbooks for common MSP work. Adding one copies it into the MSP's checklists or
 * knowledge base, where the team edits it like their own.
 */
export function TemplateLibrary({ kind }: { kind: TemplateView['kind'] }) {
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
  const items = library.data?.filter((t) => t.kind === kind);
  const missing = items?.filter((t) => !t.addedId) ?? [];
  const noun = kind === 'checklist' ? 'checklist' : 'runbook';
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
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="lg"
        title={kind === 'checklist' ? 'Checklist templates' : 'Runbook templates'}
        description={
          kind === 'checklist'
            ? 'Ready-made checklists for common MSP work. Adding one makes it your own to edit and run for any client.'
            : 'Ready-made runbooks for common MSP work. Adding one puts it in the Runbooks folder for you to edit.'
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
          <ul className="divide-y divide-border">
            {items.map((t) => (
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
                  <Button variant="secondary" size="sm" loading={busy === t.key} onClick={() => add([t.key], t.title)}>
                    Add
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </>
  );
}
