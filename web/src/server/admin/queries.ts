// =============================================================================
// Admin read-only queries over the INTERNAL layer (Stage 10a; extended 10b).
//
// Staff see full fidelity: all internal tickets (incl. shared + unpublished),
// their visibility set, projection status, sync history, audit, and quarantine.
// This deliberately reads the internal layer — safe ONLY because every caller
// is behind requireAdminSession() (the admin realm). No business logic here;
// it maps stored values, mirroring how customer/queries.ts is a thin mapper.
// Never imported by customer code; imports no customer code.
//
// Stage 10b (invariant 10b-5): every change here is ADDITIVE — optional
// filters, additional response fields, new functions. Response shapes are the
// named DTOs in lib/admin/contracts.ts (refinement R1): defined once, returned
// here, serialised by the routes, consumed by the UI. `sort` is a MAP LOOKUP
// to a fixed ORDER BY string — user input is never interpolated into SQL.
// =============================================================================

import { query } from "../db";
import type {
  AdminAuditEvent,
  AdminChangeSource,
  AdminInternalTicket,
  AdminPriority,
  AdminProjection,
  AdminQuarantineView,
  AdminReference,
  AdminSlaState,
  AdminStage,
  AdminStats,
  AdminSyncRun,
  AdminSyncStatus,
  AdminTicketAuditEntry,
  AdminTicketDetail,
  AdminTicketEvent,
  AdminTicketListResponse,
  AdminVisibility,
} from "../../lib/admin/contracts";

const OPEN_STAGES = ["NEW", "ACKNOWLEDGED", "IN_PROGRESS", "ON_HOLD", "BUSINESS_REVIEW", "REOPENED"];

const iso = (v: Date | string | null): string | null =>
  v === null ? null : new Date(v).toISOString();

// ---- stats -------------------------------------------------------------------

/** Dashboard-home counts. "tickets" = canonical internal rows; "exposure" = customer projections. */
export async function getStats(): Promise<AdminStats> {
  const t = await query<{ total: string; open: string; closed: string; shared: string }>(
    `SELECT
       count(*) AS total,
       count(*) FILTER (WHERE current_stage = ANY($1::portal_stage[])) AS open,
       count(*) FILTER (WHERE current_stage IN ('RESOLVED','CLOSED')) AS closed,
       count(*) FILTER (WHERE (SELECT count(*) FROM internal_ticket_business_units j
                                WHERE j.internal_ticket_id = it.id) > 1) AS shared
     FROM internal_tickets it WHERE deleted_at IS NULL`,
    [OPEN_STAGES]
  );
  const ct = await query<{ published: string; breaches: string }>(
    `SELECT
       count(*) FILTER (WHERE visibility_state = 'published') AS published,
       count(*) FILTER (WHERE visibility_state = 'published'
                        AND (response_sla_state = 'BREACHED' OR resolution_sla_state = 'BREACHED')) AS breaches
     FROM customer_tickets`
  );
  const internalOnly = await query<{ n: string }>(
    `SELECT count(*) AS n FROM internal_tickets
      WHERE deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = internal_tickets.id
                         AND ct.visibility_state = 'published')`
  );
  // 10b: latest TERMINAL run per source — the server states per-source sync
  // status as a fact (a bounded recent-runs window can miss an old failure).
  const sync = await query<{ source_system: string; status: AdminSyncStatus; finished_at: Date | null; cursor: string | null }>(
    `SELECT DISTINCT ON (source_system) source_system, status, finished_at, cursor
       FROM sync_runs
      WHERE status <> 'RUNNING'
      ORDER BY source_system, id DESC`
  );
  const q = await getQuarantineLatest();

  const row = t.rows[0];
  return {
    tickets: { total: Number(row.total), open: Number(row.open), closed: Number(row.closed) },
    exposure: {
      published: Number(ct.rows[0].published),
      internalOnly: Number(internalOnly.rows[0].n),
      shared: Number(row.shared),
    },
    quarantinedLatest: q.total,
    slaBreaches: Number(ct.rows[0].breaches),
    sync: sync.rows.map((r) => ({
      sourceSystem: r.source_system,
      status: r.status,
      finishedAt: iso(r.finished_at),
      cursor: r.cursor,
    })),
  };
}

