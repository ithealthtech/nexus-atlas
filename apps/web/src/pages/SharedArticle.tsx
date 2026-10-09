import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { FileQuestion, Printer } from 'lucide-react';
import type { SharedArticle as ArticleData } from '@atlas/shared';
import { Logo } from '@/components/Logo';
import { RichTextView } from '@/components/RichText';
import { Button, Card, Skeleton } from '@/components/ui';
import { DEMO } from '@/lib/demo';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';

/**
 * Public page for a document shared by link. No account is needed and none is offered: the reader gets the
 * article and nothing else.
 */
export function SharedArticle() {
  const { token } = useParams({ strict: false }) as { token: string };
  // A different link is a different page: nothing carries over from the last one.
  return <Article key={token} token={token} />;
}

function Article({ token }: { token: string }) {
  const [article, setArticle] = useState<ArticleData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Shared links shouldn't turn up in search results.
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.append(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    let live = true;
    const load = DEMO
      ? api<ArticleData>(`/shared-articles/${encodeURIComponent(token)}`)
      : fetch(`/api/shared-articles/${encodeURIComponent(token)}`, { credentials: 'omit' }).then(async (res) => {
          const data = await res.json().catch(() => null);
          if (!res.ok) throw new Error(data?.error ?? 'This link could not be opened.');
          return data as ArticleData;
        });
    load.then(
      (data) => {
        if (!live) return;
        setArticle(data);
        document.title = data.title;
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <main id="main" className="min-h-screen bg-bg px-4 py-10 print:bg-white print:py-0">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
          <Logo />
          {article && (
            <Button variant="secondary" size="sm" onClick={() => window.print()}>
              <Printer /> Print
            </Button>
          )}
        </div>
        {error ? (
          <Card className="flex flex-col items-center px-6 py-14 text-center">
            <span className="mb-4 grid size-12 place-items-center rounded-xl bg-surface-3 text-text-2">
              <FileQuestion className="size-6" aria-hidden />
            </span>
            <h1 className="text-lg font-semibold">This article isn&rsquo;t available</h1>
            <p className="mt-1 max-w-sm text-sm text-muted">{error} Ask whoever sent it for a new link.</p>
          </Card>
        ) : !article ? (
          <Skeleton className="h-80" />
        ) : (
          <article>
            <Card className="px-6 py-7 sm:px-10 sm:py-9 print:border-0 print:p-0 print:shadow-none">
              <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{article.title}</h1>
              <p className="mt-2 mb-6 border-b border-border pb-5 text-sm text-muted">
                From {article.organization} · updated {formatDate(article.updatedAt)}
              </p>
              <RichTextView content={article.content} label={article.title} />
            </Card>
          </article>
        )}
      </div>
    </main>
  );
}
