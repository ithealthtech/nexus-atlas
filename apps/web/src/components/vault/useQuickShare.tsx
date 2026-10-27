import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type PasswordView } from '@atlas/shared';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { createShareLink, useAskReason } from '@/lib/vault';

/**
 * Quick share: one click makes a one-time link (one view, 24 hours) and copies it, for sending to someone who
 * doesn't sign in to Atlas. The full Share dialog on the password page offers other limits.
 */
export function useQuickShare() {
  const ask = useAskReason();
  const queryClient = useQueryClient();
  // Shown when the browser won't let us copy: the link's key exists nowhere else, so it must not be lost.
  const [manual, setManual] = useState<string | null>(null);
  const share = async (item: PasswordView): Promise<string | null> => {
    let reason = '';
    if (item.requireReason) {
      const given = await ask('Why are you sharing this password?');
      if (given === null) return null;
      reason = given;
    }
    const link = await createShareLink(item, { maxViews: 1, hours: 24, reason });
    await Promise.all(
      ['password-shares', 'password-audit'].map((k) => queryClient.invalidateQueries({ queryKey: [k, item.id] })),
    );
    try {
      // The link is the secret now; copy it as-is (not auto-cleared) so it can be pasted into an email or ticket.
      await navigator.clipboard.writeText(link);
    } catch {
      setManual(link);
      return null;
    }
    return 'One-time link copied. It opens once and expires in 24 hours.';
  };
  const dialog = manual && (
    <Dialog
      open
      onClose={() => setManual(null)}
      title="Copy the one-time link"
      description="Your browser didn't allow copying automatically. Copy this link now: it can't be shown again. It opens once and expires in 24 hours."
      footer={<Button onClick={() => setManual(null)}>Done</Button>}
    >
      <Field label="Share link">
        {(p) => <Input {...p} readOnly value={manual} onFocus={(e) => e.currentTarget.select()} autoFocus />}
      </Field>
    </Dialog>
  );
  return { share, dialog };
}