// ---- ticket list ----------------------------------------------------------------

export interface AdminTicketFilters {
  businessUnitId?: string | null;
  accountId?: string | null;
  stage?: string | null;
  priority?: string | null;
  shared?: boolean | null;
  published?: boolean | null;
  /** visibility_state of ≥1 projection row; special value 'none' = unprojected. */
  visibility?: string | null;
  receivedFrom?: string | null;
  receivedTo?: string | null;
  updatedFrom?: string | null;
  updatedTo?: string | null;
  search?: string | null;
  sort?: string | null;
  page?: number;
  pageSize?: number;
}

const VISIBILITY_VALUES = new Set(["internal_only", "ready_for_customer", "published", "hidden_from_customer"]);

// Whitelist map — the ONLY source of ORDER BY text (never user input).
const TICKET_SORTS: Record<string, string> = {
  "createdAt:desc": "it.created_at DESC, it.id",
  "createdAt:asc": "it.created_at ASC, it.id",
  "updatedAt:desc": "it.updated_at DESC, it.id",
  "updatedAt:asc": "it.updated_at ASC, it.id",
};

/** Valid ISO date/datetime or null — invalid input is ignored, never passed to Postgres. */
const validDate = (v: string | null | undefined): string | null =>
  v && !Number.isNaN(Date.parse(v)) ? v : null;

