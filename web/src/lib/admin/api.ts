// =============================================================================
// Admin API client (Stage 10b) — the ONLY way admin UI code obtains data
// (invariant 10b-2: UI → /api/admin/* → server/admin → DB; never the DB, never
// server imports). Read-only: every data function is a GET; the single POST is
// logout (session hygiene, not data mutation — invariant 10b-1).
//
// 401 handling mirrors the customer client: the server-side session layer is
// the security boundary; the redirect to /admin/login is UX only.
// =============================================================================

import type {
  AdminAuditEvent,
  AdminQuarantineView,
  AdminReference,
  AdminSession,
  AdminStats,
  AdminSyncRun,
  AdminTicketDetail,
  AdminTicketListResponse,
} from "./contracts";

export interface AdminTicketQuery {
  search?: string | null;
  accountId?: string | null;
  businessUnitId?: string | null;
  stage?: string | null;
  priority?: string | null;
  visibility?: string | null;
  published?: boolean | null;
  shared?: boolean | null;
  receivedFrom?: string | null;
  receivedTo?: string | null;
  updatedFrom?: string | null;
  updatedTo?: string | null;
  sort?: string | null;
  page?: number;
  pageSize?: number;
}

export interface AdminAuditQuery {
  entityType?: string | null;
  changeSource?: string | null;
  search?: string | null;
  beforeId?: number | null;
  limit?: number;
}

export async function fetchAdminSession(): Promise<AdminSession> {
  return getJson<AdminSession>("/api/admin/session");
}

export async function fetchAdminStats(): Promise<AdminStats> {
  return getJson<AdminStats>("/api/admin/stats");
}

export async function fetchAdminTickets(q: AdminTicketQuery = {}): Promise<AdminTicketListResponse> {
  const p = new URLSearchParams();
  if (q.search) p.set("search", q.search);
  if (q.accountId) p.set("accountId", q.accountId);
  if (q.businessUnitId) p.set("businessUnitId", q.businessUnitId);
  if (q.stage) p.set("stage", q.stage);
  if (q.priority) p.set("priority", q.priority);
  if (q.visibility) p.set("visibility", q.visibility);
  if (q.published !== null && q.published !== undefined) p.set("published", String(q.published));
  if (q.shared !== null && q.shared !== undefined) p.set("shared", String(q.shared));
  if (q.receivedFrom) p.set("receivedFrom", q.receivedFrom);
  if (q.receivedTo) p.set("receivedTo", q.receivedTo);
  if (q.updatedFrom) p.set("updatedFrom", q.updatedFrom);
  if (q.updatedTo) p.set("updatedTo", q.updatedTo);
  if (q.sort) p.set("sort", q.sort);
  if (q.page) p.set("page", String(q.page));
  if (q.pageSize) p.set("pageSize", String(q.pageSize));
  const s = p.toString();
  return getJson<AdminTicketListResponse>(`/api/admin/tickets${s ? `?${s}` : ""}`);
}

export async function fetchAdminTicketDetail(id: string): Promise<AdminTicketDetail> {
  return getJson<AdminTicketDetail>(`/api/admin/tickets/${encodeURIComponent(id)}`);
}

export async function fetchAdminSyncRuns(limit = 50): Promise<AdminSyncRun[]> {
  const res = await getJson<{ data: AdminSyncRun[] }>(`/api/admin/sync-runs?limit=${limit}`);
  return res.data;
}

export async function fetchAdminAudit(q: AdminAuditQuery = {}): Promise<AdminAuditEvent[]> {
  const p = new URLSearchParams();
  if (q.entityType) p.set("entityType", q.entityType);
  if (q.changeSource) p.set("changeSource", q.changeSource);
  if (q.search) p.set("search", q.search);
  if (q.beforeId) p.set("beforeId", String(q.beforeId));
  if (q.limit) p.set("limit", String(q.limit));
  const s = p.toString();
  const res = await getJson<{ data: AdminAuditEvent[] }>(`/api/admin/audit${s ? `?${s}` : ""}`);
  return res.data;
}

export async function fetchAdminQuarantine(): Promise<AdminQuarantineView> {
  return getJson<AdminQuarantineView>("/api/admin/quarantine");
}

export async function fetchAdminReference(): Promise<AdminReference> {
  return getJson<AdminReference>("/api/admin/reference");
}

/** Logout: revokes the admin session server-side; the customer session (if any) is untouched. */
export async function postAdminLogout(): Promise<void> {
  await fetch("/api/admin/auth/logout", { method: "POST", credentials: "include", redirect: "manual" });
}

// ---- transport ---------------------------------------------------------------

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  if (res.status === 401 && typeof window !== "undefined") {
    window.location.assign("/admin/login");
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
