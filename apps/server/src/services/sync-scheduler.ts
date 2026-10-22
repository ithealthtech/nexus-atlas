import { eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import type { Actor } from '@atlas/shared';
import { HttpError } from '../errors.js';
import { actorFor } from '../identity/service.js';
import { Repeating, type ErrorLog } from './repeating.js';

/** What the scheduler needs to know about one organization's connection to an integration. */
export interface ScheduledConnection {
  autoSync: boolean;
  lastSyncAt: string | null;
  /** The administrator who connected it; scheduled syncs run as them. */
  connectedBy: string;
}

/**
 * Runs an integration's sync (ConnectWise RMM, Microsoft 365, Bitdefender) for each organization connected to it,
 * once every `every`, as the administrator who connected it. A sync that finds another import running waits for the
 * next tick.
 */
export class ConnectedSyncScheduler<T extends ScheduledConnection> {
  private readonly schedule = new Repeating(() => this.tick());

  constructor(
    private readonly db: Database,
    private readonly log: ErrorLog,
    private readonly sync: {
      /** As people read it, for the log. */
      product: string;
      /** The organization settings key the connection is saved under. */
      settingsKey: string;
      /** How often each organization syncs. */
      every: number;
      /** How often to check which organizations are due. */
      checkEvery: number;
      load: (orgId: string) => Promise<T | null>;
      /** Whether there's anything to sync yet (Microsoft 365 needs a linked tenant). */
      ready?: (saved: T) => boolean;
      start: (actor: Actor) => Promise<{ done: Promise<void> }>;
    },
  ) {}

  start(intervalMs = this.sync.checkEvery) {
    this.schedule.start(intervalMs, this.log);
  }

  stop() {
    this.schedule.stop();
  }

  async tick(now = Date.now()) {
    const { product, settingsKey, every, load, ready, start } = this.sync;
    const orgs = await this.db
      .select({ id: schema.orgs.id })
      .from(schema.orgs)
      .where(sql`${schema.orgs.settings} ? ${settingsKey}`);
    const started: Promise<void>[] = [];
    for (const { id } of orgs) {
      const saved = await load(id);
      if (!saved?.autoSync || (ready && !ready(saved))) continue;
      if (saved.lastSyncAt && now - Date.parse(saved.lastSyncAt) < every - 5 * 60_000) continue;
      const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, saved.connectedBy));
      if (!user || user.disabled || (user.role !== 'owner' && user.role !== 'admin')) {
        this.log(new Error(`${product} sync skipped for org ${id}: the connecting administrator can't run it.`));
        continue;
      }
      try {
        started.push((await start(actorFor(user))).done);
      } catch (error) {
        // Another import is running; try again next tick.
        if (!(error instanceof HttpError && error.status === 409)) this.log(error);
      }
    }
    await Promise.all(started);
  }
}
