// =============================================================================
// Dashboard summary cards — PURE FRONTEND AGGREGATION (V1 locked decision).
//
// Constraints (must hold):
//   * Derived ENTIRELY from the already-loaded /api/tickets response.
//   * No backend computation, no new endpoint, no additional API calls.
//   * Reflects the CURRENT FILTER CONTEXT: the input is whatever the list
//     endpoint returned for the active filters, so the counts are automatically
//     filter-scoped.
//
// NOTE ON SCOPE: the input is the loaded dataset, i.e. the current page of
// results. The dashboard requests the contract's max pageSize (100) so the
// cards are as representative as possible without an extra call. If a filtered
// set exceeds the loaded page, cards reflect the loaded page only — this is the
// intended trade-off of the "no extra calls" rule, not a defect.
// =============================================================================

import type { TicketListItem } from "./types";

export interface DashboardSummary {
  totalOpen: number;   // stage NOT IN (RESOLVED, CLOSED)
  atRiskSla: number;   // resolutionSlaState === AT_RISK
  breachedSla: number; // resolutionSlaState === BREACHED
  resolved: number;    // stage === RESOLVED
}

const CLOSED_STAGES = new Set(["RESOLVED", "CLOSED"]);

export function computeSummary(tickets: TicketListItem[]): DashboardSummary {
  const summary: DashboardSummary = {
    totalOpen: 0,
    atRiskSla: 0,
    breachedSla: 0,
    resolved: 0,
  };

  for (const t of tickets) {
    if (!CLOSED_STAGES.has(t.stage)) summary.totalOpen += 1;
    if (t.resolutionSlaState === "AT_RISK") summary.atRiskSla += 1;
    if (t.resolutionSlaState === "BREACHED") summary.breachedSla += 1;
    if (t.stage === "RESOLVED") summary.resolved += 1;
  }

  return summary;
}
