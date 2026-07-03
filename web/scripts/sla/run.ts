// =============================================================================
// Manual SLA + milestone computation (Stage 7).
//
// Usage:  npm run sla        (run from the web/ directory)
// Reads DATABASE_URL from the environment (.env). Idempotent (writes only on
// change). Chains projection so customer_tickets reflects the new milestones/SLA.
// With sla_policies empty, tickets resolve to NOT_APPLICABLE (by design) until
// targets are supplied. Exits non-zero if either step FAILED.
// =============================================================================

import "dotenv/config";

import { env } from "../../src/server/env";
import { closePool } from "../../src/server/db";
import { runSlaComputation } from "../../src/server/sla/compute";
import { runProjection } from "../../src/server/projection/transform";

async function main(): Promise<void> {
  if (!env.databaseUrl) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const sla = await runSlaComputation();
  console.log("\nSLA + milestone computation\n───────────────────────────");
  console.log(`status        : ${sla.status}`);
  console.log(`processed     : ${sla.processed}`);
  console.log(`updated       : ${sla.updated}`);
  console.log(`unchanged     : ${sla.unchanged}`);
  console.log(`not applicable: ${sla.notApplicable} (no matching sla_policies row)`);
  console.log(`failed        : ${sla.failed}`);
  console.log(`sync_run id   : ${sla.runId}`);

  const projection = await runProjection();
  console.log("\nProjection (post-SLA)\n─────────────────────");
  console.log(`status            : ${projection.status}`);
  console.log(`published (update): ${projection.publishedUpdated}`);
  console.log(`published (new)   : ${projection.publishedNew}`);
  console.log(`failed            : ${projection.failed}\n`);

  if (sla.status === "FAILED" || projection.status === "FAILED") process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("[sla] FAILED:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
