// =============================================================================
// SLA + milestone computation engine (Stage 7).
//
//   internal_ticket_events  ->  milestones (business_review_at, closed_at)
//   sla_policies + sla_calendars + timestamps  ->  SLA snapshot
//     -> internal_tickets (milestones + due-times + SLA states)
//
// Runs a full scan of non-deleted internal tickets each run, because SLA states
// are TIME-DEPENDENT (an untouched open ticket can move PENDING -> AT_RISK ->
// BREACHED as the clock advances). Writes only when a value actually changes, so
// the projection's updated_at watermark isn't churned needlessly. Policy targets
// are read entirely from sla_policies (never hardcoded); with no matching policy
// a ticket resolves to NOT_APPLICABLE. No pause behaviour (Stage 7 decision).
// =============================================================================

import type { PoolClient } from "pg";
import { query, withTransaction } from "../db";
import { createLogger, type Logger } from "../logger";
import type { BusinessCalendar, BusinessWindow } from "./calendar";
import { computeSlaSnapshot, type SlaPolicyValues, type SlaState } from "./sla";

const BATCH = 500;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export interface SlaRunSummary {
  runId: number | null;
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  processed: number;
  updated: number;
  unchanged: number;
  notApplicable: number;
  failed: number;
  durationMs: number;
}

interface PolicyRow {
  id: string;
  account_id: string | null;
  business_unit_id: string | null;
  priority: string;
  calendar_id: string | null;
  response_target_minutes: number;
  resolution_target_minutes: number;
  at_risk_threshold_pct: number;
}

interface TicketRow {
  id: string;
  account_id: string;
  business_unit_id: string;
  priority: string;
  created_at: Date;
  acknowledged_at: Date | null;
  business_review_at: Date | null;
  closed_at: Date | null;
  response_due_at: Date | null;
  resolution_due_at: Date | null;
  response_sla_state: string;
  resolution_sla_state: string;
  applied_sla_policy_id: string | null;
  updated_at: Date;
}

// ---- reference data --------------------------------------------------------

async function loadCalendars(): Promise<Map<string, BusinessCalendar>> {
  const cals = await query<{ id: string; timezone: string; business_hours: BusinessWindow[] }>(
    "SELECT id, timezone, business_hours FROM sla_calendars"
  );
  const holRes = await query<{ calendar_id: string; holiday_date: Date }>(
    "SELECT calendar_id, holiday_date FROM sla_calendar_holidays"
  );
  const holidaysByCal = new Map<string, Set<string>>();
  for (const h of holRes.rows) {
    const key = new Date(h.holiday_date).toISOString().slice(0, 10);
    if (!holidaysByCal.has(h.calendar_id)) holidaysByCal.set(h.calendar_id, new Set());
    holidaysByCal.get(h.calendar_id)!.add(key);
  }
  const map = new Map<string, BusinessCalendar>();
  for (const c of cals.rows) {
    map.set(c.id, {
      timezone: c.timezone,
      windows: Array.isArray(c.business_hours) ? c.business_hours : [],
      holidays: holidaysByCal.get(c.id) ?? new Set<string>(),
    });
  }
  return map;
}

async function loadPolicies(): Promise<PolicyRow[]> {
  const res = await query<PolicyRow>(
    `SELECT id, account_id, business_unit_id, priority, calendar_id,
            response_target_minutes, resolution_target_minutes, at_risk_threshold_pct
       FROM sla_policies
      WHERE is_active = TRUE
        AND effective_from <= now()
        AND (effective_to IS NULL OR effective_to > now())`
  );
  return res.rows;
}

