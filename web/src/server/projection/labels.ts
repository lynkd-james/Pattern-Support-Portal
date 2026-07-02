// =============================================================================
// Customer-facing labels for portal stages.
//
// The portal_stage values are ALREADY the sanitised, customer-facing taxonomy
// (raw ClickUp statuses are mapped to them by the sync engine). This module only
// provides human-friendly display labels for the customer timeline — it does NOT
// re-map statuses (that logic lives solely in the sync engine).
// =============================================================================

export const STAGE_LABELS: Readonly<Record<string, string>> = {
  NEW: "Logged",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In progress",
  ON_HOLD: "On hold",
  BUSINESS_REVIEW: "In business review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}
