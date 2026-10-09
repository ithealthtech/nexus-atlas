import { useEffect, useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { ArrowLeft, Printer, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import type { AssetView } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Button, Card, EmptyState, PageHeader, Select, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';
import { DEMO } from '@/lib/demo';
import { useAsset, useAssets, useLayouts } from '@/lib/queries';

const MAX_LABELS = 300;
// Printed sizes, in millimetres: common address-label stock, and a small one for laptops and phones.
const SIZES = {
  standard: { label: 'Standard (63 × 38 mm)', width: 63, height: 38, qr: 30 },
  small: { label: 'Small (50 × 25 mm)', width: 50, height: 25, qr: 21 },
  large: { label: 'Large (100 × 50 mm)', width: 100, height: 50, qr: 42 },
} as const;
type Size = keyof typeof SIZES;

/** Where scanning a label goes: the asset's page in this Atlas. It shows nothing until the person signs in. */
export const assetAddress = (id: string) => `${window.location.origin}${DEMO ? '/#' : ''}/assets/${id}`;

function Label({ asset, size }: { asset: AssetView; size: Size }) {
  const [image, setImage] = useState('');
  const address = assetAddress(asset.id);
  useEffect(() => {
    let live = true;
    // Medium error correction: a label that's scuffed or slightly curved still scans.
    void QRCode.toDataURL(address, { margin: 2, errorCorrectionLevel: 'M', width: 400 }).then(
      (url) => live && setImage(url),
    );
    return () => {
      live = false;
    };
  }, [address]);
  const s = SIZES[size];
  const serial = typeof asset.fields.serial_number === 'string' ? asset.fields.serial_number : '';
  return (
    <div
      className="flex break-inside-avoid items-center gap-[2mm] overflow-hidden rounded border border-border bg-white p-[2mm] text-black print:rounded-none print:border-dashed print:border-neutral-300"
      style={{ width: `${s.width}mm`, height: `${s.height}mm` }}
    >
      {image ? (
        <img src={image} alt={`QR code for ${asset.name}`} style={{ width: `${s.qr}mm`, height: `${s.qr}mm` }} />
      ) : (
        <span style={{ width: `${s.qr}mm`, height: `${s.qr}mm` }} />
      )}
      <div className="min-w-0 flex-1 leading-tight">
        <p className={cn('truncate font-semibold', size === 'small' ? 'text-[8pt]' : 'text-[10pt]')}>{asset.name}</p>
        <p className={cn('truncate', size === 'small' ? 'text-[6pt]' : 'text-[8pt]')}>{asset.clientName}</p>
        {size !== 'small' && <p className="truncate text-[7pt] text-neutral-600">{asset.layoutName}</p>}
        {serial && (
          <p className={cn('truncate font-mono text-neutral-700', size === 'small' ? 'text-[5.5pt]' : 'text-[7pt]')}>
            S/N {serial}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * QR labels to print and stick on equipment: one asset, or everything in a client (optionally one layout).
 * Scanning a label opens that asset in Atlas.
 */
export function AssetLabels() {
  const search = useSearch({ strict: false }) as { asset?: string; client?: string; layout?: string };
  const [size, setSize] = useState<Size>('standard');
  const one = useAsset(search.asset ?? '');
  const many = useAssets({ client: search.client, layout: search.layout });
  const layouts = useLayouts().data ?? [];
  const loading = search.asset ? one.isLoading : many.isLoading;
  const assets = useMemo(() => {
    const list = search.asset ? (one.data ? [one.data] : []) : (many.data ?? []);
    return list.filter((a) => !a.archived).sort((a, b) => a.name.localeCompare(b.name));
  }, [search.asset, one.data, many.data]);
  const shown = assets.slice(0, MAX_LABELS);
  const layout = layouts.find((l) => l.id === search.layout);
  const back = search.asset
    ? `/assets/${search.asset}`
    : search.client
      ? `/clients/${search.client}/assets`
      : '/assets';
  const what = search.asset
    ? shown[0]?.name
    : [shown[0]?.clientName && search.client ? shown[0].clientName : null, layout?.name].filter(Boolean).join(' · ');

  return (
    <>
      <AppLink
        to={back}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-text print:hidden"
      >
        <ArrowLeft className="size-4" /> Back
      </AppLink>
      <div className="print:hidden">
        <PageHeader
          title="QR labels"
          description={`Print these and stick them on the equipment. Scanning one opens that asset in Atlas, after signing in.${what ? ` ${what}.` : ''}`}
          actions={
            <>
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">Label size</span>
                <Select value={size} onChange={(e) => setSize(e.target.value as Size)} className="w-52">
                  {(Object.keys(SIZES) as Size[]).map((k) => (
                    <option key={k} value={k}>
                      {SIZES[k].label}
                    </option>
                  ))}
                </Select>
              </label>
              <Button onClick={() => window.print()} disabled={!shown.length}>
                <Printer /> Print
              </Button>
            </>
          }
        />
      </div>
      {loading ? (
        <Skeleton className="h-40" />
      ) : !shown.length ? (
        <Card className="print:hidden">
          <EmptyState icon={QrCode} title="No assets to label" description="There are no active assets here." />
        </Card>
      ) : (
        <>
          {assets.length > MAX_LABELS && (
            <p className="mb-3 text-sm text-warning print:hidden">
              Showing the first {MAX_LABELS} of {assets.length}. Choose a layout to print the rest in batches.
            </p>
          )}
          <p className="mb-3 text-xs text-muted print:hidden">
            In the print dialog, turn off headers and footers and set margins to the minimum your label sheet needs. Cut
            along the dashed lines if you&rsquo;re printing on plain paper.
          </p>
          <div className="flex flex-wrap gap-[2mm]">
            {shown.map((a) => (
              <Label key={a.id} asset={a} size={size} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
