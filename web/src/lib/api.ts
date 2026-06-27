// =============================================================================
// Read-only API client. The UI calls ONLY these functions, which map 1:1 to the
// frozen contract endpoints. Scope is enforced server-side from the session; the
// client never sends an account id.
//
// Phase 1: USE_MOCK === true serves local fixtures so the dashboard runs without
// a backend. Flip to false (or wire NEXT_PUBLIC_USE_MOCK) once the API is live —
// no component changes required, because the mock honours the same query params.
// =============================================================================

import type {
  SessionResponse,
  TicketListItem,
  TicketListQuery,
  TicketListResponse,
} from "./types";
import { MOCK_SESSION, MOCK_TICKETS } from "./mockData";

const USE_MOCK = true;

const CLOSED = new Set(["RESOLVED", "CLOSED"]);

// ---- public client -------------------------------------------------------

export async function fetchSession(): Promise<SessionResponse> {
  if (USE_MOCK) return structuredCloneSafe(MOCK_SESSION);
  return getJson<SessionResponse>("/api/session");
}

export async function fetchTickets(
  query: TicketListQuery = {}
): Promise<TicketListResponse> {
  if (USE_MOCK) return mockTickets(query);
  return getJson<TicketListResponse>(`/api/tickets${toQueryString(query)}`);
}

// ---- live transport ------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error?.message) message = body.error.message;
    } catch {
      /* ignore parse errors */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function toQueryString(q: TicketListQuery): string {
  const p = new URLSearchParams();
  if (q.page) p.set("page", String(q.page));
  if (q.pageSize) p.set("pageSize", String(q.pageSize));
  if (q.stage) p.set("stage", q.stage);
  if (q.priority) p.set("priority", q.priority);
  if (q.slaState) p.set("slaState", q.slaState);
  if (q.businessUnitId) p.set("businessUnitId", q.businessUnitId);
  if (q.search) p.set("search", q.search);
  if (q.sort) p.set("sort", q.sort);
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---- mock implementation (mirrors server filtering + pagination) ---------

function mockTickets(query: TicketListQuery): Promise<TicketListResponse> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const search = (query.search ?? "").trim().toLowerCase();

  let rows: TicketListItem[] = [...MOCK_TICKETS];

  if (query.businessUnitId)
    rows = rows.filter((t) => t.businessUnit.id === query.businessUnitId);
  if (query.stage) rows = rows.filter((t) => t.stage === query.stage);
  if (query.priority) rows = rows.filter((t) => t.priority === query.priority);
  if (query.slaState)
    rows = rows.filter((t) => t.resolutionSlaState === query.slaState);
  if (search)
    rows = rows.filter(
      (t) =>
        t.title.toLowerCase().includes(search) ||
        t.ticketNumber.toLowerCase().includes(search)
    );

  rows = sortRows(rows, query.sort ?? "createdAt:desc");

  const totalItems = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const start = (page - 1) * pageSize;
  const data = rows.slice(start, start + pageSize);

  return Promise.resolve({
    data,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  });
}

function sortRows(rows: TicketListItem[], sort: string): TicketListItem[] {
  const [field, dirRaw] = sort.split(":");
  const dir = dirRaw === "asc" ? 1 : -1;
  const priorityRank: Record<string, number> = { P1: 1, P2: 2, P3: 3 };
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (field === "priority") {
      cmp = priorityRank[a.priority] - priorityRank[b.priority];
    } else if (field === "resolutionDueAt") {
      cmp = ts(a.resolutionDueAt) - ts(b.resolutionDueAt);
    } else {
      cmp = ts(a.createdAt) - ts(b.createdAt);
    }
    return cmp * dir;
  });
}

function ts(iso: string | null): number {
  if (!iso) return 0;
  const n = new Date(iso).getTime();
  return Number.isNaN(n) ? 0 : n;
}

// Avoid a hard dependency on structuredClone in older runtimes.
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Re-export so callers can group counts if needed (kept internal otherwise).
export const _internal = { CLOSED };
