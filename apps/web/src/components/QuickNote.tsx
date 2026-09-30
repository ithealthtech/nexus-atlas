import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { History, Pencil, StickyNote } from 'lucide-react';
import { atLeast, type ClientSummary } from '@atlas/shared';
import { api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { Button, Card, Dialog, FormError, Textarea, useToast } from './ui';
import { RevisionsPanel } from './panels';

/**
 * The client's quick note ("Call before touching the firewall") at the top of its workspace, with who changed it
 * last and when. Editing saves a new version; History shows and restores earlier ones.
 */
export function QuickNote({ client }: { client: ClientSummary }) {
  const canEdit = atLeast(client.access, 'edit');
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['clients'] }),
      queryClient.invalidateQueries({ queryKey: ['revisions', 'client-notes', client.id] }),
    ]);
  if (!client.notes && !editing) {
    if (!canEdit) return null;
    return (
      <div className="mb-5">
        <Button variant="link" size="sm" onClick={() => setEditing(true)}>
          <StickyNote /> Add a quick note for technicians
        </Button>
      </div>
    );
  }
  return (
    <Card className="mb-5 border-warning/40 bg-warning-soft/40 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-xs font-bold tracking-wide text-warning uppercase">Quick note</p>
        {!editing && (
          <div className="-my-1 flex gap-1">
            {client.notesVersion > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>
                <History /> History
              </Button>
            )}
            {canEdit && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <NoteEditor
          client={client}
          onDone={async (saved) => {
            if (saved) await refresh();
            setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-text-2">{client.notes}</p>
          {client.notesUpdatedAt && (
            <p className="mt-2 text-xs text-muted">
              Edited {relativeTime(client.notesUpdatedAt)}
              {client.notesUpdatedByName && ` by ${client.notesUpdatedByName}`} · Version {client.notesVersion}
            </p>
          )}
        </>
      )}
      {history && (
        <Dialog open onClose={() => setHistory(false)} size="lg" title="Quick note history">
          <RevisionsPanel
            kind="client-notes"
            id={client.id}
            currentVersion={client.notesVersion}
            canEdit={canEdit}
            toText={(s) => (s as { notes?: string }).notes ?? ''}
            onRestored={() => {
              void refresh();
              setHistory(false);
            }}
          />
        </Dialog>
      )}
    </Card>
  );
}

function NoteEditor({ client, onDone }: { client: ClientSummary; onDone: (saved: boolean) => void }) {
  const [text, setText] = useState(client.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // The version it was edited from: if someone else saved since, the server refuses rather than overwrite.
      await api(`/clients/${client.id}`, {
        method: 'PATCH',
        body: { notes: text.trim(), notesVersion: client.notesVersion },
      });
      toast('Quick note saved.');
      onDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-3">
      <Textarea
        aria-label="Quick note"
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        maxLength={5000}
        rows={3}
        autoFocus
        placeholder="For example: Call the office manager before touching the firewall."
      />
      <p className="text-xs text-muted">Shown to everyone who opens this client. Don’t put passwords here.</p>
      <FormError message={error} />
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} loading={busy}>
          Save note
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
