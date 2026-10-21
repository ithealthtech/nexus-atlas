/** Where a background job's failure goes: in the server, Atlas's own log (`app.log.error`). */
export type ErrorLog = (error: unknown) => void;

/**
 * Runs a background job on a timer. Every scheduled job in Atlas uses this rather than its own `setInterval`, so
 * they all behave the same way:
 * - one run at a time: a slow run isn't overlapped by the next tick;
 * - a failure always reaches the log. Before this, several jobs (backups among them) dropped their errors silently;
 * - the timer doesn't keep the process alive.
 */
export class Repeating {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<void> | null = null;
  private log: ErrorLog = () => undefined;

  constructor(private readonly job: () => Promise<unknown>) {}

  /** Runs the job every `intervalMs`, and once straight away when `now` is set. */
  start(intervalMs: number, log: ErrorLog, { now = false } = {}) {
    this.stop();
    this.log = log;
    this.timer = setInterval(() => void this.run(), intervalMs);
    this.timer.unref();
    if (now) void this.run();
  }

  /** Runs the job now, unless a run is already going. Resolves when that run ends; never rejects. */
  run(): Promise<void> {
    if (!this.current) {
      const run: Promise<void> = Promise.resolve()
        .then(() => this.job())
        .then(
          () => undefined,
          (error: unknown) => this.log(error),
        )
        .finally(() => {
          if (this.current === run) this.current = null;
        });
      this.current = run;
    }
    return this.current;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
