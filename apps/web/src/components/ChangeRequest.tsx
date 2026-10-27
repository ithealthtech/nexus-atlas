import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Drawer, Field, FormError, Input, Textarea, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

/** Asks the team for a change at a client: a new shared mailbox, a printer moved, a door code updated. */
export function ChangeRequestDialog({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    try {
      await api(`/clients/${clientId}/change-requests`, {
        method: 'POST',
        body: { summary: form.summary, details: form.details, date: form.date || null },
      });
      await queryClient.invalidateQueries({ queryKey: ['activity'] });
      toast('Request sent to the team.');
      onClose();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title="Request a change"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="change-request" loading={busy}>
            Send request
          </Button>
        </>
      }
    >
      <form id="change-request" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="What do you need?" error={error?.fields?.summary}>
          {(p) => (
            <Input
              {...p}
              name="summary"
              required
              autoFocus
              maxLength={150}
              placeholder="e.g. A shared mailbox for sales"
            />
          )}
        </Field>
        <Field label="Details" help="Who it's for, what it should do, anything the team should know.">
          {(p) => <Textarea {...p} name="details" rows={5} maxLength={2000} />}
        </Field>
        <Field label="Needed by" help="Optional." error={error?.fields?.date}>
          {(p) => <Input {...p} name="date" type="date" />}
        </Field>
        <FormError message={error && !error.fields ? error.message : null} />
      </form>
    </Drawer>
  );
}
