// =============================================================================
// Customer projection read queries (server-only).
//
// The ONLY data source for the portal API. Reads exclusively from
// customer_tickets / customer_ticket_timeline WHERE visibility_state='published',
// always scoped to the request's account (+ business units). Contains NO business
// logic — no SLA computation, no status mapping, no derivation. It returns stored
// projection values mapped 1:1 to the frozen API contract.
// =============================================================================

import { query } from "../db";
import type { RequestScope } from "./session";
import type {
  TicketDetail,
  TicketListItem,
  TicketListQuery,
  TicketListResponse,
} from "@/lib/types";

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

// Whitelisted sort fields (contract): map to columns. Anything else => default.
const SORT_COLUMNS: Record<string, string> = {
  createdAt: "ct.created_at",
  priority: "ct.priority",
  resolutionDueAt: "ct.resolution_due_at",
};

interface ListRow {
  id: string;
  ticket_number: string;
  title: string;
  priority: string;
  stage: string;
  business_unit_id: string;
  bu_name: string;
  created_at: Date;
  response_sla_state: string;
  resolution_sla_state: string;
  response_due_at: Date | null;
  resolution_due_at: Date | null;
}

function toListItem(r: ListRow): TicketListItem {
  return {
    id: r.id,
    ticketNumber: r.ticket_number,
    title: r.title,
    priority: r.priority as TicketListItem["priority"],
    stage: r.stage as TicketListItem["stage"],
    businessUnit: { id: r.business_unit_id, name: r.bu_name },
    createdAt: new Date(r.created_at).toISOString(),
    responseSlaState: r.response_sla_state as TicketListItem["responseSlaState"],
    resolutionSlaState: r.resolution_sla_state as TicketListItem["resolutionSlaState"],
    responseDueAt: iso(r.response_due_at),
    resolutionDueAt: iso(r.resolution_due_at),
  };
}

function buildSort(sort: string | undefined): string {
  const [field, dirRaw] = (sort ?? "createdAt:desc").split(":");
  const col = SORT_COLUMNS[field] ?? SORT_COLUMNS.createdAt;
  const dir = dirRaw === "asc" ? "ASC" : "DESC";
  // Deterministic tiebreaker so pagination is stable.
  return `${col} ${dir} NULLS LAST, ct.id ASC`;
}

export async function listTickets(
  scope: RequestScope,
  q: TicketListQuery
): Promise<TicketListResponse> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));

  const where: string[] = ["ct.visibility_state = 'published'", "ct.account_id = $1"];
  const params: unknown[] = [scope.accountId];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$$", `$${params.length}`));
  };

  if (scope.businessUnitIds !== null) {
    add("ct.business_unit_id = ANY($$::uuid[])", scope.businessUnitIds);
  }
  if (q.stage) add("ct.stage = $$::portal_stage", q.stage);
  if (q.priority) add("ct.priority = $$::priority_level", q.priority);
  if (q.slaState) add("ct.resolution_sla_state = $$::sla_state", q.slaState);
  if (q.businessUnitId) add("ct.business_unit_id = $$", q.businessUnitId);
  if (q.search && q.search.trim()) {
    const term = `%${q.search.trim()}%`;
    params.push(term);
    where.push(`(ct.title ILIKE $${params.length} OR ct.ticket_number ILIKE $${params.length})`);
  }

  const whereSql = where.join(" AND ");

  const countRes = await query<{ n: string }>(
    `SELECT count(*) AS n FROM customer_tickets ct WHERE ${whereSql}`,
    params
  );
  const totalItems = Number(countRes.rows[0]?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const offset = (page - 1) * pageSize;

  const dataRes = await query<ListRow>(
    `SELECT ct.id, ct.ticket_number, ct.title, ct.priority, ct.stage,
            ct.business_unit_id, bu.name AS bu_name, ct.created_at,
            ct.response_sla_state, ct.resolution_sla_state,
            ct.response_due_at, ct.resolution_due_at
       FROM customer_tickets ct
       JOIN business_units bu ON bu.id = ct.business_unit_id
      WHERE ${whereSql}
      ORDER BY ${buildSort(q.sort)}
      LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );

  return {
    data: dataRes.rows.map(toListItem),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}

interface DetailRow extends ListRow {
  description: string | null;
  acknowledged_at: Date | null;
  business_review_at: Date | null;
  resolved_at: Date | null;
  closed_at: Date | null;
  account_id: string;
  account_name: string;
}

export async function getTicketDetail(
  scope: RequestScope,
  id: string
): Promise<TicketDetail | null> {
  const params: unknown[] = [id, scope.accountId];
  let buClause = "";
  if (scope.businessUnitIds !== null) {
    params.push(scope.businessUnitIds);
    buClause = ` AND ct.business_unit_id = ANY($${params.length}::uuid[])`;
  }

  const res = await query<DetailRow>(
    `SELECT ct.id, ct.ticket_number, ct.title, ct.description, ct.priority, ct.stage,
            ct.business_unit_id, bu.name AS bu_name, ct.account_id, a.name AS account_name,
            ct.created_at, ct.acknowledged_at, ct.business_review_at, ct.resolved_at, ct.closed_at,
            ct.response_sla_state, ct.resolution_sla_state, ct.response_due_at, ct.resolution_due_at
       FROM customer_tickets ct
       JOIN business_units bu ON bu.id = ct.business_unit_id
       JOIN accounts a ON a.id = ct.account_id
      WHERE ct.id = $1 AND ct.account_id = $2 AND ct.visibility_state = 'published'${buClause}`,
    params
  );
  const r = res.rows[0];
  if (!r) return null;

  const timeline = await query<{ stage: string; label: string | null; occurred_at: Date }>(
    `SELECT stage, label, occurred_at FROM customer_ticket_timeline
      WHERE customer_ticket_id = $1 ORDER BY occurred_at ASC, id ASC`,
    [r.id]
  );

  return {
    id: r.id,
    ticketNumber: r.ticket_number,
    title: r.title,
    description: r.description,
    priority: r.priority as TicketDetail["priority"],
    stage: r.stage as TicketDetail["stage"],
    account: { id: r.account_id, name: r.account_name },
    businessUnit: { id: r.business_unit_id, name: r.bu_name },
    createdAt: new Date(r.created_at).toISOString(),
    acknowledgedAt: iso(r.acknowledged_at),
    businessReviewAt: iso(r.business_review_at),
    resolvedAt: iso(r.resolved_at),
    closedAt: iso(r.closed_at),
    sla: {
      response: {
        state: r.response_sla_state as TicketDetail["sla"]["response"]["state"],
        dueAt: iso(r.response_due_at),
      },
      resolution: {
        state: r.resolution_sla_state as TicketDetail["sla"]["resolution"]["state"],
        dueAt: iso(r.resolution_due_at),
      },
    },
    timeline: timeline.rows.map((t) => ({
      stage: t.stage as TicketDetail["timeline"][number]["stage"],
      label: t.label,
      occurredAt: new Date(t.occurred_at).toISOString(),
    })),
  };
}
