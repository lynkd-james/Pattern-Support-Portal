// =============================================================================
// Manual projection runner (Stage 3).
//
// Usage:
//   npm run project           # incremental (changed tickets since last run)
//   npm run project:rebuild   # full rebuild from the internal layer
//
// Reads DATABASE_URL from the environment (.env). Idempotent and safe to re-run.
// Publishing follows AUTO_PUBLISH_ENABLED (default false → nothing is projected).
// Exits non-zero if the run FAILED.
// =============================================================================

import "dotenv/config";

import { env } from "../../src/server/env";
import { closePool } from "../../src/server/db";
import { runProjection, type ProjectionMode } from "../../src/server/projection/transform";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }
  const mode: ProjectionMode = process.argv.includes("--rebuild") ? "rebuild" : "incremental";

  const s = await runProjection({ mode });

  console.log(`\nProjection (${s.mode})\n──────────────────`);
  console.log(`status            : ${s.status}`);
  console.log(`autoPublish       : ${env.autoPublishEnabled}`);
  console.log(`processed         : ${s.processed}`);
  console.log(`published (new)   : ${s.publishedNew}`);
  console.log(`published (update): ${s.publishedUpdated}`);
  console.log(`withdrawn         : ${s.withdrawn}`);
  console.log(`noop              : ${s.noop}`);
  console.log(`visibility changes: ${s.visibilityChanges}`);
  console.log(`failed            : ${s.failed}`);
  console.log(`watermark         : ${s.watermark}`);
  console.log(`duration          : ${s.durationMs} ms`);
  console.log(`sync_run id       : ${s.runId}\n`);

  if (s.status === "FAILED") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[project] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
