import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Button, Dialog, Field, FormError, Input } from '@/components/ui';
import { onReauthRequired, api } from '@/lib/api';

/**
 * Asks for the account password when the server needs a fresh confirmation (changing people, groups,
 * email settings, passkeys, or exporting logs). The original request is retried after it succeeds.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    onReauthRequired(
      () =>
        new Promise<boolean>((resolve) => {
          pending.current?.(false);
          pending.current = resolve;
          setError(null);
          setOpen(true);
        }),
    );
    return () => onReauthRequired(null);
  }, []);

  const finish = (ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setOpen(false);
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setError(null);
    try {
      await api('/session/reauth', { method: 'POST', body: { password: new FormData(form).get('password') } });
      finish(true);
    } catch (err) {
      setError((err as Error).message);
      form.querySelector('input')?.select();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {children}
      <Dialog
        open={open}
        onClose={() => finish(false)}
        size="sm"
        title="Confirm it's you"
        description="This change affects security, so enter your password to continue."
        footer={
          <>
            <Button variant="secondary" onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button type="submit" form="reauth-form" loading={busy}>
              <ShieldCheck /> Confirm
            </Button>
          </>
        }
      >
        <form id="reauth-form" onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Your password" help="You won't be asked again for the next 10 minutes.">
            {(p) => <Input {...p} name="password" type="password" autoComplete="current-password" required autoFocus />}
          </Field>
          <FormError message={error} />
        </form>
      </Dialog>
    </>
  );
}
