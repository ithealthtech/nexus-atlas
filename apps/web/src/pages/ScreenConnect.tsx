import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MonitorUp } from 'lucide-react';
import type { ScreenConnectSettings } from '@atlas/shared';
import { Button, Card, CardHeader, Field, FormError, Input, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useSave } from '@/lib/queries';

/** The ScreenConnect address the desktop app's Connect button opens on a device. */
export function ScreenConnectSettingsCard() {
  const current = useQuery({
    queryKey: ['settings', 'screenconnect'],
    queryFn: () => api<ScreenConnectSettings>('/settings/screenconnect'),
  });
  if (!current.data)
    return (
      <Card className="p-5">
        <MonitorUp className="mb-3 size-5 text-muted" aria-hidden />
        <Skeleton className="h-32" />
      </Card>
    );
  return <ScreenConnectForm key={JSON.stringify(current.data)} current={current.data} />;
}

function ScreenConnectForm({ current }: { current: ScreenConnectSettings }) {
  const toast = useToast();
  const [form, setForm] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const save = useSave(
    (body: object) => api<ScreenConnectSettings>('/settings/screenconnect', { method: 'PUT', body }),
    [['settings', 'screenconnect']],
  );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      const saved = await save.mutateAsync(form);
      toast(saved.url ? 'ScreenConnect saved. Atlas for Windows shows Connect on devices.' : 'Connect turned off.');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Card>
      <CardHeader
        title="ScreenConnect"
        description="Atlas for Windows shows Connect on devices. It joins the device's session when the asset has a field holding its ScreenConnect session ID, and otherwise opens ScreenConnect searching for the device by name. Leave the address blank to turn Connect off."
      />
      <form onSubmit={submit} className="space-y-5 p-5" noValidate>
        <Field label="ScreenConnect address" help="The address you sign in to ScreenConnect at.">
          {(props) => (
            <Input
              {...props}
              type="url"
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
              placeholder="https://yourcompany.screenconnect.com"
            />
          )}
        </Field>
        <Field label="Session group" help="The Access session group your machines are listed under.">
          {(props) => (
            <Input {...props} value={form.group} onChange={(e) => setForm((f) => ({ ...f, group: e.target.value }))} />
          )}
        </Field>
        <FormError message={error} />
        <div className="flex justify-end">
          <Button type="submit" loading={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  );
}
