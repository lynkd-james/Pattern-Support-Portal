// =============================================================================
// Read-only API client. The UI calls ONLY these functions, which map 1:1 to the
// frozen contract endpoints. Scope is enforced server-side from the session; the
// client never sends an account id.
//
// Live-only: these functions always call the live API (/api/session, /api/tickets).
// =============================================================================

import type {
  SessionResponse,
  TicketListQuery,
  TicketListResponse,
} from "./types";

// ---- public client -------------------------------------------------------

export async function fetchSession(): Promise<SessionResponse> {
  return getJson<SessionResponse>("/api/session");
}

export async function fetchTickets(
  query: TicketListQuery = {}
): Promise<TicketListResponse> {
  return getJson<TicketListResponse>(`/api/tickets${toQueryString(query)}`);
}

// ---- live transport ------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  // Session expired/absent: hand off to the sign-in screen. The 401 comes from
  // the server-side session layer (the security boundary); this is UX only.
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.assign("/login");
    throw new Error("Not signed in");
  }
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
