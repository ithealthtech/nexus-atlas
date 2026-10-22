import { describe, expect, it } from 'vitest';
import { runtimeChecks } from '../src/services/status.js';

const JAN_2026 = new Date('2026-01-15T12:00:00Z');
const NOV_2026 = new Date('2026-11-15T12:00:00Z');

describe('runtime checks', () => {
  it('passes supported versions quietly', () => {
    expect(runtimeChecks('v22.12.0', 160_004, JAN_2026)).toEqual([]);
    expect(runtimeChecks('v24.3.0', 170_002, NOV_2026)).toEqual([]);
  });

  it('says when Node.js or PostgreSQL is older than supported', () => {
    const checks = runtimeChecks('v22.11.0', 150_008, JAN_2026);
    expect(checks.map((c) => [c.id, c.level])).toEqual([
      ['node', 'error'],
      ['postgres', 'error'],
    ]);
    expect(checks[0]!.title).toBe('Node.js v22.11.0 is older than Atlas supports');
    expect(checks[1]!.detail).toContain('PostgreSQL 16 or later');
    expect(runtimeChecks('v20.18.1', 160_000, JAN_2026)[0]!.level).toBe('error');
  });

  it('warns six months before a Node.js line stops getting security fixes', () => {
    const [check] = runtimeChecks('v22.20.0', 160_004, NOV_2026);
    expect(check).toMatchObject({ id: 'node', level: 'warn' });
    expect(check!.title).toBe('Node.js 22 stops getting security fixes on 2027-04-30');
    expect(check!.detail).toBe('Install Node.js 24 LTS on the server, then restart Atlas.');
  });
});
