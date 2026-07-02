// =============================================================================
// Manual ClickUp sync runner (Stage 2).
//
// Usage:  npm run sync:clickup        (run from the web/ directory)
// Reads DATABASE_URL and CLICKUP_API_TOKEN from the environment (.env).
// Safe to run repeatedly — upserts are idempotent and unchanged tickets are
// skipped via content_hash. Exits non-zero if the run FAILED.
// =============================================================================

import "dotenv/config";

import { env, requireClickup } from "../../src/server/env";
import { closePool } from "../../src/server/db";
import { runClickupSync } from "../../src/server/sync/clickupSync";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }
  requireClickup(); // fail fast if CLICKUP_API_TOKEN is missing

  const summary = await runClickupSync();

  console.log("\nClickUp sync\n────────────");
  console.log(`status      : ${summary.status}`);
  console.log(`processed   : ${summary.processed}`);
  console.log(`inserted    : ${summary.inserted}`);
  console.log(`updated     : ${summary.updated}`);
  console.log(`skipped     : ${summary.skipped}`);
  console.log(`quarantined : ${summary.quarantined}`);
  console.log(`failed      : ${summary.failed}`);
  console.log(`watermark   : ${summary.watermark} (fetchSince ${summary.fetchSince})`);
  console.log(`duration    : ${summary.durationMs} ms`);
  console.log(`sync_run id : ${summary.runId}\n`);

  if (summary.status === "FAILED") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[sync:clickup] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
