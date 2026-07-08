// =============================================================================
// Scheduled-pipeline orchestrator (Stage 8d).
//
// Executes exactly ONE pipeline step per invocation, under a Postgres SESSION
// advisory lock so steps never overlap (the pipeline is a sequential data
// flow; the staggered cron schedule in vercel.json provides ordering, the
// lock provides safety). If the lock is held, the invocation reports
// {skipped:"locked"} — an expected condition when a prior step overruns, not
// an error. The lock is held on a dedicated pooled connection for the
// duration of the step; if the function times out or crashes, that
// connection dies and the lock SELF-RELEASES — no stuck-lock state.
//
// Every engine keeps its own semantics untouched: incremental watermarks,
// SUCCESS/PARTIAL/FAILED statuses, watermark-freeze-on-failure, idempotent
// upserts, first-write-wins milestones, append-only audit. The orchestrator
// only dispatches and reports.
//
// Outlook bounded work: the orchestrator passes a per-invocation page bound.
// The engine advances its watermark per processed message (persisted only in
// closeRun), so a bounded run makes deterministic forward progress across
// invocations, while a crash/timeout leaves the watermark unadvanced and the
// rerun idempotent — a first mailbox backfill can never loop forever inside
// one invocation.
//
// Steps stay independently runnable: the manual CLI entrypoints
// (sync:clickup, sync:outlook, sla [which chains projection, unchanged],
// project, sessions:cleanup) call the same engines directly.
// =============================================================================

if (typeof window !== "undefined") {
  throw new Error("jobs/pipeline.ts is server-only.");
}

import { withClient } from "../db";
import { createLogger } from "../logger";
import { runClickupSync } from "../sync/clickupSync";
import { runOutlookSync } from "../sync/outlookSync";
import { runSlaComputation } from "../sla/compute";
import { runProjection } from "../projection/transform";
import { runSessionCleanup } from "./sessionCleanup";

// Advisory-lock identity (classid, objid) — arbitrary but stable constants.
const LOCK_CLASS = 74221;
const LOCK_ID = 1;

/**
 * Outlook pages per scheduled invocation. 20 pages x 50 messages = 1000
 * messages/run — measured DB cost is 1-3 round-trips per ACK email only, so
 * this sits far inside the 300s function budget while guaranteeing a bound.
 */
const OUTLOOK_MAX_PAGES_PER_INVOCATION = 20;

export const JOB_STEPS = [
  "clickup",
  "outlook",
  "sla",
  "projection",
  "sessions",
] as const;
export type JobStep = (typeof JOB_STEPS)[number];

export function isJobStep(value: string): value is JobStep {
  return (JOB_STEPS as readonly string[]).includes(value);
}

export interface JobResult {
  step: JobStep;
  /** Present when the invocation did no work because another step holds the lock. */
  skipped?: "locked";
  /** Engine-reported status (SUCCESS | PARTIAL | FAILED) when the step ran. */
  status?: string;
  /** The engine's own run summary (counts, watermark, runId, durationMs). */
  summary?: Record<string, unknown>;
}

const log = createLogger("jobs");

async function dispatch(step: JobStep): Promise<Record<string, unknown>> {
  switch (step) {
    case "clickup":
      return (await runClickupSync()) as unknown as Record<string, unknown>;
    case "outlook":
      return (await runOutlookSync({
        maxPages: OUTLOOK_MAX_PAGES_PER_INVOCATION,
      })) as unknown as Record<string, unknown>;
    case "sla":
      // Projection is its own scheduled step; the manual CLI keeps chaining.
      return (await runSlaComputation()) as unknown as Record<string, unknown>;
    case "projection":
      return (await runProjection()) as unknown as Record<string, unknown>;
    case "sessions":
      return (await runSessionCleanup()) as unknown as Record<string, unknown>;
  }
}

/** Run one pipeline step under the global pipeline advisory lock. */
export async function runJobStep(step: JobStep): Promise<JobResult> {
  return withClient(async (lockClient) => {
    const lock = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [LOCK_CLASS, LOCK_ID]
    );
    if (!lock.rows[0].locked) {
      log.warn("job_skipped_locked", { step });
      return { step, skipped: "locked" as const };
    }

    log.info("job_started", { step });
    try {
      const summary = await dispatch(step);
      const status = String(summary.status ?? "SUCCESS");
      log.info("job_finished", { step, status });
      return { step, status, summary };
    } finally {
      // Best-effort: the session lock also dies with the connection.
      await lockClient
        .query("SELECT pg_advisory_unlock($1, $2)", [LOCK_CLASS, LOCK_ID])
        .catch(() => undefined);
    }
  });
}
