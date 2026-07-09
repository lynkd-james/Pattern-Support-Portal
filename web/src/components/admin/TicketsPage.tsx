"use client";

// =============================================================================
// Tickets (Stage 10b) — the internal ticket explorer. THE URL IS THE FILTER
// STATE (refinement R3): every filter round-trips through query params —
// bookmarkable, refresh-safe, Back-correct, shareable. React state derives
// from the URL, never the reverse. All filtering happens SERVER-side via the
// admin API; slugs in the URL resolve to ids via /api/admin/reference.
// =============================================================================

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import type { AdminReference } from "../../lib/admin/contracts";
import { fetchAdminReference, fetchAdminTickets } from "../../lib/admin/api";
import {
  PRIORITIES,
  STAGES,
  TICKET_SORTS,
  VISIBILITIES,
  VISIBILITY_LABELS,
  ticketFiltersFromParams,
  ticketFiltersToParams,
  ticketFiltersToQuery,
  type TicketFilterState,
} from "../../lib/admin/types";
import {
  EMPTY,
  PRIORITY_BADGE,
  STAGE_BADGE,
  STAGE_LABELS,
  formatDateTime,
  relativeTime,
} from "../../lib/admin/format";
import { useAdminData } from "./useAdminData";
import { Badge, EmptyState, ErrorNotice, LoadingRows, Section, Table, Td, Th, TimeCell } from "./ui";

const PAGE_SIZE = 50;

const inputCls =
  "rounded border border-[#3A2D1F] bg-[#120D08] px-2 py-1.5 text-sm text-[#D9CFBE] placeholder-[#5C5142] focus:border-[#E8923E] focus:outline-none";
const selectCls = inputCls;

export default function TicketsPage() {
  const reference = useAdminData(() => fetchAdminReference(), []);

  if (reference.error) return <ErrorNotice message={reference.error} onRetry={reference.reload} />;
  if (reference.loading || !reference.data) return <LoadingRows rows={8} />;
  return <TicketsInner reference={reference.data} />;
}

