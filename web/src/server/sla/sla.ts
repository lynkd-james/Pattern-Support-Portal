// =============================================================================
// SLA snapshot computation (pure). Given a ticket's timestamps, the applicable
// policy targets, and a business calendar, derive due-times and SLA states.
//
// Response SLA:   created_at -> acknowledged_at
// Resolution SLA: created_at -> closed_at
// No pause behaviour (Stage 7 decision).
//
// State semantics per dimension:
//   * milestone reached  -> MET if reached on/before due, else BREACHED
//   * not yet reached     -> BREACHED if now past due; AT_RISK once past the
//                            at-risk threshold; otherwise PENDING
//   * no applicable policy -> NOT_APPLICABLE (due-times null)
// =============================================================================

import { addBusinessMinutes, type BusinessCalendar } from "./calendar";

export type SlaState = "NOT_APPLICABLE" | "PENDING" | "AT_RISK" | "MET" | "BREACHED";

export interface SlaPolicyValues {
  id: string;
  responseTargetMinutes: number;
  resolutionTargetMinutes: number;
  atRiskThresholdPct: number; // 1-100
}

export interface SlaSnapshotInput {
  createdAt: Date;
  acknowledgedAt: Date | null;
  closedAt: Date | null;
  now: Date;
  policy: SlaPolicyValues | null;
  calendar: BusinessCalendar | null;
}

export interface SlaSnapshot {
  responseDueAt: Date | null;
  resolutionDueAt: Date | null;
  responseState: SlaState;
  resolutionState: SlaState;
  appliedPolicyId: string | null;
}

function dimensionState(
  createdMs: number,
  targetMinutes: number,
  atRiskPct: number,
  milestoneMs: number | null,
  nowMs: number,
  cal: BusinessCalendar | null
): { dueMs: number; state: SlaState } {
  const dueMs = addBusinessMinutes(createdMs, targetMinutes, cal);
  if (milestoneMs !== null) {
    return { dueMs, state: milestoneMs <= dueMs ? "MET" : "BREACHED" };
  }
  if (nowMs > dueMs) return { dueMs, state: "BREACHED" };
  const atRiskMinutes = Math.floor((targetMinutes * atRiskPct) / 100);
  const atRiskMs = addBusinessMinutes(createdMs, atRiskMinutes, cal);
  return { dueMs, state: nowMs >= atRiskMs ? "AT_RISK" : "PENDING" };
}

export function computeSlaSnapshot(input: SlaSnapshotInput): SlaSnapshot {
  if (!input.policy) {
    return {
      responseDueAt: null,
      resolutionDueAt: null,
      responseState: "NOT_APPLICABLE",
      resolutionState: "NOT_APPLICABLE",
      appliedPolicyId: null,
    };
  }

  const createdMs = input.createdAt.getTime();
  const nowMs = input.now.getTime();
  const ackMs = input.acknowledgedAt ? input.acknowledgedAt.getTime() : null;
  const closedMs = input.closedAt ? input.closedAt.getTime() : null;

  const resp = dimensionState(
    createdMs,
    input.policy.responseTargetMinutes,
    input.policy.atRiskThresholdPct,
    ackMs,
    nowMs,
    input.calendar
  );
  const reso = dimensionState(
    createdMs,
    input.policy.resolutionTargetMinutes,
    input.policy.atRiskThresholdPct,
    closedMs,
    nowMs,
    input.calendar
  );

  return {
    responseDueAt: new Date(resp.dueMs),
    resolutionDueAt: new Date(reso.dueMs),
    responseState: resp.state,
    resolutionState: reso.state,
    appliedPolicyId: input.policy.id,
  };
}
