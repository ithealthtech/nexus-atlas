import { describe, expect, it } from 'vitest';
import { bitlockerKeysIn, hasBitlockerKey, withoutBitlockerKeys } from '../src/services/bitlocker-keys.js';

// Recovery passwords are eight groups, each a multiple of 11.
const KEY_C = '111111-222222-333333-444444-555555-666666-077077-123453';
const KEY_D = '000011-000022-000033-000044-000055-000066-000077-000088';

describe('BitLocker recovery keys in text', () => {
  it('finds a key whatever the field is called, with the ID and drive written beside it', () => {
    expect(bitlockerKeysIn([{ name: 'Encryption', value: KEY_C }])).toEqual([
      { key: KEY_C, keyId: '', drive: '', field: 'Encryption' },
    ]);
    const script = `C: ID: {4F2A9C1E-7B44-4D0E-9A51-0C6E2B8D1F77} Password: ${KEY_C}\nD: ID: {aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee} Password: ${KEY_D}`;
    expect(bitlockerKeysIn([{ name: 'BitLocker', value: script }])).toEqual([
      { key: KEY_C, keyId: '4F2A9C1E-7B44-4D0E-9A51-0C6E2B8D1F77', drive: 'C:', field: 'BitLocker' },
      { key: KEY_D, keyId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', drive: 'D:', field: 'BitLocker' },
    ]);
    // The same key in two fields is one key.
    expect(
      bitlockerKeysIn([
        { name: 'A', value: KEY_C },
        { name: 'B', value: `again ${KEY_C}` },
      ]),
    ).toHaveLength(1);
  });

  it('ignores numbers that only look like a key', () => {
    // Right shape, but the groups aren't multiples of 11.
    expect(hasBitlockerKey('123456-123456-123456-123456-123456-123456-123456-123456')).toBe(false);
    // Too few groups, and a longer run of digits.
    expect(hasBitlockerKey('111111-222222-333333-444444')).toBe(false);
    expect(hasBitlockerKey(`9${KEY_C}`)).toBe(false);
    expect(hasBitlockerKey('Serial 5CG1234XYZ, asset tag 004412')).toBe(false);
    expect(hasBitlockerKey(42)).toBe(false);
  });

  it('takes keys out of a value and keeps the rest', () => {
    expect(withoutBitlockerKeys(KEY_C)).toBeNull();
    expect(withoutBitlockerKeys(`Encrypted 2026-03-01. Key: ${KEY_C}`)).toBe('Encrypted 2026-03-01. Key');
    expect(withoutBitlockerKeys('Not encrypted')).toBe('Not encrypted');
  });
});
