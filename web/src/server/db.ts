// =============================================================================
// Server-only PostgreSQL client.
//
// A single pooled `pg` client suitable for Vercel Postgres (Neon-backed). The
// pool is cached on globalThis so it survives module reloads (Next dev HMR) and
// is reused across serverless invocations rather than reconnecting each time.
//
// Point DATABASE_URL at the POOLED connection string on Vercel.
// IMPORTANT: server-only — never import from client code.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error(
    "src/server/db.ts is server-only and must never be imported into client code."
  );
}

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env, requireDatabaseUrl } from "./env";

// Decide TLS: Vercel Postgres requires SSL; local Postgres usually does not.
function resolveSsl(connectionString: string): false | { rejectUnauthorized: boolean } {
  if (env.pgDisableSsl) return false;
  if (/(localhost|127\.0\.0\.1)/.test(connectionString)) return false;
  // Managed providers present certs that aren't in the default trust store;
  // encryption is still applied.
  return { rejectUnauthorized: false };
}

type GlobalWithPool = typeof globalThis & { __patternPgPool?: Pool };
const globalForPool = globalThis as GlobalWithPool;

export function getPool(): Pool {
  if (!globalForPool.__patternPgPool) {
    const connectionString = requireDatabaseUrl();
    globalForPool.__patternPgPool = new Pool({
      connectionString,
      ssl: resolveSsl(connectionString),
      max: env.pgPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "pattern-support-portal",
    });
  }
  return globalForPool.__patternPgPool;
}

/** Run a parameterised query. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[] | undefined);
}

/** Acquire a client, run `fn`, and always release it. */
export async function withClient<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Run `fn` inside a single transaction (BEGIN / COMMIT / ROLLBACK). */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  return withClient(async (client) => {
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

/** Close the pool. Call at the end of short-lived scripts; not in the app runtime. */
export async function closePool(): Promise<void> {
  if (globalForPool.__patternPgPool) {
    await globalForPool.__patternPgPool.end();
    globalForPool.__patternPgPool = undefined;
  }
}
