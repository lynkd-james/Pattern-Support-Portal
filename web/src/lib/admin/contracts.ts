// =============================================================================
// ADMIN API contracts (Stage 10b, refinement R1) — THE single definition of
// every /api/admin/* response shape. server/admin/queries.ts returns these
// types, the API routes serialise them, and the admin UI consumes them, so a
// server-side shape change the UI doesn't know about is a compile error.
//
// Client-safe: types only, zero imports, no server code. Lives under lib/admin
// so a customer-side import is caught by the import-boundary test.
// =============================================================================

// ---- enum vocabularies (structural schema enums, not business config) ------

export type AdminPriority = "P1" | "P2" | "P3" | "P4";

export type AdminStage =
  | "NEW"
  | "ACKNOWLEDGED"
  | "IN_PROGRESS"
  | "ON_HOLD"
  | "BUSINESS_REVIEW"
  | "RESOLVED"
  | "CLOSED"
  | "REOPENED";

export type AdminSlaState = "NOT_APPLICABLE" | "PENDING" | "AT_RISK" | "MET" | "BREACHED";

export type AdminVisibility =
  | "internal_only"
  | "ready_for_customer"
  | "published"
  | "hidden_from_customer";

export type AdminChangeSource = "SYNC" | "TRANSFORM" | "ADMIN" | "SYSTEM" | "PORTAL";

export type AdminSyncStatus = "RUNNING" | "SUCCESS" | "PARTIAL" | "FAILED";

// ---- GET /api/admin/session -------------------------------------------------

export interface AdminSession {
  email: string;
  displayName: string | null;
  role: string;
}

// ---- GET /api/admin/stats ----------------------------------------------------

/** Latest terminal (non-RUNNING) run per source system — the watermark row. */
export interface AdminStatsSync {
  sourceSystem: string;
  status: AdminSyncStatus;
  finishedAt: string | null;
  cursor: string | null;
}

export interface AdminStats {
  tickets: { total: number; open: number; closed: number };
  exposure: { published: number; internalOnly: number; shared: number };
  quarantinedLatest: number;
  slaBreaches: number;
  sync: AdminStatsSync[];
}

// ---- GET /api/admin/tickets --------------------------------------------------

export interface AdminTicketSummary {
  id: string;
  ticketNumber: string;
  title: string;
  priority: AdminPriority;
  stage: AdminStage;
  businessUnits: string[];
  shared: boolean;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminPagination {
  page: number;
  pageSize: number;
  totalItems: number;
}

export interface AdminTicketListResponse {
  data: AdminTicketSummary[];
  pagination: AdminPagination;
}

// ---- GET /api/admin/tickets/[id] ----------------------------------------------

/** Explicit internal-ticket DTO (replaces the 10a `SELECT it.*` blob). */
export interface AdminInternalTicket {
  id: string;
  ticketNumber: string;
  clickupTaskId: string;
  sourceEmailMessageId: string | null;
  // ORIGIN (Stage 9a): reporting only, honest-NULL when shared.
  originAccountId: string | null;
  originBusinessUnitId: string | null;
  visibilityBusinessUnits: string[]; // BU slugs from the junction (sole visibility source)
  titleInternal: string;
  descriptionInternal: string | null;
  requesterName: string | null;
  requesterEmail: string | null;
  customerSummary: string | null;
  priority: AdminPriority;
  stage: AdminStage;
  clickupRawStatus: string | null;
  visibilityState: AdminVisibility;
  createdAt: string;
  acknowledgedAt: string | null;
  businessReviewAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  responseDueAt: string | null;
  resolutionDueAt: string | null;
  responseSlaState: AdminSlaState;
  resolutionSlaState: AdminSlaState;
  reopenCount: number;
  lastSyncedAt: string | null;
  updatedAt: string;
}

export interface AdminTicketEvent {
  fromStage: AdminStage | null;
  toStage: AdminStage;
  changedAt: string;
  source: string;
}

/** One customer-layer projection row (EXPOSURE — always labelled as such). */
export interface AdminProjection {
  businessUnitId: string;
  businessUnitSlug: string;
  accountId: string;
  accountSlug: string;
  visibilityState: AdminVisibility;
  publishedAt: string | null;
}

export interface AdminTicketDetail {
  ticket: AdminInternalTicket;
  timeline: AdminTicketEvent[];
  projections: AdminProjection[];
  audit: AdminTicketAuditEntry[];
}

/** Ticket-scoped audit slice on the detail response. */
export interface AdminTicketAuditEntry {
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  changeSource: AdminChangeSource;
  actor: string | null;
  occurredAt: string;
}

// ---- GET /api/admin/sync-runs --------------------------------------------------

export interface AdminSyncRun {
  id: number;
  sourceSystem: string;
  status: AdminSyncStatus;
  startedAt: string;
  finishedAt: string | null;
  ticketsSeen: number;
  ticketsUpserted: number;
  errorCount: number;
  quarantined: number;
  cursor: string | null;
}

// ---- GET /api/admin/audit --------------------------------------------------------

export interface AdminAuditEvent {
  id: number;
  entityType: string;
  entityId: string;
  /** Human label — the ticket number when entity_type='internal_ticket'. */
  entityLabel: string | null;
  accountId: string | null;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  changeSource: AdminChangeSource;
  actor: string | null;
  occurredAt: string;
}

// ---- GET /api/admin/quarantine ------------------------------------------------------

export interface AdminQuarantineItem {
  reason: string;
  customId: string | null;
  detail: string;
}

export interface AdminQuarantineView {
  total: number;
  byReason: Record<string, number>;
  items: AdminQuarantineItem[];
  sourceRunId: number | null;
}

// ---- GET /api/admin/reference ---------------------------------------------------------

export interface AdminReferenceAccount {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface AdminReferenceBusinessUnit {
  id: string;
  accountId: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export interface AdminReference {
  accounts: AdminReferenceAccount[];
  businessUnits: AdminReferenceBusinessUnit[];
}
