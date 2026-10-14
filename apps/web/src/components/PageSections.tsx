import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Entry = { id: string; title: string };

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * A long page of settings, with its contents down the left. The contents are read from the page itself: each
 * section's own heading, so a section added later shows up without being listed anywhere. The one in view is
 * marked as you scroll, and choosing one scrolls to it.
 */
export function PageSections({ children, className }: { children: ReactNode; className?: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [current, setCurrent] = useState<string | null>(null);

  // Sections load at their own pace (a skeleton first, then the card), so watch for headings appearing.
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const read = () => {
      const found: Entry[] = [];
      for (const section of Array.from(root.children) as HTMLElement[]) {
        const heading = section.querySelector('h2');
        const title = heading?.textContent?.trim();
        if (!title) continue;
        let id = section.id || `section-${slug(title)}`;
        while (found.some((e) => e.id === id)) id += '-2';
        section.id = id;
        section.classList.add('scroll-mt-8', 'lg:in-data-[menu=top]:scroll-mt-32');
        found.push({ id, title });
      }
      setEntries((before) => (JSON.stringify(before) === JSON.stringify(found) ? before : found));
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, []);

  // The section nearest the top of the screen is the one you're reading.
  useEffect(() => {
    if (!entries.length) return;
    const seen = new Map<string, boolean>();
    const watch = new IntersectionObserver(
      (changes) => {
        for (const c of changes) seen.set(c.target.id, c.isIntersecting);
        setCurrent(entries.find((e) => seen.get(e.id))?.id ?? null);
      },
      { rootMargin: '-80px 0px -60% 0px' },
    );
    for (const e of entries) {
      const el = document.getElementById(e.id);
      if (el) watch.observe(el);
    }
    return () => watch.disconnect();
  }, [entries]);

  return (
    <div className={cn('grid gap-10 lg:grid-cols-[11.5rem_minmax(0,1fr)]', className)}>
      <nav aria-label="On this page" className="hidden lg:block">
        {entries.length > 1 && (
          <ul className="sticky top-8 space-y-px border-l border-border in-data-[menu=top]:top-32">
            {entries.map((e) => (
              <li key={e.id}>
                <a
                  href={`#${e.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById(e.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    setCurrent(e.id);
                  }}
                  aria-current={current === e.id ? 'location' : undefined}
                  className={cn(
                    '-ml-px block border-l-2 py-1.5 pl-3.5 text-[13px] leading-snug text-muted hover:text-text',
                    current === e.id ? 'border-primary font-medium text-text' : 'border-transparent',
                  )}
                >
                  {e.title}
                </a>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div ref={body} className="grid max-w-3xl min-w-0 gap-6">
        {children}
      </div>
    </div>
  );
}