/** Most-specific applicable policy: business_unit > account > global; priority must match. */
function resolvePolicy(
  policies: PolicyRow[],
  accountId: string,
  businessUnitId: string,
  priority: string
): PolicyRow | null {
  let best: PolicyRow | null = null;
  let bestScore = -1;
  for (const p of policies) {
    if (p.priority !== priority) continue;
    if (p.account_id !== null && p.account_id !== accountId) continue;
    if (p.business_unit_id !== null && p.business_unit_id !== businessUnitId) continue;
    const score = (p.business_unit_id ? 2 : 0) + (p.account_id ? 1 : 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

// ---- run bookkeeping (source_system = 'sla') -------------------------------

async function openRun(now: Date): Promise<number> {
  const res = await query<{ id: string }>(
    `INSERT INTO sync_runs (source_system, status, cursor) VALUES ('sla','RUNNING',$1) RETURNING id`,
    [now.toISOString()]
  );
  return Number(res.rows[0].id);
}

async function closeRun(runId: number, s: SlaRunSummary, details: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE sync_runs SET status=$2, finished_at=now(),
        tickets_seen=$3, tickets_upserted=$4, error_count=$5, details=$6::jsonb
      WHERE id=$1`,
    [runId, s.status, s.processed, s.updated, s.failed, JSON.stringify(details)]
  );
}

// ---- per-ticket derivation -------------------------------------------------

function eqDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

async function deriveMilestones(
  client: PoolClient,
  ticketId: string
): Promise<{ businessReviewAt: Date | null; closedAt: Date | null }> {
  const res = await client.query<{ to_stage: string; first_at: Date }>(
    `SELECT to_stage, MIN(changed_at) AS first_at
       FROM internal_ticket_events
      WHERE internal_ticket_id = $1 AND to_stage IN ('BUSINESS_REVIEW','CLOSED')
      GROUP BY to_stage`,
    [ticketId]
  );
  let businessReviewAt: Date | null = null;
  let closedAt: Date | null = null;
  for (const r of res.rows) {
    if (r.to_stage === "BUSINESS_REVIEW") businessReviewAt = r.first_at;
    else if (r.to_stage === "CLOSED") closedAt = r.first_at;
  }
  return { businessReviewAt, closedAt };
}

async function processTicket(
  t: TicketRow,
  now: Date,
  policies: PolicyRow[],
  calendars: Map<string, BusinessCalendar>
): Promise<{ updated: boolean; notApplicable: boolean }> {
  return withTransaction(async (client) => {
    const { businessReviewAt, closedAt } = await deriveMilestones(client, t.id);

    const policyRow = resolvePolicy(policies, t.account_id, t.business_unit_id, t.priority);
    const policy: SlaPolicyValues | null = policyRow
      ? {
          id: policyRow.id,
          responseTargetMinutes: policyRow.response_target_minutes,
          resolutionTargetMinutes: policyRow.resolution_target_minutes,
          atRiskThresholdPct: policyRow.at_risk_threshold_pct,
        }
      : null;
    // calendar_id null => 24x7; otherwise the referenced business calendar.
    const calendar: BusinessCalendar | null = policyRow?.calendar_id
      ? calendars.get(policyRow.calendar_id) ?? null
      : null;

    const snap = computeSlaSnapshot({
      createdAt: t.created_at,
      acknowledgedAt: t.acknowledged_at,
      closedAt,
      now,
      policy,
      calendar,
    });

    const changed =
      !eqDate(businessReviewAt, t.business_review_at) ||
      !eqDate(closedAt, t.closed_at) ||
      !eqDate(snap.responseDueAt, t.response_due_at) ||
      !eqDate(snap.resolutionDueAt, t.resolution_due_at) ||
      snap.responseState !== (t.response_sla_state as SlaState) ||
      snap.resolutionState !== (t.resolution_sla_state as SlaState) ||
      (snap.appliedPolicyId ?? null) !== (t.applied_sla_policy_id ?? null);

    if (changed) {
      await client.query(
        `UPDATE internal_tickets
            SET business_review_at = $2, closed_at = $3,
                response_due_at = $4, resolution_due_at = $5,
                response_sla_state = $6::sla_state, resolution_sla_state = $7::sla_state,
                applied_sla_policy_id = $8, sla_paused_ms = 0, updated_at = now()
          WHERE id = $1`,
        [
          t.id,
          businessReviewAt,
          closedAt,
          snap.responseDueAt,
          snap.resolutionDueAt,
          snap.responseState,
          snap.resolutionState,
          snap.appliedPolicyId,
        ]
      );
    }
    return { updated: changed, notApplicable: policy === null };
  });
}

// ---- engine ----------------------------------------------------------------

export async function runSlaComputation(options: { logger?: Logger } = {}): Promise<SlaRunSummary> {
  const startedAt = Date.now();
  const now = new Date();
  const log = (options.logger ?? createLogger("sla")).child({ run: `sla-${startedAt}` });

  const calendars = await loadCalendars();
  const policies = await loadPolicies();
  const runId = await openRun(now);
  log.info("sla_started", { calendars: calendars.size, policies: policies.length });

  const c = { processed: 0, updated: 0, unchanged: 0, notApplicable: 0, failed: 0 };
  const errors: Array<{ internalTicketId: string; reason: string }> = [];

  let status: SlaRunSummary["status"] = "SUCCESS";
  let lastId = ZERO_UUID;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await query<TicketRow>(
        `SELECT id, account_id, business_unit_id, priority, created_at, acknowledged_at,
                business_review_at, closed_at, response_due_at, resolution_due_at,
                response_sla_state, resolution_sla_state, applied_sla_policy_id, updated_at
           FROM internal_tickets
          WHERE deleted_at IS NULL AND id > $1
          ORDER BY id ASC
          LIMIT ${BATCH}`,
        [lastId]
      );
      if (rows.rows.length === 0) break;

      for (const t of rows.rows) {
        c.processed += 1;
        lastId = t.id;
        try {
          const r = await processTicket(t, now, policies, calendars);
          if (r.updated) c.updated += 1;
          else c.unchanged += 1;
          if (r.notApplicable) c.notApplicable += 1;
        } catch (err) {
          c.failed += 1;
          errors.push({ internalTicketId: t.id, reason: err instanceof Error ? err.message : String(err) });
          log.error("ticket_sla_failed", { internalTicket: t.id, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      if (rows.rows.length < BATCH) break;
    }
    status = c.failed > 0 ? "PARTIAL" : "SUCCESS";
  } catch (fatal) {
    status = "FAILED";
    errors.push({ internalTicketId: "-", reason: fatal instanceof Error ? fatal.message : String(fatal) });
    log.error("sla_fatal", { reason: fatal instanceof Error ? fatal.message : String(fatal) });
  }

  const summary: SlaRunSummary = {
    runId,
    status,
    processed: c.processed,
    updated: c.updated,
    unchanged: c.unchanged,
    notApplicable: c.notApplicable,
    failed: c.failed,
    durationMs: Date.now() - startedAt,
  };
  await closeRun(runId, summary, { ...c, durationMs: summary.durationMs, errors });
  log.info("sla_finished", { ...summary });
  return summary;
}
