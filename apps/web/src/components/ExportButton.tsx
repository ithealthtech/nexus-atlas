import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Checkbox, Dialog, FormError, useToast } from '@/components/ui';
import { download } from '@/lib/api';

/** Downloads one client's documentation as a zip. Decrypted passwords are an administrator-only option. */
export function ExportButton({ clientId, canIncludePasswords }: { clientId: string; canIncludePasswords: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [passwords, setPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await download(`/clients/${clientId}/export${passwords ? '?passwords=true' : ''}`, 'atlas-export.zip');
      toast('Export downloaded.');
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Download /> Export
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="Export this client"
        description="A zip with everything you can see: details, contacts, locations, assets, documents, links, and attachments."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={run} loading={busy}>
              <Download /> Download zip
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {canIncludePasswords ? (
            <Checkbox
              checked={passwords}
              onChange={(e) => setPasswords(e.target.checked)}
              label="Include decrypted passwords"
              description="Anyone with the file can read them. Store it encrypted and delete it when you're done. Each password is logged as exported."
            />
          ) : (
            <p className="text-sm text-muted">Password entries are listed without their secrets.</p>
          )}
          <FormError message={error} />
        </div>
      </Dialog>
    </>
  );
}
