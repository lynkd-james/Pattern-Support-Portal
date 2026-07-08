// =============================================================================
// Expired-session cleanup engine (Stage 8d).
//
// Deletes portal_sessions rows that have been INVALID for longer than the
// retention window (docs/auth.md: "cleanup deletes rows expired/revoked for
// > 7 days"). A session is invalid when revoked, absolute-expired
// (expires_at mirrors created_at + SESSION_MAX_HOURS) or idle-expired
// (last_seen_at + SESSION_IDLE_HOURS in the past). Rows are kept for the
// retention window after becoming invalid so recent security investigations
// retain session evidence; the append-only audit_events log is never touched.
//
// Behaviour-preserving by construction: session VALIDITY continues to be
// enforced at resolution time (sessionStore.ts) — this engine only removes
// rows that resolution already treats as dead. Run accounting follows the
// other engines: one sync_runs row per run (source_system = 'sessions').
// =============================================================================

import { query } from "../db";
import { env } from "../env";
import { createLogger, type Logger } from "../logger";

const RETENTION_DAYS = 7;

export interface SessionCleanupSummary {
  runId: number | null;
  status: "SUCCESS" | "FAILED";
  deleted: number;
  retentionDays: number;
  durationMs: number;
}

async function openRun(): Promise<number> {
  const res = await query<{ id: string }>(
    `INSERT INTO sync_runs (source_system, status) VALUES ('sessions','RUNNING') RETURNING id`
  );
  return Number(res.rows[0].id);
}

async function closeRun(
  runId: number,
  s: SessionCleanupSummary,
  details: Record<string, unknown>
): Promise<void> {
  await query(
    `UPDATE sync_runs SET status=$2, finished_at=now(),
        tickets_seen=$3, tickets_upserted=0, error_count=$4, details=$5::jsonb
      WHERE id=$1`,
    [runId, s.status, s.deleted, s.status === "FAILED" ? 1 : 0, JSON.stringify(details)]
  );
}

export async function runSessionCleanup(
  options: { logger?: Logger } = {}
): Promise<SessionCleanupSummary> {
  const startedAt = Date.now();
  const log = (options.logger ?? createLogger("sessions")).child({
    run: `sessions-${startedAt}`,
  });
  const runId = await openRun();

  let deleted = 0;
  let status: SessionCleanupSummary["status"] = "SUCCESS";
  let errorReason: string | null = null;

  try {
    // Invalid for > RETENTION_DAYS via any of the three validity conditions
    // (mirrors sessionStore.sessionValidity, shifted by the retention window).
    const res = await query(
      `DELETE FROM portal_sessions
        WHERE (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => $1))
           OR (expires_at < now() - make_interval(days => $1))
           OR (last_seen_at + make_interval(hours => $2) < now() - make_interval(days => $1))`,
      [RETENTION_DAYS, env.sessionIdleHours]
    );
    deleted = res.rowCount ?? 0;
  } catch (err) {
    status = "FAILED";
    errorReason = err instanceof Error ? err.message : String(err);
    log.error("session_cleanup_failed", { reason: errorReason });
  }

  const summary: SessionCleanupSummary = {
    runId,
    status,
    deleted,
    retentionDays: RETENTION_DAYS,
    durationMs: Date.now() - startedAt,
  };
  await closeRun(runId, summary, {
    deleted,
    retentionDays: RETENTION_DAYS,
    idleHours: env.sessionIdleHours,
    durationMs: summary.durationMs,
    ...(errorReason ? { error: errorReason } : {}),
  });
  log.info("session_cleanup_finished", { ...summary });
  return summary;
}
