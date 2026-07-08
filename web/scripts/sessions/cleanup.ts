// =============================================================================
// Manual expired-session cleanup (Stage 8d).
//
// Usage:  npm run sessions:cleanup     (run from the web/ directory)
// Same engine the scheduled /api/jobs/sessions step runs; deletes sessions
// that have been invalid (revoked / absolute-expired / idle-expired) for
// longer than the retention window. Exits non-zero on failure.
// =============================================================================

import "dotenv/config";

import { env } from "../../src/server/env";
import { closePool } from "../../src/server/db";
import { runSessionCleanup } from "../../src/server/jobs/sessionCleanup";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const s = await runSessionCleanup();
  console.log("\nSession cleanup\n───────────────");
  console.log(`status         : ${s.status}`);
  console.log(`deleted        : ${s.deleted}`);
  console.log(`retention days : ${s.retentionDays}`);
  console.log(`sync_run id    : ${s.runId}\n`);

  if (s.status === "FAILED") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[sessions] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
