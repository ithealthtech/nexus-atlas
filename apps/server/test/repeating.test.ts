import { afterEach, describe, expect, it, vi } from 'vitest';
import { Repeating } from '../src/services/repeating.js';

describe('scheduled background jobs', () => {
  afterEach(() => vi.useRealTimers());

  it('logs a failing job instead of dropping the error, and keeps running it', async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    let runs = 0;
    const job = new Repeating(async () => {
      runs++;
      throw new Error(`backup failed (${runs})`);
    });
    job.start(1000, (error) => failures.push(error));
    await vi.advanceTimersByTimeAsync(3000);
    expect(runs).toBe(3);
    expect(failures.map((e) => (e as Error).message)).toEqual([
      'backup failed (1)',
      'backup failed (2)',
      'backup failed (3)',
    ]);
    job.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(3);
  });

  it('never overlaps a slow run with the next tick', async () => {
    vi.useFakeTimers();
    let active = 0;
    let most = 0;
    let runs = 0;
    const job = new Repeating(async () => {
      runs++;
      active++;
      most = Math.max(most, active);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      active--;
    });
    job.start(1000, () => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(most).toBe(1);
    // Ticks during a run are skipped rather than queued: about one run every three seconds, not ten.
    expect(runs).toBeLessThanOrEqual(4);
    job.stop();
  });

  it('can run straight away, and a synchronous throw is caught too', async () => {
    vi.useFakeTimers();
    const failures: unknown[] = [];
    const job = new Repeating(() => {
      throw new Error('thrown before any await');
    });
    job.start(60_000, (error) => failures.push(error), { now: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(failures).toHaveLength(1);
    // The failed run doesn't block the next one.
    await job.run();
    expect(failures).toHaveLength(2);
    job.stop();
  });
});
