// =============================================================================
// Display helpers — the frontend owns all human-readable labels, badge tones,
// and time formatting. The API returns raw enum codes and ISO-8601 UTC strings
// only; nothing here changes the contract, it just presents it.
// Colours use the Pattern brand tokens (accent/danger/warn/success/info) tuned
// for the warm dark surface. Semantic roles unchanged: danger = breached,
// warn = at risk, success = healthy.
// =============================================================================

import type { PortalStage, PriorityLevel, SlaState } from "./types";

export const STAGE_LABELS: Record<PortalStage, string> = {
  NEW: "New",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  BUSINESS_REVIEW: "Business Review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};

export const PRIORITY_LABELS: Record<PriorityLevel, string> = {
  P1: "P1",
  P2: "P2",
  P3: "P3",
};

export const SLA_LABELS: Record<SlaState, string> = {
  NOT_APPLICABLE: "—",
  PENDING: "On Track",
  AT_RISK: "At Risk",
  MET: "Met",
  BREACHED: "Breached",
};

// Kept as whole strings so Tailwind's content scanner picks them up.
export const SLA_BADGE_CLASSES: Record<SlaState, string> = {
  NOT_APPLICABLE: "bg-white/5 text-[#9C8E78] ring-[#3A2D1F]",
  PENDING: "bg-[rgba(111,166,224,0.16)] text-[#6FA6E0] ring-[rgba(111,166,224,0.30)]",
  AT_RISK: "bg-[rgba(240,184,84,0.16)] text-[#F0B854] ring-[rgba(240,184,84,0.34)]",
  MET: "bg-[rgba(108,192,138,0.16)] text-[#6CC08A] ring-[rgba(108,192,138,0.30)]",
  BREACHED: "bg-[rgba(226,106,96,0.16)] text-[#E26A60] ring-[rgba(226,106,96,0.34)]",
};

export const PRIORITY_BADGE_CLASSES: Record<PriorityLevel, string> = {
  P1: "bg-[rgba(226,106,96,0.16)] text-[#E26A60] ring-[rgba(226,106,96,0.34)]",
  P2: "bg-[rgba(240,184,84,0.16)] text-[#F0B854] ring-[rgba(240,184,84,0.34)]",
  P3: "bg-white/5 text-[#9C8E78] ring-[#3A2D1F]",
};

export const STAGE_DOT_CLASSES: Record<PortalStage, string> = {
  NEW: "bg-[#5C5142]",
  ACKNOWLEDGED: "bg-[#6FA6E0]",
  IN_PROGRESS: "bg-[#F5A14B]",
  ON_HOLD: "bg-[#F0B854]",
  BUSINESS_REVIEW: "bg-[#C77A28]",
  RESOLVED: "bg-[#6CC08A]",
  CLOSED: "bg-[#5C5142]",
  REOPENED: "bg-[#E26A60]",
};

const ZA_TZ = "Africa/Johannesburg";

// Format an ISO-8601 UTC timestamp for display in SAST.
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: ZA_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

// A small relative hint for SLA due times, computed client-side from dueAt.
// The SLA *state* always comes from the server; this is presentation only.
export function dueHint(dueAt: string | null, now: Date = new Date()): string {
  if (!dueAt) return "";
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return "";
  const diffMs = due - now.getTime();
  const overdue = diffMs < 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const span = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return overdue ? `overdue ${span}` : `in ${span}`;
}
