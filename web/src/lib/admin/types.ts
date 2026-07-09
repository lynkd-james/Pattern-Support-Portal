// =============================================================================
// Admin UI vocabulary (Stage 10b, decision D4) — enum VALUE LISTS for filter
// dropdowns plus display-copy maps. These mirror structural schema enums
// (portal_stage, priority_level, visibility_state, audit_source), NOT business
// config: status mappings and SLA targets remain data-driven and never appear
// here. Also the URL filter-state codec (refinement R3: the URL is the state).
// =============================================================================

import type { AdminPriority, AdminStage, AdminVisibility } from "./contracts";
import type { AdminTicketQuery } from "./api";

export const STAGES: AdminStage[] = [
  "NEW",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "ON_HOLD",
  "BUSINESS_REVIEW",
  "RESOLVED",
  "CLOSED",
  "REOPENED",
];

export const PRIORITIES: AdminPriority[] = ["P1", "P2", "P3", "P4"];

export const VISIBILITIES: Array<AdminVisibility | "none"> = [
  "published",
  "ready_for_customer",
  "internal_only",
  "hidden_from_customer",
  "none",
];

export const VISIBILITY_LABELS: Record<string, string> = {
  published: "Published",
  ready_for_customer: "Ready for customer",
  internal_only: "Internal only",
  hidden_from_customer: "Hidden from customer",
  none: "Not projected",
};

export const CHANGE_SOURCES = ["SYNC", "TRANSFORM", "ADMIN", "SYSTEM", "PORTAL"] as const;

export const ENTITY_TYPES = ["internal_ticket", "customer_ticket", "portal_user", "admin_user"] as const;

/** Sort options exposed in the tickets toolbar (must stay within the API whitelist). */
export const TICKET_SORTS: Array<{ value: string; label: string }> = [
  { value: "createdAt:desc", label: "Newest received" },
  { value: "createdAt:asc", label: "Oldest received" },
  { value: "updatedAt:desc", label: "Recently updated" },
  { value: "updatedAt:asc", label: "Least recently updated" },
];

/** Quarantine reason explanations (sync/resolve.ts QuarantineReason codes). */
export const QUARANTINE_EXPLANATIONS: Record<string, string> = {
  NO_CUSTOM_ID: "The ClickUp task has no ticket custom id — it cannot be identified as a support ticket.",
  MISSING_CREATED_TIMESTAMP: "The task has no created timestamp, so lifecycle and SLA maths are impossible.",
  BU_UNDETERMINED: "The Customer field matched no known business unit — never guessed, so the ticket is held here.",
  SLA_PRIORITY_MISSING: "No recognised SLA priority label (P1–P4) is set on the task.",
  SLA_PRIORITY_MULTIPLE: "More than one SLA priority label is set — ambiguous, so nothing was assumed.",
  // Historical only: retired when P4 became first-class (unknown labels now
  // fall through to SLA_PRIORITY_MISSING). Kept so old sync runs still render.
  SLA_PRIORITY_UNSUPPORTED: "The SLA priority label was not supported at the time of this sync (retired reason).",
  STATUS_UNMAPPED: "The ClickUp status has no row in status_mappings — mappings are data, not code.",
};

// ---- URL filter-state codec (R3) --------------------------------------------
// The URL is the single source of filter state: bookmarkable, refresh-safe,
// Back-button-correct, shareable. Slugs (readable) live in the URL; the UI
// resolves slug -> id via /api/admin/reference before calling the API.

export interface TicketFilterState {
  q: string;
  customer: string | null; // account slug
  bu: string | null; // business-unit slug
  stage: string | null;
  priority: string | null;
  visibility: string | null;
  published: boolean | null;
  shared: boolean | null;
  from: string | null; // received range (YYYY-MM-DD)
  to: string | null;
  updatedFrom: string | null;
  updatedTo: string | null;
  sort: string;
  page: number;
}

export const DEFAULT_TICKET_FILTERS: TicketFilterState = {
  q: "",
  customer: null,
  bu: null,
  stage: null,
  priority: null,
  visibility: null,
  published: null,
  shared: null,
  from: null,
  to: null,
  updatedFrom: null,
  updatedTo: null,
  sort: "createdAt:desc",
  page: 1,
};

const boolOrNull = (v: string | null): boolean | null =>
  v === "true" ? true : v === "false" ? false : null;

export function ticketFiltersFromParams(sp: URLSearchParams): TicketFilterState {
  return {
    q: sp.get("q") ?? "",
    customer: sp.get("customer"),
    bu: sp.get("bu"),
    stage: sp.get("stage"),
    priority: sp.get("priority"),
    visibility: sp.get("visibility"),
    published: boolOrNull(sp.get("published")),
    shared: boolOrNull(sp.get("shared")),
    from: sp.get("from"),
    to: sp.get("to"),
    updatedFrom: sp.get("updatedFrom"),
    updatedTo: sp.get("updatedTo"),
    sort: sp.get("sort") ?? DEFAULT_TICKET_FILTERS.sort,
    page: Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1),
  };
}

export function ticketFiltersToParams(f: TicketFilterState): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.customer) p.set("customer", f.customer);
  if (f.bu) p.set("bu", f.bu);
  if (f.stage) p.set("stage", f.stage);
  if (f.priority) p.set("priority", f.priority);
  if (f.visibility) p.set("visibility", f.visibility);
  if (f.published !== null) p.set("published", String(f.published));
  if (f.shared !== null) p.set("shared", String(f.shared));
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.updatedFrom) p.set("updatedFrom", f.updatedFrom);
  if (f.updatedTo) p.set("updatedTo", f.updatedTo);
  if (f.sort !== DEFAULT_TICKET_FILTERS.sort) p.set("sort", f.sort);
  if (f.page > 1) p.set("page", String(f.page));
  return p;
}

/**
 * Map URL filter state to the API query. Slug -> id resolution uses the
 * reference lists; an unknown slug yields an impossible id so results are
 * honestly empty rather than silently unfiltered.
 */
export function ticketFiltersToQuery(
  f: TicketFilterState,
  reference: { accounts: Array<{ id: string; slug: string }>; businessUnits: Array<{ id: string; slug: string }> } | null
): AdminTicketQuery {
  const NO_MATCH = "00000000-0000-0000-0000-000000000000";
  const accountId = f.customer
    ? reference?.accounts.find((a) => a.slug === f.customer)?.id ?? NO_MATCH
    : null;
  const businessUnitId = f.bu
    ? reference?.businessUnits.find((b) => b.slug === f.bu)?.id ?? NO_MATCH
    : null;
  return {
    search: f.q || null,
    accountId,
    businessUnitId,
    stage: f.stage,
    priority: f.priority,
    visibility: f.visibility,
    published: f.published,
    shared: f.shared,
    receivedFrom: f.from ? `${f.from}T00:00:00+02:00` : null,
    receivedTo: f.to ? `${f.to}T23:59:59+02:00` : null,
    updatedFrom: f.updatedFrom ? `${f.updatedFrom}T00:00:00+02:00` : null,
    updatedTo: f.updatedTo ? `${f.updatedTo}T23:59:59+02:00` : null,
    sort: f.sort,
    page: f.page,
  };
}
