import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Raw connection pool + drizzle instance. This module is intentionally dumb:
 * tenancy lives in ./tenant.ts, and application code outside src/db must not
 * import this file directly (enforced by ESLint) — it goes through
 * `withTenant()` or the handful of system-level functions in ./system.ts.
 */

export type Db = PostgresJsDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

declare global {
  // Survive Next.js dev-mode hot reloads without leaking connections.
  var __kingDbPool: ReturnType<typeof postgres> | undefined;
}

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  return url;
}

export function getPool(): ReturnType<typeof postgres> {
  if (!globalThis.__kingDbPool) {
    globalThis.__kingDbPool = postgres(connectionString(), {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      // The app role must never own DDL; keep the wire protocol simple.
      prepare: false,
    });
  }
  return globalThis.__kingDbPool;
}

let cachedDb: Db | null = null;

export function getDb(): Db {
  if (!cachedDb) {
    cachedDb = drizzle(getPool(), { schema });
  }
  return cachedDb;
}

/**
 * A MIGRATION-role handle, for tests and deploy scripts ONLY (O-22). The
 * running app must never call this — it exists so test FIXTURES and admin peeks
 * can seed/inspect rows as the privileged migration role while the code under
 * test connects as `app_server` via getDb(). Uses DATABASE_MIGRATION_URL (the
 * owner), independent of getDb()'s pool. Guarded so it cannot run in the
 * server bundle.
 */
declare global {
  var __kingSetupPool: ReturnType<typeof postgres> | undefined;
}
let cachedSetupDb: Db | null = null;

export function getSetupDb(): Db {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('getSetupDb() is a test/migration helper and must not run in production.');
  }
  if (!cachedSetupDb) {
    const url =
      process.env.DATABASE_MIGRATION_URL ??
      process.env.TEST_DATABASE_URL ??
      'postgresql://king:king@localhost:5433/king_ai_hub';
    if (!globalThis.__kingSetupPool) {
      globalThis.__kingSetupPool = postgres(url, { max: 5, idle_timeout: 30, connect_timeout: 10, prepare: false });
    }
    cachedSetupDb = drizzle(globalThis.__kingSetupPool, { schema });
  }
  return cachedSetupDb;
}

export { schema };
