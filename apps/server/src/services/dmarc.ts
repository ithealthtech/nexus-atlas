import { resolveTxt } from 'node:dns/promises';

/** What a DMARC record asks receivers to do with mail that fails: nothing, junk it, or refuse it. */
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

/**
 * A domain's DMARC record ("v=DMARC1; p=…"), or null when it has none. Throws when DNS doesn't answer in time, so
 * a failed lookup is never mistaken for a missing record.
 */
export async function dmarcRecord(
  domain: string,
  options: { timeoutMs?: number; resolve?: (name: string) => Promise<string[][]> } = {},
): Promise<string | null> {
  const { timeoutMs = 4000, resolve = resolveTxt } = options;
  let timer: NodeJS.Timeout | undefined;
  try {
    const records = await Promise.race([
      resolve(`_dmarc.${domain}`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DNS did not answer in time.')), timeoutMs);
      }),
    ]);
    return records.map((parts) => parts.join('').trim()).find((text) => /^v=DMARC1\b/i.test(text)) ?? null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** The policy a DMARC record sets (its p= tag), or null when it sets none. */
export function dmarcPolicy(record: string): DmarcPolicy | null {
  const p = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\s*(?:;|$)/i.exec(record)?.[1];
  return p ? (p.toLowerCase() as DmarcPolicy) : null;
}
