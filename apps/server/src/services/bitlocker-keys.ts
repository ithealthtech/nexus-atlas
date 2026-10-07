const KEY = /(?<!\d)\d{6}(?:-\d{6}){7}(?!\d)/g;
const KEY_ID = /\{?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}?/gi;
// A drive letter ("C:"), not the colon after a word ("ID:") or in an address ("https://").
const DRIVE = /(?<![A-Za-z])([A-Za-z]):(?![/\\]{2})/g;

/** A real recovery password: every group is a multiple of 11 below 720,896 (which rules out look-alike numbers). */
const valid = (key: string) => key.split('-').every((g) => Number(g) % 11 === 0 && Number(g) < 720_896);

export interface FoundKey {
  key: string;
  /** The key protector ID written beside the key, when there is one. */
  keyId: string;
  /** The drive letter written beside the key ("C:"), when there is one. */
  drive: string;
  /** The custom field (or asset field) it was found in. */
  field: string;
}

/**
 * Every BitLocker recovery key in a set of named values. Keys are found by their shape wherever they are, so the
 * field can be called anything and hold several drives' keys with their IDs.
 */
export function bitlockerKeysIn(values: { name: string; value: string }[]): FoundKey[] {
  const out: FoundKey[] = [];
  for (const { name, value } of values) {
    let from = 0;
    for (const match of value.matchAll(KEY)) {
      const key = match[0];
      if (!valid(key) || out.some((k) => k.key === key)) continue;
      // The ID and drive that belong to this key are the last ones written before it, after the previous key.
      const before = value.slice(from, match.index);
      const ids = [...before.matchAll(KEY_ID)];
      const drives = [...before.matchAll(DRIVE)];
      out.push({
        key,
        keyId: (ids.at(-1)?.[1] ?? '').toUpperCase(),
        drive: drives.length ? `${drives.at(-1)![1]!.toUpperCase()}:` : '',
        field: name,
      });
      from = match.index + key.length;
    }
  }
  return out;
}

/** Whether a value holds a recovery key. */
export const hasBitlockerKey = (value: unknown) =>
  typeof value === 'string' && bitlockerKeysIn([{ name: '', value }]).length > 0;

/** The same value with any recovery keys taken out, or null if nothing else was in it. */
export function withoutBitlockerKeys(value: string): string | null {
  if (!hasBitlockerKey(value)) return value;
  const rest = value
    .replace(KEY, (k) => (valid(k) ? '' : k))
    .replace(/[\s,;:|-]+$/g, '')
    .trim();
  return rest || null;
}