export async function listTickets(f: AdminTicketFilters): Promise<AdminTicketListResponse> {
  const page = Math.max(1, f.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, f.pageSize ?? 50));
  const where: string[] = ["it.deleted_at IS NULL"];
  const params: unknown[] = [];
  const add = (clause: string, v: unknown) => {
    params.push(v);
    where.push(clause.replace("$$", `$${params.length}`));
  };
  if (f.stage) add("it.current_stage = $$::portal_stage", f.stage);
  if (f.priority) add("it.priority = $$::priority_level", f.priority);
  if (f.businessUnitId) {
    add(
      "EXISTS (SELECT 1 FROM internal_ticket_business_units j WHERE j.internal_ticket_id = it.id AND j.business_unit_id = $$)",
      f.businessUnitId
    );
  }
  if (f.accountId) {
    add(
      `EXISTS (SELECT 1 FROM internal_ticket_business_units j
                 JOIN business_units b ON b.id = j.business_unit_id
                WHERE j.internal_ticket_id = it.id AND b.account_id = $$)`,
      f.accountId
    );
  }
  if (f.shared === true) where.push("(SELECT count(*) FROM internal_ticket_business_units j WHERE j.internal_ticket_id = it.id) > 1");
  if (f.shared === false) where.push("(SELECT count(*) FROM internal_ticket_business_units j WHERE j.internal_ticket_id = it.id) = 1");
  if (f.published === true) where.push("EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id AND ct.visibility_state = 'published')");
  if (f.published === false) where.push("NOT EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id AND ct.visibility_state = 'published')");
  if (f.visibility === "none") {
    where.push("NOT EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id)");
  } else if (f.visibility && VISIBILITY_VALUES.has(f.visibility)) {
    add("EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id AND ct.visibility_state = $$::visibility_state)", f.visibility);
  }
  const receivedFrom = validDate(f.receivedFrom);
  const receivedTo = validDate(f.receivedTo);
  const updatedFrom = validDate(f.updatedFrom);
  const updatedTo = validDate(f.updatedTo);
  if (receivedFrom) add("it.created_at >= $$::timestamptz", receivedFrom);
  if (receivedTo) add("it.created_at <= $$::timestamptz", receivedTo);
  if (updatedFrom) add("it.updated_at >= $$::timestamptz", updatedFrom);
  if (updatedTo) add("it.updated_at <= $$::timestamptz", updatedTo);
  if (f.search && f.search.trim()) {
    const term = `%${f.search.trim()}%`;
    params.push(term);
    where.push(`(it.ticket_number ILIKE $${params.length} OR it.title_internal ILIKE $${params.length} OR it.requester_email ILIKE $${params.length})`);
  }
  const whereSql = where.join(" AND ");
  const orderBy = TICKET_SORTS[f.sort ?? ""] ?? TICKET_SORTS["createdAt:desc"];

  const count = await query<{ n: string }>(
    `SELECT count(*) AS n FROM internal_tickets it WHERE ${whereSql}`,
    params
  );
  const rows = await query<{
    id: string; ticket_number: string; title_internal: string; priority: AdminPriority;
    current_stage: AdminStage; bu_slugs: string[]; published: boolean; created_at: Date;
    updated_at: Date;
  }>(
    `SELECT it.id, it.ticket_number, it.title_internal, it.priority, it.current_stage,
            it.created_at, it.updated_at,
            COALESCE(array_agg(b.slug) FILTER (WHERE b.slug IS NOT NULL), '{}') AS bu_slugs,
            EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id
                     AND ct.visibility_state = 'published') AS published
       FROM internal_tickets it
       LEFT JOIN internal_ticket_business_units j ON j.internal_ticket_id = it.id
       LEFT JOIN business_units b ON b.id = j.business_unit_id
      WHERE ${whereSql}
      GROUP BY it.id
      ORDER BY ${orderBy}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  );
  return {
    data: rows.rows.map((r) => ({
      id: r.id,
      ticketNumber: r.ticket_number,
      title: r.title_internal,
      priority: r.priority,
      stage: r.current_stage,
      businessUnits: r.bu_slugs,
      shared: r.bu_slugs.length > 1,
      published: r.published,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    pagination: { page, pageSize, totalItems: Number(count.rows[0].n) },
  };
}

// ---- ticket detail -------------------------------------------------------------

/** Full internal detail for one ticket (explicit-column DTO). Null if not found. */
export async function getTicketDetail(id: string): Promise<AdminTicketDetail | null> {
  const t = await query<{
    id: string; ticket_number: string; clickup_task_id: string; source_email_message_id: string | null;
    account_id: string | null; business_unit_id: string | null; visibility_bus: string[];
    title_internal: string; description_internal: string | null;
    requester_name: string | null; requester_email: string | null; customer_summary: string | null;
    priority: AdminPriority; current_stage: AdminStage; clickup_raw_status: string | null;
    visibility_state: AdminVisibility;
    created_at: Date; acknowledged_at: Date | null; business_review_at: Date | null;
    resolved_at: Date | null; closed_at: Date | null;
    response_due_at: Date | null; resolution_due_at: Date | null;
    response_sla_state: AdminSlaState; resolution_sla_state: AdminSlaState;
    reopen_count: number; last_synced_at: Date | null; updated_at: Date;
  }>(
    `SELECT it.id, it.ticket_number, it.clickup_task_id, it.source_email_message_id,
            it.account_id, it.business_unit_id,
            COALESCE(array_agg(b.slug) FILTER (WHERE b.slug IS NOT NULL), '{}') AS visibility_bus,
            it.title_internal, it.description_internal,
            it.requester_name, it.requester_email, it.customer_summary,
            it.priority, it.current_stage, it.clickup_raw_status, it.visibility_state,
            it.created_at, it.acknowledged_at, it.business_review_at, it.resolved_at, it.closed_at,
            it.response_due_at, it.resolution_due_at, it.response_sla_state, it.resolution_sla_state,
            it.reopen_count, it.last_synced_at, it.updated_at
       FROM internal_tickets it
       LEFT JOIN internal_ticket_business_units j ON j.internal_ticket_id = it.id
       LEFT JOIN business_units b ON b.id = j.business_unit_id
      WHERE it.id = $1 GROUP BY it.id`,
    [id]
  );
  const r = t.rows[0];
  if (!r) return null;

  const events = await query<{ to_stage: AdminStage; from_stage: AdminStage | null; changed_at: Date; source: string }>(
    `SELECT to_stage, from_stage, changed_at, source FROM internal_ticket_events
      WHERE internal_ticket_id = $1 ORDER BY changed_at, id`,
    [id]
  );
  const projections = await query<{
    business_unit_id: string; bu_slug: string; account_id: string; account_slug: string;
    visibility_state: AdminVisibility; published_at: Date | null;
  }>(
    `SELECT ct.business_unit_id, b.slug AS bu_slug, ct.account_id, a.slug AS account_slug,
            ct.visibility_state, ct.published_at
       FROM customer_tickets ct
       JOIN business_units b ON b.id = ct.business_unit_id
       JOIN accounts a ON a.id = ct.account_id
      WHERE ct.internal_ticket_id = $1 ORDER BY b.slug`,
    [id]
  );
  const audit = await query<{
    field: string | null; old_value: unknown; new_value: unknown;
    change_source: AdminChangeSource; actor: string | null; occurred_at: Date;
  }>(
    `SELECT field, old_value, new_value, change_source, actor, occurred_at
       FROM audit_events WHERE entity_id = $1 ORDER BY id DESC LIMIT 100`,
    [id]
  );

  const ticket: AdminInternalTicket = {
    id: r.id,
    ticketNumber: r.ticket_number,
    clickupTaskId: r.clickup_task_id,
    sourceEmailMessageId: r.source_email_message_id,
    originAccountId: r.account_id,
    originBusinessUnitId: r.business_unit_id,
    visibilityBusinessUnits: r.visibility_bus,
    titleInternal: r.title_internal,
    descriptionInternal: r.description_internal,
    requesterName: r.requester_name,
    requesterEmail: r.requester_email,
    customerSummary: r.customer_summary,
    priority: r.priority,
    stage: r.current_stage,
    clickupRawStatus: r.clickup_raw_status,
    visibilityState: r.visibility_state,
    createdAt: iso(r.created_at)!,
    acknowledgedAt: iso(r.acknowledged_at),
    businessReviewAt: iso(r.business_review_at),
    resolvedAt: iso(r.resolved_at),
    closedAt: iso(r.closed_at),
    responseDueAt: iso(r.response_due_at),
    resolutionDueAt: iso(r.resolution_due_at),
    responseSlaState: r.response_sla_state,
    resolutionSlaState: r.resolution_sla_state,
    reopenCount: r.reopen_count,
    lastSyncedAt: iso(r.last_synced_at),
    updatedAt: iso(r.updated_at)!,
  };
  const timeline: AdminTicketEvent[] = events.rows.map((e) => ({
    fromStage: e.from_stage,
    toStage: e.to_stage,
    changedAt: iso(e.changed_at)!,
    source: e.source,
  }));
  const projectionRows: AdminProjection[] = projections.rows.map((p) => ({
    businessUnitId: p.business_unit_id,
    businessUnitSlug: p.bu_slug,
    accountId: p.account_id,
    accountSlug: p.account_slug,
    visibilityState: p.visibility_state,
    publishedAt: iso(p.published_at),
  }));
  const auditRows: AdminTicketAuditEntry[] = audit.rows.map((a) => ({
    field: a.field,
    oldValue: a.old_value,
    newValue: a.new_value,
    changeSource: a.change_source,
    actor: a.actor,
    occurredAt: iso(a.occurred_at)!,
  }));
  return { ticket, timeline, projections: projectionRows, audit: auditRows };
}

// ---- sync runs -------------------------------------------------------------------

export async function listSyncRuns(limit = 50): Promise<AdminSyncRun[]> {
  const res = await query<{
    id: string; source_system: string; status: AdminSyncStatus;
    started_at: Date; finished_at: Date | null;
    tickets_seen: number; tickets_upserted: number; error_count: number;
    quarantined: number; cursor: string | null;
  }>(
    `SELECT id, source_system, status, started_at, finished_at,
            tickets_seen, tickets_upserted, error_count,
            COALESCE(jsonb_array_length(details->'quarantines'), 0) AS quarantined,
            cursor
       FROM sync_runs ORDER BY id DESC LIMIT $1`,
    [Math.min(200, limit)]
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    sourceSystem: r.source_system,
    status: r.status,
    startedAt: iso(r.started_at)!,
    finishedAt: iso(r.finished_at),
    ticketsSeen: r.tickets_seen,
    ticketsUpserted: r.tickets_upserted,
    errorCount: r.error_count,
    quarantined: Number(r.quarantined),
    cursor: r.cursor,
  }));
}

// ---- audit --------------------------------------------------------------------------

export interface AdminAuditFilters {
  entityType?: string | null;
  changeSource?: string | null;
  entityId?: string | null;
  search?: string | null;
  /** Keyset paging: only events with id < beforeId. */
  beforeId?: number | null;
  limit?: number;
}

const CHANGE_SOURCES = new Set(["SYNC", "TRANSFORM", "ADMIN", "SYSTEM", "PORTAL"]);
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

export async function listAudit(f: AdminAuditFilters = {}): Promise<AdminAuditEvent[]> {
  const limit = Math.min(500, Math.max(1, f.limit ?? 100));
  const where: string[] = ["TRUE"];
  const params: unknown[] = [];
  const add = (clause: string, v: unknown) => {
    params.push(v);
    where.push(clause.replace("$$", `$${params.length}`));
  };
  if (f.entityType) add("ae.entity_type = $$", f.entityType);
  if (f.changeSource && CHANGE_SOURCES.has(f.changeSource)) add("ae.change_source = $$::audit_source", f.changeSource);
  if (f.entityId && UUID_RE.test(f.entityId)) add("ae.entity_id = $$::uuid", f.entityId);
  if (f.beforeId && Number.isFinite(f.beforeId)) add("ae.id < $$", Math.trunc(f.beforeId));
  if (f.search && f.search.trim()) {
    const term = `%${f.search.trim()}%`;
    params.push(term);
    where.push(`(ae.actor ILIKE $${params.length} OR ae.field ILIKE $${params.length} OR t.ticket_number ILIKE $${params.length})`);
  }
  const res = await query<{
    id: string; entity_type: string; entity_id: string; entity_label: string | null;
    account_id: string | null; field: string | null; old_value: unknown; new_value: unknown;
    change_source: AdminChangeSource; actor: string | null; occurred_at: Date;
  }>(
    `SELECT ae.id, ae.entity_type, ae.entity_id, t.ticket_number AS entity_label,
            ae.account_id, ae.field, ae.old_value, ae.new_value,
            ae.change_source, ae.actor, ae.occurred_at
       FROM audit_events ae
       LEFT JOIN internal_tickets t
              ON ae.entity_type = 'internal_ticket' AND t.id = ae.entity_id
      WHERE ${where.join(" AND ")}
      ORDER BY ae.id DESC LIMIT ${limit}`,
    params
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    entityType: r.entity_type,
    entityId: r.entity_id,
    entityLabel: r.entity_label,
    accountId: r.account_id,
    field: r.field,
    oldValue: r.old_value,
    newValue: r.new_value,
    changeSource: r.change_source,
    actor: r.actor,
    occurredAt: iso(r.occurred_at)!,
  }));
}

// ---- quarantine ------------------------------------------------------------------------

/**
 * Quarantine has no table — it lives in the LATEST clickup sync_runs row's
 * details.quarantines JSON (docs/admin-portal.md). Aggregate from there.
 */
export async function getQuarantineLatest(): Promise<AdminQuarantineView> {
  const res = await query<{ id: string; quarantines: Array<{ reason: string; customId: string | null; detail: string }> | null }>(
    `SELECT id, details->'quarantines' AS quarantines
       FROM sync_runs
      WHERE source_system = 'clickup' AND status IN ('SUCCESS','PARTIAL')
      ORDER BY id DESC LIMIT 1`
  );
  const row = res.rows[0];
  const items = row?.quarantines ?? [];
  const byReason: Record<string, number> = {};
  for (const q of items) byReason[q.reason] = (byReason[q.reason] ?? 0) + 1;
  return {
    total: items.length,
    byReason,
    items,
    sourceRunId: row ? Number(row.id) : null,
  };
}

// ---- reference (filter dropdowns) ---------------------------------------------------------

export async function getReference(): Promise<AdminReference> {
  const accounts = await query<{ id: string; name: string; slug: string; is_active: boolean }>(
    `SELECT id, name, slug, is_active FROM accounts ORDER BY name`
  );
  const bus = await query<{ id: string; account_id: string; name: string; slug: string; is_active: boolean }>(
    `SELECT id, account_id, name, slug, is_active FROM business_units ORDER BY slug`
  );
  return {
    accounts: accounts.rows.map((a) => ({ id: a.id, name: a.name, slug: a.slug, isActive: a.is_active })),
    businessUnits: bus.rows.map((b) => ({ id: b.id, accountId: b.account_id, name: b.name, slug: b.slug, isActive: b.is_active })),
  };
}
