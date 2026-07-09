// =============================================================================
// Admin read-only queries over the INTERNAL layer (Stage 10a).
//
// Staff see full fidelity: all internal tickets (incl. shared + unpublished),
// their visibility set, projection status, sync history, audit, and quarantine.
// This deliberately reads the internal layer — safe ONLY because every caller
// is behind requireAdminSession() (the admin realm). No business logic here;
// it maps stored values, mirroring how customer/queries.ts is a thin mapper.
// Never imported by customer code; imports no customer code.
// =============================================================================

import { query } from "../db";

export interface AdminStats {
  tickets: { total: number; open: number; closed: number };
  exposure: { published: number; internalOnly: number; shared: number };
  quarantinedLatest: number;
  slaBreaches: number;
}

const OPEN_STAGES = ["NEW", "ACKNOWLEDGED", "IN_PROGRESS", "ON_HOLD", "BUSINESS_REVIEW", "REOPENED"];

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
  };
}

export interface AdminTicketListItem {
  id: string;
  ticketNumber: string;
  title: string;
  priority: string;
  stage: string;
  businessUnits: string[];
  shared: boolean;
  published: boolean;
  createdAt: string;
}

export interface AdminTicketFilters {
  businessUnitId?: string | null;
  stage?: string | null;
  priority?: string | null;
  shared?: boolean | null;
  published?: boolean | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}

export async function listTickets(f: AdminTicketFilters): Promise<{
  data: AdminTicketListItem[];
  pagination: { page: number; pageSize: number; totalItems: number };
}> {
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
  if (f.shared === true) where.push("(SELECT count(*) FROM internal_ticket_business_units j WHERE j.internal_ticket_id = it.id) > 1");
  if (f.shared === false) where.push("(SELECT count(*) FROM internal_ticket_business_units j WHERE j.internal_ticket_id = it.id) = 1");
  if (f.published === true) where.push("EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id AND ct.visibility_state = 'published')");
  if (f.published === false) where.push("NOT EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id AND ct.visibility_state = 'published')");
  if (f.search && f.search.trim()) {
    const term = `%${f.search.trim()}%`;
    params.push(term);
    where.push(`(it.ticket_number ILIKE $${params.length} OR it.title_internal ILIKE $${params.length} OR it.requester_email ILIKE $${params.length})`);
  }
  const whereSql = where.join(" AND ");

  const count = await query<{ n: string }>(
    `SELECT count(*) AS n FROM internal_tickets it WHERE ${whereSql}`,
    params
  );
  const rows = await query<{
    id: string; ticket_number: string; title_internal: string; priority: string;
    current_stage: string; bu_slugs: string[]; published: boolean; created_at: Date;
  }>(
    `SELECT it.id, it.ticket_number, it.title_internal, it.priority, it.current_stage,
            it.created_at,
            COALESCE(array_agg(b.slug) FILTER (WHERE b.slug IS NOT NULL), '{}') AS bu_slugs,
            EXISTS (SELECT 1 FROM customer_tickets ct WHERE ct.internal_ticket_id = it.id
                     AND ct.visibility_state = 'published') AS published
       FROM internal_tickets it
       LEFT JOIN internal_ticket_business_units j ON j.internal_ticket_id = it.id
       LEFT JOIN business_units b ON b.id = j.business_unit_id
      WHERE ${whereSql}
      GROUP BY it.id
      ORDER BY it.created_at DESC, it.id
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
    })),
    pagination: { page, pageSize, totalItems: Number(count.rows[0].n) },
  };
}

/** Full internal detail for one ticket. Returns null if not found. */
export async function getTicketDetail(id: string): Promise<Record<string, unknown> | null> {
  const t = await query<Record<string, unknown>>(
    `SELECT it.*, COALESCE(array_agg(b.slug) FILTER (WHERE b.slug IS NOT NULL), '{}') AS visibility_bus
       FROM internal_tickets it
       LEFT JOIN internal_ticket_business_units j ON j.internal_ticket_id = it.id
       LEFT JOIN business_units b ON b.id = j.business_unit_id
      WHERE it.id = $1 GROUP BY it.id`,
    [id]
  );
  if (!t.rows[0]) return null;
  const events = await query(
    `SELECT to_stage, from_stage, changed_at, source FROM internal_ticket_events
      WHERE internal_ticket_id = $1 ORDER BY changed_at, id`,
    [id]
  );
  const projections = await query(
    `SELECT ct.business_unit_id, b.slug, ct.account_id, ct.visibility_state, ct.published_at
       FROM customer_tickets ct JOIN business_units b ON b.id = ct.business_unit_id
      WHERE ct.internal_ticket_id = $1 ORDER BY b.slug`,
    [id]
  );
  const audit = await query(
    `SELECT field, old_value, new_value, change_source, actor, occurred_at
       FROM audit_events WHERE entity_id = $1 ORDER BY id DESC LIMIT 100`,
    [id]
  );
  return {
    ticket: t.rows[0],
    timeline: events.rows,
    projections: projections.rows,
    audit: audit.rows,
  };
}

export async function listSyncRuns(limit = 50): Promise<unknown[]> {
  const res = await query(
    `SELECT id, source_system, status, started_at, finished_at,
            tickets_seen, tickets_upserted, error_count, cursor
       FROM sync_runs ORDER BY id DESC LIMIT $1`,
    [Math.min(200, limit)]
  );
  return res.rows;
}

export async function listAudit(limit = 100): Promise<unknown[]> {
  const res = await query(
    `SELECT id, entity_type, entity_id, account_id, field, old_value, new_value,
            change_source, actor, occurred_at
       FROM audit_events ORDER BY id DESC LIMIT $1`,
    [Math.min(500, limit)]
  );
  return res.rows;
}

export interface QuarantineView {
  total: number;
  byReason: Record<string, number>;
  items: Array<{ reason: string; customId: string | null; detail: string }>;
  sourceRunId: number | null;
}

/**
 * Quarantine has no table — it lives in the LATEST clickup sync_runs row's
 * details.quarantines JSON (docs/admin-portal.md). Aggregate from there.
 */
export async function getQuarantineLatest(): Promise<QuarantineView> {
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
