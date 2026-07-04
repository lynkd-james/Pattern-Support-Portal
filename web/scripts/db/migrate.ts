// =============================================================================
// Migration runner (Stage 8a: ordered incremental migrations).
//
// Two-part model, recorded in the `schema_migrations` ledger:
//   1. BASELINE — the repo-root `schema.sql` (authoritative DDL for FRESH
//      installs). Applied exactly once, on an empty database. If the baseline
//      was applied earlier with a different checksum, that is INFORMATIONAL:
//      schema evolution happens via migration files, and schema.sql is kept in
//      sync for fresh installs only.
//   2. MIGRATIONS — `scripts/db/migrations/*.sql`, applied in filename order,
//      each inside a transaction and recorded with its checksum. Re-running is
//      a no-op; EDITING an already-applied migration file is a hard error
//      (write a new file instead). Migration files are written idempotently
//      (IF NOT EXISTS) so they also no-op on a fresh install whose schema.sql
//      already contains the change.
//
// Usage:  npm run db:migrate      (run from the web/ directory)
// Reads DATABASE_URL from the environment (.env). No credentials are hard-coded.
// =============================================================================

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

import { env } from "../../src/server/env";
import { closePool, getPool, withTransaction } from "../../src/server/db";

const SCHEMA_PATH = resolve(
  process.cwd(),
  process.env.SCHEMA_SQL_PATH ?? "../schema.sql"
);
const MIGRATIONS_DIR = resolve(process.cwd(), "scripts/db/migrations");
const BASELINE_NAME = "schema.sql";

const checksumOf = (sql: string): string =>
  createHash("sha256").update(sql).digest("hex");

async function ensureLedger(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedChecksum(filename: string): Promise<string | null> {
  const res = await getPool().query<{ checksum: string }>(
    "SELECT checksum FROM schema_migrations WHERE filename = $1",
    [filename]
  );
  return res.rows[0]?.checksum ?? null;
}

async function applyOnce(filename: string, sql: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
      [filename, checksumOf(sql)]
    );
  });
}

async function applyBaseline(): Promise<void> {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  const checksum = checksumOf(sql);
  const existing = await appliedChecksum(BASELINE_NAME);

  if (existing === null) {
    console.log(`[migrate] baseline    : applying ${SCHEMA_PATH} (fresh install)`);
    await applyOnce(BASELINE_NAME, sql);
    console.log("[migrate] baseline    : applied and recorded.");
    return;
  }
  if (existing === checksum) {
    console.log("[migrate] baseline    : already applied (unchanged).");
    return;
  }
  // Baseline drift is expected once migrations exist: schema.sql tracks the
  // full DDL for fresh installs, while applied databases evolve via migrations.
  console.log(
    "[migrate] baseline    : schema.sql differs from the applied baseline — " +
      "OK (fresh-install DDL evolves alongside migrations; this database is " +
      "updated by the migration files below)."
  );
}

async function applyMigrations(): Promise<void> {
  if (!existsSync(MIGRATIONS_DIR)) {
    console.log("[migrate] migrations  : none (directory absent).");
    return;
  }
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    console.log("[migrate] migrations  : none found.");
    return;
  }

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = checksumOf(sql);
    const existing = await appliedChecksum(file);

    if (existing === null) {
      console.log(`[migrate] migration   : applying ${file} …`);
      await applyOnce(file, sql);
      console.log(`[migrate] migration   : ${file} applied and recorded.`);
    } else if (existing === checksum) {
      console.log(`[migrate] migration   : ${file} already applied (no-op).`);
    } else {
      throw new Error(
        `[migrate] ${file} has CHANGED since it was applied ` +
          `(applied ${existing.slice(0, 12)}…, on disk ${checksum.slice(0, 12)}…). ` +
          "Applied migrations are immutable — add a new migration file instead."
      );
    }
  }
}

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  await ensureLedger();
  await applyBaseline();
  await applyMigrations();
  console.log("[migrate] done.");
}

main()
  .catch((err) => {
    console.error("[migrate] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
