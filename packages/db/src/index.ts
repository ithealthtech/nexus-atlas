import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export * as schema from './schema.js';
export type Database = NodePgDatabase<typeof schema>;
export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function connect(
  url: string,
  {
    max = 10,
    onPoolError = (error: Error) => console.error('Database connection error:', error.message),
  }: { max?: number; onPoolError?: (error: Error) => void } = {},
): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max });
  // An idle connection dropped by the server (restart, failover, admin action) must not crash Atlas;
  // the pool discards it and the next query opens a new one.
  pool.on('error', (error) => onPoolError(error));
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

// A session-level advisory lock keeps two starting instances from migrating at the same time.
export async function runMigrations(handle: DatabaseHandle): Promise<void> {
  const client = await handle.pool.connect();
  try {
    await client.query('select pg_advisory_lock(727274)');
    await migrate(drizzle(client, { schema }), { migrationsFolder });
  } finally {
    await client.query('select pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
}
