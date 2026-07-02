// =============================================================================
// Idempotent migration runner.
//
// Applies the existing repo-root `schema.sql` WITHOUT modifying it. `schema.sql`
// itself is not idempotent (CREATE TYPE / CREATE TABLE have no IF NOT EXISTS),
// so idempotency is provided by a `schema_migrations` ledger: the file is hashed
// and applied exactly once, inside a transaction. Re-running is a safe no-op.
//
// Expects a FRESH database (nothing applied yet). To re-run during development,
// recreate the database (see scripts/db/README.md), then migrate again.
//
// Usage:  npm run db:migrate      (run from the web/ directory)
// Reads DATABASE_URL from the environment (.env). No credentials are hard-coded.
// =============================================================================

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { env } from "../../src/server/env";
import { closePool, getPool, withTransaction } from "../../src/server/db";

const SCHEMA_PATH = resolve(
  process.cwd(),
  process.env.SCHEMA_SQL_PATH ?? "../schema.sql"
);
const MIGRATION_NAME = "schema.sql";

async function ensureLedger(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const checksum = createHash("sha256").update(sql).digest("hex");
  console.log(`[migrate] schema file : ${SCHEMA_PATH}`);
  console.log(`[migrate] checksum    : ${checksum.slice(0, 12)}…`);

  await ensureLedger();

  const existing = await getPool().query<{ checksum: string }>(
    "SELECT checksum FROM schema_migrations WHERE filename = $1",
    [MIGRATION_NAME]
  );

  if (existing.rowCount && existing.rows[0].checksum === checksum) {
    console.log("[migrate] already applied — nothing to do (idempotent no-op).");
    return;
  }
  if (existing.rowCount && existing.rows[0].checksum !== checksum) {
    throw new Error(
      "[migrate] schema.sql has changed since it was applied. This runner does " +
        "not auto-migrate drift. Apply a new migration or recreate the database."
    );
  }

  console.log("[migrate] applying schema.sql …");
  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
      [MIGRATION_NAME, checksum]
    );
  });
  console.log("[migrate] done. schema applied and recorded.");
}

main()
  .catch((err) => {
    console.error("[migrate] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