function TicketsInner({ reference }: { reference: AdminReference }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => ticketFiltersFromParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const [draftSearch, setDraftSearch] = useState(filters.q);

  const spKey = searchParams.toString();
  const tickets = useAdminData(
    () => fetchAdminTickets({ ...ticketFiltersToQuery(filters, reference), pageSize: PAGE_SIZE }),
    [spKey]
  );

  function apply(next: Partial<TicketFilterState>, resetPage = true) {
    const merged: TicketFilterState = { ...filters, ...next, page: resetPage ? 1 : next.page ?? filters.page };
    router.replace(`${pathname}?${ticketFiltersToParams(merged).toString()}`);
  }

  const activeAccounts = reference.accounts.filter((a) => a.isActive);
  const activeBus = reference.businessUnits.filter(
    (b) => b.isActive && (!filters.customer || b.accountId === activeAccounts.find((a) => a.slug === filters.customer)?.id)
  );

  const totalPages = tickets.data ? Math.max(1, Math.ceil(tickets.data.pagination.totalItems / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <Section title="Filters">
        <form
          className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7"
          onSubmit={(e) => {
            e.preventDefault();
            apply({ q: draftSearch });
          }}
        >
          <input
            type="search"
            value={draftSearch}
            onChange={(e) => setDraftSearch(e.target.value)}
            placeholder="Ticket #, title, requester…"
            className={`${inputCls} col-span-2`}
            aria-label="Search"
          />
          <select
            className={selectCls}
            value={filters.customer ?? ""}
            onChange={(e) => apply({ customer: e.target.value || null, bu: null })}
            aria-label="Customer"
          >
            <option value="">All customers</option>
            {activeAccounts.map((a) => (
              <option key={a.id} value={a.slug}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className={selectCls}
            value={filters.bu ?? ""}
            onChange={(e) => apply({ bu: e.target.value || null })}
            aria-label="Business unit"
          >
            <option value="">All business units</option>
            {activeBus.map((b) => (
              <option key={b.id} value={b.slug}>
                {b.slug}
              </option>
            ))}
          </select>
          <select
            className={selectCls}
            value={filters.stage ?? ""}
            onChange={(e) => apply({ stage: e.target.value || null })}
            aria-label="Stage"
          >
            <option value="">All stages</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
          <select
            className={selectCls}
            value={filters.priority ?? ""}
            onChange={(e) => apply({ priority: e.target.value || null })}
            aria-label="Priority"
          >
            <option value="">All priorities</option>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            className={selectCls}
            value={filters.visibility ?? ""}
            onChange={(e) => apply({ visibility: e.target.value || null })}
            aria-label="Visibility"
          >
            <option value="">All visibility</option>
            {VISIBILITIES.map((v) => (
              <option key={v} value={v}>
                {VISIBILITY_LABELS[v]}
              </option>
            ))}
          </select>
          <select
            className={selectCls}
            value={filters.published === null ? "" : String(filters.published)}
            onChange={(e) => apply({ published: e.target.value === "" ? null : e.target.value === "true" })}
            aria-label="Published"
          >
            <option value="">Published + internal</option>
            <option value="true">Published only</option>
            <option value="false">Internal only</option>
          </select>
          <select
            className={selectCls}
            value={filters.shared === null ? "" : String(filters.shared)}
            onChange={(e) => apply({ shared: e.target.value === "" ? null : e.target.value === "true" })}
            aria-label="Shared"
          >
            <option value="">Shared + single</option>
            <option value="true">Shared only</option>
            <option value="false">Single-BU only</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-[#9C8E78]">
            <span className="whitespace-nowrap">Received</span>
            <input
              type="date"
              className={`${inputCls} w-full`}
              value={filters.from ?? ""}
              onChange={(e) => apply({ from: e.target.value || null })}
              aria-label="Received from"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[#9C8E78]">
            <span>→</span>
            <input
              type="date"
              className={`${inputCls} w-full`}
              value={filters.to ?? ""}
              onChange={(e) => apply({ to: e.target.value || null })}
              aria-label="Received to"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[#9C8E78]">
            <span className="whitespace-nowrap">Updated</span>
            <input
              type="date"
              className={`${inputCls} w-full`}
              value={filters.updatedFrom ?? ""}
              onChange={(e) => apply({ updatedFrom: e.target.value || null })}
              aria-label="Updated from"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[#9C8E78]">
            <span>→</span>
            <input
              type="date"
              className={`${inputCls} w-full`}
              value={filters.updatedTo ?? ""}
              onChange={(e) => apply({ updatedTo: e.target.value || null })}
              aria-label="Updated to"
            />
          </label>
          <select
            className={selectCls}
            value={filters.sort}
            onChange={(e) => apply({ sort: e.target.value }, false)}
            aria-label="Sort"
          >
            {TICKET_SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="submit"
              className="rounded border border-[#3A2D1F] bg-[#221A11] px-3 py-1.5 text-sm text-[#F7F2E8] hover:bg-[#2C2216]"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => {
                setDraftSearch("");
                router.replace(pathname);
              }}
              className="rounded border border-[#3A2D1F] px-3 py-1.5 text-sm text-[#9C8E78] hover:bg-white/[0.03]"
            >
              Clear
            </button>
          </div>
        </form>
      </Section>

      {tickets.error ? (
        <ErrorNotice message={tickets.error} onRetry={tickets.reload} />
      ) : tickets.loading ? (
        <LoadingRows rows={10} />
      ) : !tickets.data || tickets.data.data.length === 0 ? (
        <EmptyState message="No internal tickets match these filters — try widening the date range or clearing a filter." />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Ticket</Th>
                <Th className="w-full">Title</Th>
                <Th>Priority</Th>
                <Th>Stage</Th>
                <Th>Business Units</Th>
                <Th>Published</Th>
                <Th>Received</Th>
                <Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {tickets.data.data.map((t) => (
                <tr key={t.id} className="hover:bg-white/[0.02]">
                  <Td className="whitespace-nowrap font-medium">
                    <Link href={`/admin/tickets/${t.id}`} className="text-[#E8923E] hover:underline">
                      {t.ticketNumber}
                    </Link>
                  </Td>
                  <Td className="max-w-md truncate text-[#F7F2E8]" title={t.title}>
                    {t.title}
                  </Td>
                  <Td>
                    <Badge tone={PRIORITY_BADGE[t.priority]}>{t.priority}</Badge>
                  </Td>
                  <Td>
                    <Badge tone={STAGE_BADGE[t.stage]}>{STAGE_LABELS[t.stage]}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    {t.businessUnits.join(", ") || EMPTY}
                    {t.shared && (
                      <span className="ml-1.5 rounded bg-[rgba(111,166,224,0.16)] px-1 py-0.5 text-[10px] font-semibold text-[#6FA6E0]">
                        SHARED
                      </span>
                    )}
                  </Td>
                  <Td className="text-center">{t.published ? "✓" : EMPTY}</Td>
                  <TimeCell relative={relativeTime(t.createdAt)} exact={formatDateTime(t.createdAt)} />
                  <TimeCell relative={relativeTime(t.updatedAt)} exact={formatDateTime(t.updatedAt)} />
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="flex items-center justify-between text-xs text-[#9C8E78]">
            <span>
              {tickets.data.pagination.totalItems} ticket{tickets.data.pagination.totalItems === 1 ? "" : "s"} · page{" "}
              {filters.page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={filters.page <= 1}
                onClick={() => apply({ page: filters.page - 1 }, false)}
                className="rounded border border-[#3A2D1F] px-2.5 py-1 disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                type="button"
                disabled={filters.page >= totalPages}
                onClick={() => apply({ page: filters.page + 1 }, false)}
                className="rounded border border-[#3A2D1F] px-2.5 py-1 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
