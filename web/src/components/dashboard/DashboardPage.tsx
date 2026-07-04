"use client";

// =============================================================================
// DashboardPage — orchestrates the read-only dashboard.
//
// Flow: load session (scope) -> fetch /api/tickets for the active filters/page
//   -> render SummaryCards (computed from the loaded rows) + TicketTable.
//
// The dashboard requests pageSize = MAX_PAGE_SIZE (the contract max, 100) so the
// purely-client summary cards reflect as much of the filtered set as possible
// without any extra API call. Changing a filter resets to page 1 and refetches;
// the cards recompute from the new response — no separate summary request.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSession, fetchTickets } from "../../lib/api";
import { computeSummary } from "../../lib/summary";
import type {
  Pagination,
  SessionResponse,
  TicketListItem,
} from "../../lib/types";
import SummaryCards from "./SummaryCards";
import FilterBar, { DashboardFilters } from "./FilterBar";
import TicketTable from "./TicketTable";

const MAX_PAGE_SIZE = 100;

// Pattern brand font stack (Inter with system fallbacks).
const FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

const EMPTY_FILTERS: DashboardFilters = {
  search: "",
  businessUnitId: null,
  stage: null,
  priority: null,
};

export default function DashboardPage() {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [tickets, setTickets] = useState<TicketListItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load session once for scope (business unit filter + header).
  useEffect(() => {
    let active = true;
    fetchSession()
      .then((s) => active && setSession(s))
      .catch((e) => active && setError(e.message ?? "Failed to load session"));
    return () => {
      active = false;
    };
  }, []);

  // Fetch tickets whenever filters or page change. One call; cards derive from it.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    fetchTickets({
      page,
      pageSize: MAX_PAGE_SIZE,
      search: filters.search || null,
      businessUnitId: filters.businessUnitId,
      stage: filters.stage,
      priority: filters.priority,
      sort: "createdAt:desc",
    })
      .then((res) => {
        if (!active) return;
        setTickets(res.data);
        setPagination(res.pagination);
      })
      .catch((e) => active && setError(e.message ?? "Failed to load tickets"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [filters, page]);

  const onFiltersChange = useCallback((next: DashboardFilters) => {
    setFilters(next);
    setPage(1); // any filter change resets pagination
  }, []);

  // Summary cards: pure client aggregation over the loaded (filtered) rows.
  const summary = useMemo(() => computeSummary(tickets), [tickets]);

  return (
    <div
      className="min-h-screen bg-[#0A0706] text-[#D9CFBE]"
      style={{ fontFamily: FONT_STACK }}
    >
      <div className="mx-auto max-w-7xl px-6 py-10">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <img
              src="/pattern-logo.svg"
              alt="Pattern"
              className="mb-4 h-10 w-auto"
            />
            <h1 className="text-2xl font-medium tracking-tight text-[#F7F2E8]">Support Portal</h1>
            <p className="mt-1.5 text-sm text-[#9C8E78]">
              {session ? `${session.account.name} · ${session.user.displayName ?? session.user.email}` : " "}
            </p>
          </div>
          {/* Server-side revocation; the cookie clear alone is never trusted. */}
          <form method="post" action="/api/auth/logout">
            <button
              type="submit"
              className="rounded-md border border-[#3A2D1F] px-3 py-1.5 text-sm text-[#9C8E78] transition-colors hover:bg-[#221A11] hover:text-[#D9CFBE]"
            >
              Sign out
            </button>
          </form>
        </header>

        <section className="mb-8">
          <SummaryCards summary={summary} loading={loading} />
        </section>

        <section className="mb-5">
          <FilterBar
            filters={filters}
            businessUnits={session?.businessUnits ?? []}
            onChange={onFiltersChange}
          />
        </section>

        {error && (
          <div className="mb-5 rounded-lg border border-[#E26A60]/40 bg-[rgba(226,106,96,0.16)] px-4 py-3 text-sm text-[#E26A60]">
            {error}
          </div>
        )}

        <TicketTable tickets={tickets} loading={loading} />

        {pagination && pagination.totalItems > 0 && (
          <div className="mt-5 flex items-center justify-between text-sm text-[#9C8E78]">
            <span>
              Showing {tickets.length} of {pagination.totalItems} ticket
              {pagination.totalItems === 1 ? "" : "s"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-md border border-[#3A2D1F] px-3 py-1.5 text-[#D9CFBE] transition-colors hover:bg-[#221A11] disabled:opacity-40 disabled:hover:bg-transparent"
                disabled={!pagination.hasPreviousPage || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <span className="tabular-nums text-[#9C8E78]">
                Page {pagination.page} / {pagination.totalPages}
              </span>
              <button
                type="button"
                className="rounded-md border border-[#3A2D1F] px-3 py-1.5 text-[#D9CFBE] transition-colors hover:bg-[#221A11] disabled:opacity-40 disabled:hover:bg-transparent"
                disabled={!pagination.hasNextPage || loading}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
