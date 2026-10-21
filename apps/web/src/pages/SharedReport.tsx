import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Download, FileQuestion } from 'lucide-react';
import { reportNeedsAttention, type SharedReport as ReportData } from '@atlas/shared';
import { Logo } from '@/components/Logo';
import { ReportCell, figureColumns, reportBodyCell, reportHeadCell } from '@/components/ReportTable';
import { Card, PanelHeader, Skeleton } from '@/components/ui';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';

/** How many rows the page shows of a section; the PDF has them all (up to its own limit). */
const SHOWN_ROWS = 1000;

/**
 * Public page for a report shared by link. No account is needed and none is offered: the reader gets this one
 * snapshot, as it was captured: every section on the page, and a PDF of all of it.
 */
export function SharedReport() {
  const { token } = useParams({ strict: false }) as { token: string };
  // A different link is a different page: nothing carries over from the last one.
  return <Report key={token} token={token} />;
}

function Report({ token }: { token: string }) {
  const [report, setReport] = useState<ReportData | null>(null);
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
    fetch(`/api/shared-reports/${encodeURIComponent(token)}`, { credentials: 'omit' })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? 'This link could not be opened.');
        return data as ReportData;
      })
      .then(
        (data) => {
          if (!live) return;
          setReport(data);
          document.title = `${data.title} · ${data.client}`;
        },
        (e: Error) => live && setError(e.message),
      );
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <main id="main" className="min-h-screen bg-bg px-4 py-10">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <Logo />
          {report && (
            <div className="flex flex-wrap justify-end gap-2">
              <a
                href={`/api/shared-reports/${encodeURIComponent(token)}/pdf?section=${report.sections.length > 1 ? 'all' : 0}`}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-3 [&_svg]:size-4"
              >
                <Download aria-hidden /> Download PDF
              </a>
            </div>
          )}
        </div>
        {error ? (
          <Card className="flex flex-col items-center px-6 py-14 text-center">
            <span className="mb-4 grid size-12 place-items-center rounded-xl bg-surface-3 text-text-2">
              <FileQuestion className="size-6" aria-hidden />
            </span>
            <h1 className="text-lg font-semibold">This report isn&rsquo;t available</h1>
            <p className="mt-1 max-w-sm text-sm text-muted">{error} Ask whoever sent it for a new link.</p>
          </Card>
        ) : !report ? (
          <Skeleton className="h-80" />
        ) : (
          <article className="space-y-5">
            <header>
              <h1 className="text-[28px] leading-tight font-semibold tracking-tight">{report.title}</h1>
              <p className="mt-1.5 text-sm text-muted">
                {report.client} · from {report.organization} · captured {formatDateTime(report.generatedAt)}
              </p>
            </header>
            {report.warnings.length > 0 && (
              <div className="rounded-md border border-warning/40 bg-warning-soft px-4 py-3 text-sm text-warning">
                <h2 className="font-semibold">Notes on this report</h2>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed">
                  {report.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
            {report.sections.map((current, index) => {
              const figures = figureColumns(current.columns, current.rows);
              return (
                <Card key={index} className="overflow-hidden p-0">
                  <PanelHeader
                    eyebrow={current.part}
                    title={current.title}
                    description={`${current.rows.length.toLocaleString()} ${current.rows.length === 1 ? 'row' : 'rows'}`}
                  />
                  {current.rows.length > 0 ? (
                    <div className="max-h-[70vh] overflow-auto" role="region" aria-label={current.title} tabIndex={0}>
                      <table className="w-full border-separate border-spacing-0 text-left">
                        <thead className="sticky top-0 z-[1]">
                          <tr>
                            {current.columns.map((c, i) => (
                              <th key={i} scope="col" className={cn(reportHeadCell, figures.has(i) && 'text-right')}>
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {current.rows.slice(0, SHOWN_ROWS).map((row, i) => (
                            <tr key={i} className="group">
                              {row.map((_, j) => (
                                <td
                                  key={j}
                                  className={cn(
                                    reportBodyCell,
                                    'max-w-80 min-w-28 border-b border-border break-words group-last:border-b-0',
                                    j === 0 && 'font-semibold',
                                    // A row that may need attention carries an amber edge.
                                    j === 0 &&
                                      reportNeedsAttention(current, row) &&
                                      'shadow-[inset_3px_0_0_var(--warning)]',
                                    figures.has(j) && 'text-right whitespace-nowrap tabular-nums',
                                  )}
                                >
                                  <ReportCell columns={current.columns} row={row} index={j} />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="px-[21px] py-6 text-sm text-muted">Nothing to list.</p>
                  )}
                  {current.rows.length > SHOWN_ROWS && (
                    <p className="border-t border-border px-5 py-3 text-xs text-muted">
                      Showing the first {SHOWN_ROWS.toLocaleString()} of {current.rows.length.toLocaleString()} rows.
                      The PDF has them all.
                    </p>
                  )}
                </Card>
              );
            })}
            <details className="text-xs text-muted">
              <summary className="cursor-pointer font-semibold">Sources and coverage</summary>
              <ul className="mt-2 space-y-1">
                {report.sources.map((s, i) => (
                  <li key={i}>
                    <span className="font-medium text-text-2">{s.name}</span> · updated{' '}
                    {s.updatedAt ? formatDateTime(s.updatedAt) : 'not available'} · {s.detail}
                  </li>
                ))}
              </ul>
              <p className="mt-2">
                Rows marked in amber may need attention. This is a snapshot of the records available when it was
                captured; missing data is not evidence that everything is fine.
              </p>
            </details>
            <p className="text-xs text-muted">This link stops working on {formatDate(report.expiresAt)}.</p>
          </article>
        )}
      </div>
    </main>
  );
}
