import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const BREACHED = 'Summer2024!Password';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

/** A fake Have I Been Pwned range API that records what it was asked. */
function fakePwned() {
  const state = { urls: [] as string[], down: false };
  const fetcher = (async (input: string | URL) => {
    state.urls.push(String(input));
    if (state.down) throw new Error('offline');
    const prefix = String(input).split('/range/')[1]!;
    const hash = sha1(BREACHED);
    // Real responses hold hundreds of suffixes, including padding rows with a count of zero.
    const rows = ['0018A45C4D1DEF81644B54AB7F969B88D65:0', 'ABCDEF0123456789ABCDEF0123456789ABC:3'];
    if (hash.startsWith(prefix)) rows.push(`${hash.slice(5)}:52133`);
    return new Response(rows.join('\r\n'), { status: 200 });
  }) as typeof fetch;
  return { state, fetcher };
}

describe('password health', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let pwned: ReturnType<typeof fakePwned>;

  beforeEach(async () => {
    pwned = fakePwned();
    t = await startApp({}, { breachFetch: pwned.fetcher });
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  const add = (name: string, secret: string, extra: object = {}) =>
    owner.call('POST', `/api/clients/${harbor}/passwords`, { name, secret, ...extra });

  it('flags breached, weak, reused and overdue passwords, and scores each client', async () => {
    const leaked = (await add('Old portal', BREACHED)).data;
    await add('Weak one', 'password1');
    await add('Reused A', 'Tr0ub4dor&3-Reused-Harbor!');
    await add('Reused B', 'Tr0ub4dor&3-Reused-Harbor!');
    await add('Clean', 'unique-Lantern-quartz-3381-wave');
    await add('Fine', 'correct-Horse-battery-77-staple');
    await t.handle.db.execute(sql`update passwords set changed_at = now() - interval '400 days' where name = 'Fine'`);

    const before = (await owner.call('GET', '/api/password-health')).data;
    expect(before.breach).toMatchObject({ enabled: true, unchecked: 6 });
    expect(before.counts.breached).toBe(0);

    const check = await owner.call('POST', '/api/password-health/check', {});
    expect(check.data).toEqual({ checked: 6, failed: false });
    // Only the first five characters of each hash left the server.
    expect(pwned.state.urls.every((u) => /\/range\/[0-9A-F]{5}$/.test(u))).toBe(true);
    expect(pwned.state.urls.some((u) => u.includes(sha1(BREACHED).slice(5, 12)))).toBe(false);

    const report = (await owner.call('GET', '/api/password-health')).data;
    expect(report.counts).toMatchObject({ breached: 1, weak: 1, reused: 2, old: 1 });
    expect(report.total).toBe(6);
    expect(report.breach).toMatchObject({ checked: 6, unchecked: 0 });
    // 5 of 6 passwords have an issue (the aged one counts), so 1 of 6 is clean.
    expect(report.score).toBe(17);
    expect(report.clients).toEqual([
      expect.objectContaining({ name: 'Harbor Dental Group', total: 6, withIssues: 5, score: 17 }),
    ]);
    // Breached first.
    expect(report.items[0]).toMatchObject({ id: leaked.id, issues: expect.arrayContaining(['breached']) });
    // The stored flag is a count: no password or hash is kept.
    const row = (await t.handle.db.execute(sql`select breach_count from passwords where id = ${leaked.id}`)).rows[0];
    expect(row).toEqual({ breach_count: 52133 });

    // Changing the password clears the flag until it's checked again.
    await owner.call('PATCH', `/api/passwords/${leaked.id}`, {
      version: leaked.version,
      secret: 'a-brand-new-Secret-91!x',
    });
    const after = (await owner.call('GET', '/api/password-health')).data;
    expect(after.counts.breached).toBe(0);
    expect(after.breach.unchecked).toBe(1);
  });

  it('can be turned off, and copes with no internet', async () => {
    await add('Old portal', BREACHED);
    expect((await owner.call('PUT', '/api/password-health/settings', { breachChecks: false })).data.breachChecks).toBe(
      false,
    );
    expect((await owner.call('POST', '/api/password-health/check', {})).status).toBe(409);
    expect(pwned.state.urls).toHaveLength(0);

    await owner.call('PUT', '/api/password-health/settings', { breachChecks: true });
    pwned.state.down = true;
    const offline = await owner.call('POST', '/api/password-health/check', {});
    expect(offline.status).toBe(502);
    // Nothing was marked checked, so it's tried again later.
    expect((await owner.call('GET', '/api/password-health')).data.breach.unchecked).toBe(1);
  });
});
