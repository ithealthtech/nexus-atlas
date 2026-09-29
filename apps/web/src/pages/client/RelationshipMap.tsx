import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { Share2 } from 'lucide-react';
import type { ItemRef, RelationshipMap as MapData } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { ItemIcon, itemHref } from '@/components/ItemIcon';
import { Card, EmptyState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';

const COLUMNS: { type: ItemRef['type']; label: string }[] = [
  { type: 'location', label: 'Locations' },
  { type: 'asset', label: 'Assets' },
  { type: 'password', label: 'Passwords' },
  { type: 'document', label: 'Documents' },
  { type: 'contact', label: 'Contacts' },
];
const COL_W = 220;
const NODE_W = 184;
const ROW_H = 52;
const TOP = 32;

const keyOf = (n: Pick<ItemRef, 'type' | 'id'>) => `${n.type}:${n.id}`;

/** How a client's documentation connects: items in columns by type, with a line for each link. */
export function ClientRelationshipMap() {
  const { clientId } = useParams({ strict: false }) as { clientId: string };
  const { data, isLoading } = useQuery({
    queryKey: ['relationships', clientId],
    queryFn: () => api<MapData>(`/clients/${clientId}/relationships`),
  });
  const [selected, setSelected] = useState<string | null>(null);

  const layout = useMemo(() => {
    if (!data) return null;
    // Knowledge-base articles linked from this client sit in the documents column.
    const columns = COLUMNS.map((c) => ({ ...c, nodes: data.nodes.filter((n) => n.type === c.type) })).filter(
      (c) => c.nodes.length,
    );
    const pos = new Map<string, { x: number; y: number; node: ItemRef }>();
    columns.forEach((c, ci) =>
      c.nodes.forEach((node, ri) => pos.set(keyOf(node), { x: ci * COL_W, y: TOP + ri * ROW_H, node })),
    );
    const rows = Math.max(0, ...columns.map((c) => c.nodes.length));
    const neighbors = new Map<string, Set<string>>();
    for (const e of data.edges) {
      neighbors.set(e.from, (neighbors.get(e.from) ?? new Set()).add(e.to));
      neighbors.set(e.to, (neighbors.get(e.to) ?? new Set()).add(e.from));
    }
    return {
      columns,
      pos,
      neighbors,
      width: Math.max(NODE_W, columns.length * COL_W - (COL_W - NODE_W)),
      height: TOP + rows * ROW_H,
    };
  }, [data]);

  if (isLoading || !data || !layout) return <Skeleton className="h-80" />;
  if (!data.edges.length)
    return (
      <Card>
        <EmptyState
          icon={Share2}
          title="Nothing is linked yet"
          description="Link assets, documents, passwords, contacts, and locations to each other from their Related panel, and the map shows how they connect."
        />
      </Card>
    );

  const near = selected ? layout.neighbors.get(selected) : undefined;
  const lit = (k: string) => !selected || k === selected || !!near?.has(k);
  const selectedNode = selected ? layout.pos.get(selected)?.node : undefined;

  return (
    <div className="space-y-5">
      <Card>
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">Relationship map</h2>
          <p className="text-sm text-muted">
            {data.nodes.length} linked items and {data.edges.length} links. Select an item to highlight what it connects
            to.
          </p>
        </div>
        <div className="overflow-x-auto p-5">
          <div className="relative" style={{ width: layout.width, height: layout.height }}>
            <svg
              className="pointer-events-none absolute inset-0"
              width={layout.width}
              height={layout.height}
              aria-hidden
            >
              {data.edges.map((e) => {
                const a = layout.pos.get(e.from);
                const b = layout.pos.get(e.to);
                if (!a || !b) return null;
                const [l, r] = a.x <= b.x ? [a, b] : [b, a];
                const y1 = l.y + 20;
                const y2 = r.y + 20;
                let d: string;
                if (l.x === r.x) {
                  // Two items of the same kind: loop out to the right of the column.
                  const x = l.x + NODE_W;
                  d = `M${x},${y1} C${x + 36},${y1} ${x + 36},${y2} ${x},${y2}`;
                } else {
                  const x1 = l.x + NODE_W;
                  const x2 = r.x;
                  const bend = (x2 - x1) / 2;
                  d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
                }
                const on = !!selected && (e.from === selected || e.to === selected);
                return (
                  <path
                    key={e.id}
                    d={d}
                    fill="none"
                    className={cn(on ? 'stroke-primary' : 'stroke-border', selected && !on && 'opacity-30')}
                    strokeWidth={on ? 2 : 1.5}
                  />
                );
              })}
            </svg>
            {layout.columns.map((c, ci) => (
              <p
                key={c.type}
                className="absolute text-xs font-semibold tracking-wide text-muted uppercase"
                style={{ left: ci * COL_W, top: 0 }}
              >
                {c.label}
              </p>
            ))}
            {[...layout.pos.entries()].map(([k, { x, y, node }]) => (
              <button
                key={k}
                type="button"
                aria-pressed={selected === k}
                onClick={() => setSelected(selected === k ? null : k)}
                className={cn(
                  'absolute flex h-10 items-center gap-2 rounded-lg border bg-surface px-2 text-left text-sm transition-opacity focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none',
                  selected === k ? 'border-primary' : 'border-border hover:border-text-2',
                  !lit(k) && 'opacity-40',
                )}
                style={{ left: x, top: y, width: NODE_W }}
              >
                <ItemIcon type={node.type} className="size-6" />
                <span className="min-w-0 truncate">{node.title}</span>
              </button>
            ))}
          </div>
        </div>
        {selectedNode && (
          <div className="border-t border-border px-5 py-4 text-sm">
            <AppLink to={itemHref(selectedNode)} className="font-semibold text-primary hover:underline">
              Open {selectedNode.title}
            </AppLink>{' '}
            <span className="text-muted">
              · linked to {near?.size ?? 0} {near?.size === 1 ? 'item' : 'items'}
            </span>
          </div>
        )}
      </Card>

      <Card>
        <div className="border-b border-border px-5 py-4">
          <h2 className="font-semibold">All links</h2>
          <p className="text-sm text-muted">The same links as a list.</p>
        </div>
        <ul className="divide-y divide-border">
          {data.edges.map((e) => {
            const a = layout.pos.get(e.from)?.node;
            const b = layout.pos.get(e.to)?.node;
            if (!a || !b) return null;
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                <End node={a} />
                <span className="text-muted">
                  <span aria-hidden>↔</span>
                  <span className="sr-only">linked to</span>
                </span>
                <End node={b} />
                {e.note && <span className="basis-full text-xs text-muted">{e.note}</span>}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

function End({ node }: { node: ItemRef }) {
  return (
    <AppLink to={itemHref(node)} className="inline-flex min-w-0 items-center gap-2 hover:underline">
      <ItemIcon type={node.type} className="size-6" />
      <span className="truncate">{node.title}</span>
      <span className="text-xs text-muted">{node.subtitle}</span>
    </AppLink>
  );
}
