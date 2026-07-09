// =============================================================================
// API contract types — V1 (FROZEN). These mirror the agreed payloads for
//   GET /api/tickets, GET /api/tickets/{id}, GET /api/session
// exactly. The UI binds to these and nothing else. Do not extend without a
// corresponding contract change.
// =============================================================================

// P4 added 2026-07-09 (contract change: P4 = valid priority with no SLA
// commitments; SLA states arrive as NOT_APPLICABLE with null due-times).
export type PriorityLevel = "P1" | "P2" | "P3" | "P4";

export type PortalStage =
  | "NEW"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "ON_HOLD"
  | "BUSINESS_REVIEW"
  | "RESOLVED"
  | "CLOSED"
  | "REOPENED";

export type SlaState =
  | "NOT_APPLICABLE"
  | "PENDING"
  | "AT_RISK"
  | "MET"
  | "BREACHED";

export interface BusinessUnitRef {
  id: string;
  name: string;
}

// ---- GET /api/tickets ----------------------------------------------------

export interface TicketListItem {
  id: string;
  ticketNumber: string;
  title: string;
  priority: PriorityLevel;
  stage: PortalStage;
  businessUnit: BusinessUnitRef;
  createdAt: string;                 // ISO-8601 UTC
  responseSlaState: SlaState;
  resolutionSlaState: SlaState;
  responseDueAt: string | null;      // ISO-8601 UTC | null
  resolutionDueAt: string | null;    // ISO-8601 UTC | null
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface TicketListResponse {
  data: TicketListItem[];
  pagination: Pagination;
}

// Query parameters accepted by the list endpoint (all optional; server scopes
// the result to the session — these only ever narrow within the allowed set).
export interface TicketListQuery {
  page?: number;
  pageSize?: number;
  stage?: PortalStage | null;
  priority?: PriorityLevel | null;
  slaState?: SlaState | null;        // matches resolution SLA
  businessUnitId?: string | null;
  search?: string | null;
  sort?: string;                     // e.g. "createdAt:desc"
}

// ---- GET /api/tickets/{id} ----------------------------------------------

export interface TimelineEntry {
  stage: PortalStage;
  label: string | null;
  occurredAt: string;
}

export interface TicketDetail {
  id: string;
  ticketNumber: string;
  title: string;
  description: string | null;
  priority: PriorityLevel;
  stage: PortalStage;
  account: { id: string; name: string };
  businessUnit: BusinessUnitRef;
  createdAt: string;
  acknowledgedAt: string | null;
  businessReviewAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  sla: {
    response: { state: SlaState; dueAt: string | null };
    resolution: { state: SlaState; dueAt: string | null };
  };
  timeline: TimelineEntry[];
}

// ---- GET /api/session ----------------------------------------------------

export interface SessionResponse {
  user: { id: string; email: string; displayName: string | null };
  account: { id: string; name: string };
  accountWide: boolean;
  businessUnits: BusinessUnitRef[];
}

// ---- Error envelope ------------------------------------------------------

export interface ApiError {
  error: { code: string; message: string };
}
