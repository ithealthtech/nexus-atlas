import {
  TeamsConnection,
  TeamsChannels,
  TeamsAlertPreferences,
  TeamsDeliveryHistory,
} from '@/components/teams/SettingsSections';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { teamsSettingsSchema, type TeamsSettingsView, type TeamsDelivery, type TeamsMapping } from '@atlas/shared';
import { Button, FormError, PageHeader, Skeleton, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';
import { useClients } from '@/lib/queries';

const BASE = '/integrations/teams';
export function TeamsSettingsPage() {
  const query = useQuery({ queryKey: ['teams-settings'], queryFn: () => api<TeamsSettingsView>(BASE) });
  return (
    <div className="space-y-6">
      <PageHeader title="Microsoft Teams" description="Client channels, discussions, and automatic alerts." />
      <FormError message={query.error?.message} />
      {query.data ? <TeamsForm initial={query.data} /> : query.isLoading && <Skeleton className="h-80" />}
    </div>
  );
}
function useTeamsEditor({ initial }: { initial: TeamsSettingsView }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState(() => teamsSettingsSchema.parse(initial));
  const [secret, setSecret] = useState('');
  const [reminders, setReminders] = useState(initial.reminderDays.join(', '));
  const [confirmRetry, setConfirmRetry] = useState<string | null>(null);
  const clients = useClients();
  const deliveries = useQuery({
    queryKey: ['teams-deliveries'],
    queryFn: () => api<TeamsDelivery[]>(BASE + '/deliveries'),
    refetchInterval: 30_000,
  });
  const { busy, error, act } = useAction();
  const reminderDays = reminders
    .split(',')
    .filter((v) => v.trim())
    .map((v) => Number(v.trim()));
  const dirty =
    !!secret || JSON.stringify({ ...form, reminderDays }) !== JSON.stringify(teamsSettingsSchema.parse(initial));
  const patchMapping = (index: number, value: Partial<TeamsMapping>) =>
    setForm((f) => ({ ...f, mappings: f.mappings.map((m, i) => (i === index ? { ...m, ...value } : m)) }));
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['teams-settings'] });
    await deliveries.refetch();
  };
  const save = () =>
    act('save', async () => {
      const saved = await api<TeamsSettingsView>(BASE, {
        method: 'PUT',
        body: { ...form, reminderDays, ...(secret ? { clientSecret: secret } : {}) },
      });
      setForm(teamsSettingsSchema.parse(saved));
      setReminders(saved.reminderDays.join(', '));
      setSecret('');
      await refresh();
      toast('Teams settings saved.');
    });
  return {
    form,
    setForm,
    secret,
    setSecret,
    reminders,
    setReminders,
    confirmRetry,
    setConfirmRetry,
    clients,
    deliveries,
    busy,
    error,
    act,
    patchMapping,
    refresh,
    save,
    toast,
    initial,
    dirty,
  };
}

export type TeamsEditor = ReturnType<typeof useTeamsEditor>;
function TeamsForm({ initial }: { initial: TeamsSettingsView }) {
  const editor = useTeamsEditor({ initial });
  const { busy, error, save } = editor;
  return (
    <>
      <TeamsConnection {...editor} />
      <TeamsChannels {...editor} />
      <TeamsAlertPreferences {...editor} />
      <FormError message={error} />
      <Button loading={busy === 'save'} disabled={!!busy} onClick={() => void save()}>
        Save Teams settings
      </Button>
      <TeamsDeliveryHistory {...editor} />
    </>
  );
}
