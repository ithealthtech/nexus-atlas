import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TicketReplies, TicketView } from '@atlas/shared';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';
import { relativeTime } from '@/lib/format';
import { Button, Drawer, Field, FormError, Input, Skeleton, Textarea, useToast } from './ui';

/**
 * The form for opening a ConnectWise ticket for a client, as a client portal user (or a tech) would. The ticket
 * appears in the client's ticket list straight away; ConnectWise's next sync fills in the rest.
 */
export function NewTicketDrawer({ clientId, open, onClose }: { clientId: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const { busy, error, setError, act } = useAction();
  const close = () => {
    setError(null);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act('open', async () => {
      const ticket = await api<TicketView>(`/clients/${clientId}/tickets`, {
        method: 'POST',
        body: { summary, details },
      });
      await qc.invalidateQueries({ queryKey: ['tickets'] });
      setSummary('');
      setDetails('');
      toast(`Ticket #${ticket.number} opened. Your IT team has it.`);
      onClose();
    });
  };
  return (
    <Drawer
      open={open}
      onClose={close}
      title="New ticket"
      description="Ask your IT team for help. The ticket goes straight to their service board."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="new-ticket" disabled={busy !== null || !summary.trim() || !details.trim()}>
            {busy ? 'Opening…' : 'Open ticket'}
          </Button>
        </>
      }
    >
      <form id="new-ticket" onSubmit={submit} className="space-y-4">
        <Field label="Summary" help="One line, such as “Printer in reception is offline”.">
          {(p) => (
            <Input {...p} value={summary} maxLength={200} required onChange={(e) => setSummary(e.target.value)} />
          )}
        </Field>
        <Field
          label="Details"
          help="What happened, who it affects, and anything you already tried. Never include passwords."
        >
          {(p) => (
            <Textarea
              {...p}
              value={details}
              maxLength={8000}
              rows={8}
              required
              onChange={(e) => setDetails(e.target.value)}
            />
          )}
        </Field>
        <FormError message={error} />
      </form>
    </Drawer>
  );
}

/**
 * A ticket's conversation: the replies ConnectWise marks visible to all (never internal notes), oldest first, and a
 * box to answer when portal tickets are on. Text is escaped.
 */
export function TicketConversation({ ticketId }: { ticketId: string }) {
  const key = ['tickets', 'replies', ticketId];
  const qc = useQueryClient();
  const replies = useQuery({ queryKey: key, queryFn: () => api<TicketReplies>(`/tickets/${ticketId}/replies`) });
  const [text, setText] = useState('');
  const { busy, error, act } = useAction();
  const send = (e: FormEvent) => {
    e.preventDefault();
    void act('reply', async () => {
      await api(`/tickets/${ticketId}/replies`, { method: 'POST', body: { text } });
      // Sent: clear the box before reloading, so a failed reload never invites sending it twice.
      setText('');
      await qc.invalidateQueries({ queryKey: key });
    });
  };
  if (replies.isPending) return <Skeleton className="h-10" />;
  if (replies.isError) return <FormError message={replies.error.message} />;
  return (
    <div className="space-y-2">
      {replies.data.replies.length ? (
        <ol className="space-y-2" aria-label="Replies">
          {replies.data.replies.map((r) => (
            <li key={r.id} className="rounded-md border border-border p-2">
              <p className="text-xs text-muted">
                {r.createdBy || 'Your IT team'}
                {r.createdAt && ` · ${relativeTime(r.createdAt)}`}
              </p>
              <p className="whitespace-pre-wrap break-words text-text">{r.text}</p>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-muted">No replies yet.</p>
      )}
      {replies.data.canReply && (
        <form onSubmit={send} className="space-y-2">
          <Textarea
            aria-label="Your reply"
            placeholder="Write a reply your IT team will see on the ticket"
            value={text}
            maxLength={4000}
            rows={2}
            onChange={(e) => setText(e.target.value)}
          />
          <FormError message={error} />
          <Button type="submit" size="sm" disabled={busy !== null || !text.trim()}>
            Send reply
          </Button>
        </form>
      )}
    </div>
  );
}
