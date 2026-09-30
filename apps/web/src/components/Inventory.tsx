import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClientSoftware, DeviceInventory, DeviceSoftware, SoftwareFlag } from '@atlas/shared';
import { api } from '@/lib/api';
import { formatDate, relativeTime } from '@/lib/format';
import { Badge, Card, CardHeader, Dialog, Input, Skeleton, type Tone } from './ui';

const FLAG: Record<SoftwareFlag, { label: string; tone: Tone }> = {
  end_of_life: { label: 'Out of support', tone: 'danger' },
  unlicensed: { label: 'No license', tone: 'warning' },
  over_seats: { label: 'Over seats', tone: 'warning' },
};
// Lists longer than this are cut short on the page, with the rest a click away.
const SHORT = 10;

function FlagBadge({ flag, reason }: { flag: SoftwareFlag | null; reason: string }) {
  if (!flag) return null;
  return (
    <Badge tone={FLAG[flag].tone} title={reason}>
      {FLAG[flag].label}
    </Badge>
  );
}

const matches = (q: string, ...values: string[]) => !q || values.some((v) => v.toLowerCase().includes(q));

/** Rows of software: name and publisher, version(s), and a flag badge with its reason. */
function SoftwareTable({
  rows,
  columns,
}: {
  rows: {
    key: string;
    name: string;
    publisher: string;
    detail: string;
    flag: SoftwareFlag | null;
    flagReason: string;
  }[];
  columns: [string, string];
}) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th scope="col" className="pb-2 font-medium">
            {columns[0]}
          </th>
          <th scope="col" className="pb-2 font-medium">
            {columns[1]}
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="py-2 pr-3">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {r.name} <FlagBadge flag={r.flag} reason={r.flagReason} />
              </span>
              {(r.publisher || r.flagReason) && (
                <span className="block text-xs text-muted">{r.flagReason || r.publisher}</span>
              )}
            </td>
            <td className="py-2 text-text-2 tabular-nums">{r.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Everything in a list, searchable, in a dialog. */
function AllDialog<T>({
  open,
  onClose,
  title,
  items,
  search,
  render,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: T[];
  search: (item: T, q: string) => boolean;
  render: (items: T[]) => React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const shown = items.filter((i) => search(i, q.trim().toLowerCase()));
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={title} description={`${items.length} applications.`}>
      <Input
        placeholder="Filter by name or publisher"
        aria-label="Filter applications"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="mb-3"
      />
      {render(shown)}
    </Dialog>
  );
}

const appRows = (list: DeviceSoftware[]) =>
  list.map((a) => ({
    key: `${a.name}|${a.version}`,
    name: a.name,
    publisher: a.publisher,
    detail: a.version || '—',
    flag: a.flag,
    flagReason: a.flagReason,
  }));

/** A device's installed software and who signs in to it, as the RMM last reported them. Hidden when it hasn't. */
export function DeviceInventoryCards({ assetId }: { assetId: string }) {
  const inventory = useQuery({
    queryKey: ['inventory', assetId],
    queryFn: () => api<DeviceInventory | null>(`/assets/${assetId}/inventory`),
  });
  const [all, setAll] = useState(false);
  const data = inventory.data;
  if (inventory.isLoading) return <Skeleton className="h-40" />;
  if (!data) return null;
  const software = [...data.software].sort((a, b) => Number(!a.flag) - Number(!b.flag) || a.name.localeCompare(b.name));
  const flagged = software.filter((a) => a.flag).length;
  return (
    <>
      {data.signIns.length > 0 && (
        <Card>
          <CardHeader title="Who signs in" description={`From ConnectWise RMM, ${relativeTime(data.updatedAt)}.`} />
          <ul className="divide-y divide-border">
            {data.signIns.map((u) => (
              <li key={u.username} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <span className="min-w-0">
                  <span className="font-medium">{u.domain ? `${u.domain}\\${u.username}` : u.username}</span>
                  {u.contactName && <span className="text-text-2"> · {u.contactName}</span>}
                </span>
                <span className="text-xs text-muted">
                  {u.lastLogonAt ? `Last signed in ${formatDate(u.lastLogonAt)}` : 'Signed in'}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        <CardHeader
          title="Installed software"
          description={
            software.length
              ? `${software.length} applications${flagged ? `, ${flagged} flagged` : ''}. From ConnectWise RMM, ${relativeTime(data.updatedAt)}.`
              : 'ConnectWise RMM reported no applications.'
          }
          actions={
            software.length > SHORT ? (
              <button
                type="button"
                onClick={() => setAll(true)}
                className="text-sm font-semibold text-primary hover:underline"
              >
                View all
              </button>
            ) : undefined
          }
        />
        {software.length > 0 && (
          <div className="px-5 py-3">
            <SoftwareTable rows={appRows(software.slice(0, SHORT))} columns={['Application', 'Version']} />
          </div>
        )}
      </Card>
      <AllDialog
        open={all}
        onClose={() => setAll(false)}
        title="Installed software"
        items={software}
        search={(a, q) => matches(q, a.name, a.publisher)}
        render={(list) => <SoftwareTable rows={appRows(list)} columns={['Application', 'Version']} />}
      />
    </>
  );
}

const clientRows = (list: ClientSoftware[]) =>
  list.map((a) => ({
    key: a.name,
    name: a.name,
    publisher: a.publisher,
    detail: `${a.devices} device${a.devices === 1 ? '' : 's'}`,
    flag: a.flag,
    flagReason: a.flagReason,
  }));

/**
 * Software across the client's devices, flagged applications first: out of support, paid with no license record,
 * or on more devices than the license records have seats. Hidden until the RMM has reported software.
 */
export function SoftwareCard({ clientId }: { clientId: string }) {
  const software = useQuery({
    queryKey: ['software', clientId],
    queryFn: () => api<ClientSoftware[]>(`/clients/${clientId}/software`),
  });
  const [all, setAll] = useState(false);
  const list = software.data ?? [];
  if (!list.length) return null;
  const flagged = list.filter((a) => a.flag);
  return (
    <Card>
      <CardHeader
        title="Software"
        description={
          flagged.length
            ? `${list.length} applications on this client's devices. ${flagged.length} need a look.`
            : `${list.length} applications on this client's devices. None flagged.`
        }
        actions={
          <button
            type="button"
            onClick={() => setAll(true)}
            className="text-sm font-semibold text-primary hover:underline"
          >
            View all
          </button>
        }
      />
      <div className="px-5 py-3">
        <SoftwareTable
          rows={clientRows((flagged.length ? flagged : list).slice(0, SHORT))}
          columns={['Application', 'Installed on']}
        />
        {flagged.length > SHORT && (
          <p className="pt-2 text-xs text-muted">And {flagged.length - SHORT} more flagged. View all to see them.</p>
        )}
      </div>
      <AllDialog
        open={all}
        onClose={() => setAll(false)}
        title="Software"
        items={list}
        search={(a, q) => matches(q, a.name, a.publisher)}
        render={(rows) => <SoftwareTable rows={clientRows(rows)} columns={['Application', 'Installed on']} />}
      />
    </Card>
  );
}
