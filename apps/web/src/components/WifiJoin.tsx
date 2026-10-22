import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { Download, Printer, QrCode, Wifi } from 'lucide-react';
import { WIFI_SECURITY, WIFI_SECURITY_LABELS, wifiJoinCode, type PasswordView, type WifiSecurity } from '@atlas/shared';
import { Button, Card, CardHeader, Checkbox, Field, Input, Select, useToast } from '@/components/ui';
import { saveBlob, useReveal } from '@/lib/vault';

/**
 * A Wi-Fi password's scan-to-join code: guests and staff point a phone's camera at it and join without typing. The
 * password is revealed the usual way (recorded, with a reason where one is required) and the code hides again after
 * a minute, like a shown password. It prints as a card on its own, ready to frame for a guest network.
 */
export function WifiJoinCard({ item }: { item: PasswordView }) {
  const reveal = useReveal();
  const toast = useToast();
  const [ssid, setSsid] = useState(item.username || item.name);
  const [security, setSecurity] = useState<WifiSecurity>('WPA');
  const [hidden, setHidden] = useState(false);
  const [printPassword, setPrintPassword] = useState(true);
  const [password, setPassword] = useState<string | null>(null);
  // The picture drawn for a code; only shown while it's the code for what's on screen now.
  const [drawn, setDrawn] = useState<{ code: string; url: string } | null>(null);
  const shown = password !== null || security === 'nopass';
  const code =
    shown && ssid.trim() ? wifiJoinCode({ ssid: ssid.trim(), password: password ?? '', security, hidden }) : null;
  const image = code && drawn?.code === code ? drawn.url : null;

  // Hides again after a minute, as a revealed password does.
  useEffect(() => {
    if (password === null) return;
    const timer = setTimeout(() => setPassword(null), 60_000);
    return () => clearTimeout(timer);
  }, [password]);
  useEffect(() => {
    if (!code) return;
    let live = true;
    void QRCode.toDataURL(code, { margin: 2, errorCorrectionLevel: 'M', width: 640 }).then(
      (url) => live && setDrawn({ code, url }),
    );
    return () => {
      live = false;
    };
  }, [code]);

  const show = async () => {
    try {
      const result = await reveal(item, { field: 'secret', copy: false });
      if (result) setPassword(result.value);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const print = () => {
    document.documentElement.classList.add('printing-card');
    const done = () => {
      document.documentElement.classList.remove('printing-card');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };
  const download = () => {
    if (!image) return;
    // The code is a data: address; turned into a file here, since the page may not fetch data: addresses.
    const bytes = Uint8Array.from(atob(image.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
    saveBlob(new Blob([bytes], { type: 'image/png' }), `${ssid.trim() || 'wifi'} QR code.png`);
  };

  return (
    <Card>
      <CardHeader
        title="Join this network"
        description="Point a phone's camera at the code to join without typing the password."
      />
      <div className="grid gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="space-y-4">
          <Field label="Network name (SSID)">
            {(p) => <Input {...p} value={ssid} maxLength={64} onChange={(e) => setSsid(e.target.value)} />}
          </Field>
          <Field label="Security">
            {(p) => (
              <Select {...p} value={security} onChange={(e) => setSecurity(e.target.value as WifiSecurity)}>
                {WIFI_SECURITY.map((s) => (
                  <option key={s} value={s}>
                    {WIFI_SECURITY_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Checkbox
            label="Hidden network"
            description="Its name isn't broadcast, so phones need to be told to look for it."
            checked={hidden}
            onChange={(e) => setHidden(e.currentTarget.checked)}
          />
          {shown && (
            <Checkbox
              label="Print the password under the code"
              description="For anyone whose phone can't scan."
              checked={printPassword}
              onChange={(e) => setPrintPassword(e.currentTarget.checked)}
            />
          )}
        </div>
        <div className="flex flex-col items-center gap-3 sm:w-52">
          {image ? (
            <>
              <img
                src={image}
                alt={`Code to join ${ssid}`}
                className="size-48 rounded-md border border-border bg-white"
              />
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" variant="secondary" onClick={print}>
                  <Printer /> Print
                </Button>
                <Button size="sm" variant="secondary" onClick={download}>
                  <Download /> PNG
                </Button>
              </div>
            </>
          ) : (
            <>
              <div
                aria-hidden
                className="grid size-48 place-items-center rounded-md border border-dashed border-border bg-surface-2 text-muted"
              >
                <QrCode className="size-12" />
              </div>
              <Button size="sm" onClick={() => void show()} disabled={!item.canReveal || !ssid.trim()}>
                <QrCode /> Show the code
              </Button>
              {!item.canReveal && (
                <p className="text-center text-xs text-muted">You can&rsquo;t reveal this password.</p>
              )}
            </>
          )}
        </div>
      </div>
      {image &&
        createPortal(
          // Only this card prints (see .printing-card in styles.css).
          <div id="print-card" className="print-card" aria-hidden>
            <div className="mx-auto flex max-w-[120mm] flex-col items-center gap-[6mm] rounded-[4mm] border-2 border-neutral-300 p-[12mm] text-center text-black">
              <Wifi className="size-[14mm]" />
              <p className="text-[9mm] leading-tight font-bold">{ssid}</p>
              <img src={image} alt="" className="size-[70mm]" />
              <p className="text-[4.5mm]">Point your phone&rsquo;s camera at the code to join.</p>
              {printPassword && password && (
                <p className="text-[4.5mm]">
                  Password: <span className="font-mono font-bold break-all">{password}</span>
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </Card>
  );
}
