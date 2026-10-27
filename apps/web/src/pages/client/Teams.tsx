import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import type { TeamsPost, TeamsPostPage } from '@atlas/shared';
import { Button, Card, CardHeader, Field, FormError, PageHeader, Textarea, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useAction } from '@/lib/actions';

export function ClientTeams() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const base = `/clients/${clientId}/teams`;
  const info = useQuery({
    queryKey: ['client-teams', clientId],
    queryFn: () => api<{ name: string; canWrite: boolean }>(base),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Teams discussions"
        description={info.data?.name ?? 'Read and manage discussions in this client’s mapped channel.'}
      />
      <FormError message={info.error?.message} />
      {info.data && <Discussion key={clientId} base={base + '/posts'} canWrite={info.data.canWrite} />}
    </div>
  );
}
function Discussion({ base, canWrite, parentId }: { base: string; canWrite: boolean; parentId?: string }) {
  const path = parentId ? `${base}/${encodeURIComponent(parentId)}/replies` : base;
  const [cursor, setCursor] = useState<string | undefined>();
  const posts = useQuery({
    queryKey: ['teams-posts', path, cursor],
    queryFn: () => api<TeamsPostPage>(path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '')),
  });
  const [editing, setEditing] = useState<TeamsPost | null>(null);
  const [content, setContent] = useState('');
  const [thread, setThread] = useState<string | null>(null);
  const toast = useToast();
  const { busy, error, act } = useAction();
  const save = () =>
    act('save', async () => {
      await api(path + (editing ? `/${encodeURIComponent(editing.id)}` : ''), {
        method: editing ? 'PATCH' : 'POST',
        body: { content },
      });
      setContent('');
      setEditing(null);
      await posts.refetch();
      toast(editing ? 'Teams post updated.' : 'Posted to Teams.');
    });
  return (
    <div className="space-y-4">
      <FormError message={posts.error?.message} />
      {posts.isLoading && <p role="status">Loading Teams discussions…</p>}
      {posts.data?.posts.map((p) => (
        <Card key={p.id}>
          <CardHeader title={p.author} description={p.createdAt ? new Date(p.createdAt).toLocaleString() : undefined} />
          <div className="space-y-3 p-5">
            <p className="text-sm whitespace-pre-wrap break-words">{p.content}</p>
            <div className="flex gap-2">
              {p.canEdit && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditing(p);
                    setContent(p.content);
                  }}
                >
                  Edit post
                </Button>
              )}
              {!parentId && (
                <Button variant="ghost" onClick={() => setThread(thread === p.id ? null : p.id)}>
                  {thread === p.id ? 'Close discussion' : 'Read and reply'}
                </Button>
              )}
            </div>
            {thread === p.id && <Discussion base={base} parentId={p.id} canWrite={canWrite} />}
          </div>
        </Card>
      ))}
      {posts.data?.posts.length === 0 && (
        <p className="text-sm text-muted">No {parentId ? 'replies' : 'posts'} in this channel yet.</p>
      )}
      {posts.data?.cursor && (
        <Button variant="secondary" onClick={() => setCursor(posts.data?.cursor)}>
          Next page
        </Button>
      )}
      {cursor && (
        <Button variant="ghost" onClick={() => setCursor(undefined)}>
          Latest posts
        </Button>
      )}
      {canWrite && (
        <Card>
          <CardHeader title={editing ? 'Edit your Teams post' : parentId ? 'Reply in Teams' : 'New Teams post'} />
          <div className="space-y-3 p-5">
            <Field label={parentId ? 'Reply' : 'Post'}>
              {(p) => (
                <Textarea
                  {...p}
                  rows={5}
                  maxLength={12000}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              )}
            </Field>
            <p className="text-xs text-muted">
              Posts use the Microsoft account connected by your administrator. Atlas records who made each change.
            </p>
            <FormError message={error} />
            <Button disabled={!!busy || !content.trim()} loading={busy === 'save'} onClick={() => void save()}>
              {editing ? 'Save changes' : parentId ? 'Send reply' : 'Post to Teams'}
            </Button>
            {editing && (
              <Button
                variant="ghost"
                onClick={() => {
                  setEditing(null);
                  setContent('');
                }}
              >
                Cancel edit
              </Button>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
