// =============================================================================
// Admin display formatting (Stage 10b, refinement R5 — FROZEN rules).
//
// - Dates: en-ZA, Africa/Johannesburg, "dd MMM yyyy HH:mm" (same behaviour as
//   the customer portal's formatter — re-declared here, NOT imported, so the
//   realms stay structurally independent).
// - Recency: relative time in the cell, exact timestamp on hover (title attr —
//   the component pairs relativeTime() with formatDateTime()).
// - Durations: "Xm Ys" / "Xs".
// - Badge tones: the brand's semantic roles (danger = breached/P1/FAILED,
//   warn = at-risk/P2/PARTIAL, success = healthy, muted = terminal/quiet).
// - Honest-NULL origin renders exactly "— Shared ticket" everywhere.
// - Missing values render "—", never blank cells.
//
// Pure functions only (unit-tested); no fetch, no React.
// =============================================================================

import type { AdminPriority, AdminSlaState, AdminStage, AdminSyncStatus, AdminVisibility } from "./contracts";

const ZA_TZ = "Africa/Johannesburg";

export const EMPTY = "—";

/** Honest-NULL origin (Stage 9a): the one frozen wording, used on every page. */
export const SHARED_ORIGIN_LABEL = "— Shared ticket";

export function formatDateTime(isoValue: string | null): string {
  if (!isoValue) return EMPTY;
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return EMPTY;
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: ZA_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatDate(isoValue: string | null): string {
  if (!isoValue) return EMPTY;
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return EMPTY;
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: ZA_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

/** Compact relative time ("3m ago", "2h ago", "5d ago"); exact time goes on hover. */
export function relativeTime(isoValue: string | null, now: Date = new Date()): string {
  if (!isoValue) return EMPTY;
  const t = new Date(isoValue).getTime();
  if (Number.isNaN(t)) return EMPTY;
  const diff = now.getTime() - t;
  if (diff < 0) return formatDateTime(isoValue);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d ago`;
  return formatDate(isoValue);
}

/** Sync-run duration from start/finish ISO strings: "Xm Ys" / "Xs". */
export function formatDuration(startIso: string, finishIso: string | null): string {
  if (!finishIso) return EMPTY;
  const ms = new Date(finishIso).getTime() - new Date(startIso).getTime();
  if (Number.isNaN(ms) || ms < 0) return EMPTY;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// ---- labels ------------------------------------------------------------------

export const STAGE_LABELS: Record<AdminStage, string> = {
  NEW: "New",
  ACKNOWLEDGED: "Acknowledged",
  IN_PROGRESS: "In Progress",
  ON_HOLD: "On Hold",
  BUSINESS_REVIEW: "Business Review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  REOPENED: "Reopened",
};

export const SLA_LABELS: Record<AdminSlaState, string> = {
  // P4 (and any unpoliced ticket) has no SLA commitments — say so, don't dash.
  NOT_APPLICABLE: "No SLA",
  PENDING: "On Track",
  AT_RISK: "At Risk",
  MET: "Met",
  BREACHED: "Breached",
};

// ---- badge tones (brand semantic roles; whole strings for Tailwind's scanner) --

const TONE = {
  danger: "bg-[rgba(226,106,96,0.16)] text-[#E26A60] ring-[rgba(226,106,96,0.34)]",
  warn: "bg-[rgba(240,184,84,0.16)] text-[#F0B854] ring-[rgba(240,184,84,0.34)]",
  success: "bg-[rgba(108,192,138,0.16)] text-[#6CC08A] ring-[rgba(108,192,138,0.30)]",
  info: "bg-[rgba(111,166,224,0.16)] text-[#6FA6E0] ring-[rgba(111,166,224,0.30)]",
  muted: "bg-white/5 text-[#9C8E78] ring-[#3A2D1F]",
} as const;

export const PRIORITY_BADGE: Record<AdminPriority, string> = {
  P1: TONE.danger,
  P2: TONE.warn,
  P3: TONE.muted,
  P4: TONE.info, // no SLA commitments — informational, not urgency-toned
};

export const SLA_BADGE: Record<AdminSlaState, string> = {
  NOT_APPLICABLE: TONE.muted,
  PENDING: TONE.info,
  AT_RISK: TONE.warn,
  MET: TONE.success,
  BREACHED: TONE.danger,
};

export const STAGE_BADGE: Record<AdminStage, string> = {
  NEW: TONE.muted,
  ACKNOWLEDGED: TONE.info,
  IN_PROGRESS: TONE.warn,
  ON_HOLD: TONE.warn,
  BUSINESS_REVIEW: TONE.info,
  RESOLVED: TONE.success,
  CLOSED: TONE.muted,
  REOPENED: TONE.danger,
};

export const VISIBILITY_BADGE: Record<AdminVisibility, string> = {
  published: TONE.success,
  ready_for_customer: TONE.info,
  internal_only: TONE.muted,
  hidden_from_customer: TONE.warn,
};

export const SYNC_STATUS_BADGE: Record<AdminSyncStatus, string> = {
  RUNNING: TONE.info,
  SUCCESS: TONE.success,
  PARTIAL: TONE.warn,
  FAILED: TONE.danger,
};
