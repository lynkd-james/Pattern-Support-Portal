// =============================================================================
// Manual Outlook acknowledgement sync (Stage 6).
//
// Usage:  npm run sync:outlook        (run from the web/ directory)
// Reads DATABASE_URL + GRAPH_* from the environment (.env).
//
// Orchestration: runs the pure outlookSync() (sets acknowledged_at on the
// internal layer), then chains runProjection() so customer_tickets reflects the
// new acknowledgement immediately. The two subsystems remain independent; the
// chaining lives only here, at the entry point.
// Exits non-zero if either step FAILED.
// =============================================================================

import "dotenv/config";

import { env, requireGraph } from "../../src/server/env";
import { closePool } from "../../src/server/db";
import { runOutlookSync } from "../../src/server/sync/outlookSync";
import { runProjection } from "../../src/server/projection/transform";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }
  requireGraph(); // fail fast if GRAPH_* is missing

  const outlook = await runOutlookSync();
  console.log("\nOutlook acknowledgement sync\n────────────────────────────");
  console.log(`status       : ${outlook.status}`);
  console.log(`processed    : ${outlook.processed}`);
  console.log(`ack emails   : ${outlook.ackEmails}`);
  console.log(`updated      : ${outlook.updated}`);
  console.log(`already acked: ${outlook.alreadyAcked}`);
  console.log(`unmatched    : ${outlook.unmatched}`);
  console.log(`anomalies    : ${outlook.anomalies}`);
  console.log(`failed       : ${outlook.failed}`);
  console.log(`watermark    : ${outlook.watermark}`);
  console.log(`sync_run id  : ${outlook.runId}`);

  // Chain projection so customer_tickets reflects the new acknowledged_at.
  const projection = await runProjection();
  console.log("\nProjection (post-outlook)\n─────────────────────────");
  console.log(`status            : ${projection.status}`);
  console.log(`processed         : ${projection.processed}`);
  console.log(`published (new)   : ${projection.publishedNew}`);
  console.log(`published (update): ${projection.publishedUpdated}`);
  console.log(`failed            : ${projection.failed}\n`);

  if (outlook.status === "FAILED" || projection.status === "FAILED") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[sync:outlook] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
