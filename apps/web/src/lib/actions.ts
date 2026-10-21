import { useState } from 'react';
import { useToast } from '@/components/ui';

/**
 * The buttons of a page or dialog, one action at a time: which one is busy (for its spinner), and what went wrong.
 * By default the error is kept for the page to show with `FormError`; with `toast`, it pops up instead. `after`
 * runs once an action has succeeded, usually to refetch what it changed.
 */
export function useAction({
  toast: toastErrors = false,
  after,
}: { toast?: boolean; after?: () => Promise<unknown> } = {}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await work();
      await after?.();
    } catch (err) {
      if (toastErrors) toast((err as Error).message, 'error');
      else setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, act };
}
