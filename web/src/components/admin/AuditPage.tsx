"use client";

// =============================================================================
// Audit (Stage 10b) — chronological event viewer over audit_events. URL-driven
// filters (refinement R3), keyset "Load more" (beforeId), entity labels
// supplied by the API (design-review addition: ticket numbers, not UUIDs).
// READ-ONLY — audit_events is append-only and this page cannot touch it.
// =============================================================================

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminAuditEvent } from "../../lib/admin/contracts";
import { fetchAdminAudit } from "../../lib/admin/api";
import { CHANGE_SOURCES, ENTITY_TYPES } from "../../lib/admin/types";
import { EMPTY, formatDateTime, relativeTime } from "../../lib/admin/format";
import { EmptyState, ErrorNotice, LoadingRows, Section, Table, Td, Th, TimeCell } from "./ui";

const PAGE = 100;

const inputCls =
  "rounded border border-[#3A2D1F] bg-[#120D08] px-2 py-1.5 text-sm text-[#D9CFBE] placeholder-[#5C5142] focus:border-[#E8923E] focus:outline-none";

export default function AuditPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo(
    () => ({
      entityType: searchParams.get("entityType"),
      changeSource: searchParams.get("source"),
      q: searchParams.get("q") ?? "",
    }),
    [searchParams]
  );
  const [draftSearch, setDraftSearch] = useState(filters.q);

  const [events, setEvents] = useState<AdminAuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [nonce, setNonce] = useState(0);

  const spKey = searchParams.toString();

  // Filter change (or retry) → reset and load the first keyset page.
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setEvents([]);
    setExhausted(false);
    fetchAdminAudit({
      entityType: filters.entityType,
      changeSource: filters.changeSource,
      search: filters.q || null,
      limit: PAGE,
    })
      .then((data) => {
        if (!active) return;
        setEvents(data);
        setExhausted(data.length < PAGE);
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : "Request failed"))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spKey, nonce]);

  const loadMore = useCallback(async () => {
    if (events.length === 0 || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await fetchAdminAudit({
        entityType: filters.entityType,
        changeSource: filters.changeSource,
        search: filters.q || null,
        beforeId: events[events.length - 1].id,
        limit: PAGE,
      });
      setEvents((prev) => [...prev, ...more]);
      if (more.length < PAGE) setExhausted(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoadingMore(false);
    }
  }, [events, filters, loadingMore]);

  function apply(next: Partial<{ entityType: string | null; source: string | null; q: string }>) {
    const p = new URLSearchParams();
    const entityType = "entityType" in next ? next.entityType : filters.entityType;
    const source = "source" in next ? next.source : filters.changeSource;
    const q = "q" in next ? next.q ?? "" : filters.q;
    if (entityType) p.set("entityType", entityType);
    if (source) p.set("source", source);
    if (q) p.set("q", q);
    router.replace(`${pathname}${p.toString() ? `?${p.toString()}` : ""}`);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-[#F7F2E8]">Audit</h1>

      <Section title="Filters">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            apply({ q: draftSearch });
          }}
        >
          <input
            type="search"
            value={draftSearch}
            onChange={(e) => setDraftSearch(e.target.value)}
            placeholder="Actor, field, ticket #…"
            className={`${inputCls} w-64`}
            aria-label="Search audit"
          />
          <select
            className={inputCls}
            value={filters.entityType ?? ""}
            onChange={(e) => apply({ entityType: e.target.value || null })}
            aria-label="Entity type"
          >
            <option value="">All entities</option>
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            className={inputCls}
            value={filters.changeSource ?? ""}
            onChange={(e) => apply({ source: e.target.value || null })}
            aria-label="Change source"
          >
            <option value="">All sources</option>
            {CHANGE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
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
        </form>
      </Section>

      {loading ? (
        <LoadingRows rows={10} />
      ) : error ? (
        <ErrorNotice message={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : events.length === 0 ? (
        <EmptyState message="No audit events match these filters." />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Entity</Th>
                <Th>Field</Th>
                <Th>Change</Th>
                <Th>Source</Th>
                <Th>Actor</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <TimeCell relative={relativeTime(e.occurredAt)} exact={formatDateTime(e.occurredAt)} />
                  <Td className="whitespace-nowrap">
                    <span className="text-[#F7F2E8]">{e.entityLabel ?? e.entityType}</span>
                    {e.entityLabel && <span className="ml-1.5 text-xs text-[#9C8E78]">{e.entityType}</span>}
                  </Td>
                  <Td>{e.field ?? EMPTY}</Td>
                  <Td
                    className="max-w-xs truncate text-xs"
                    title={`${JSON.stringify(e.oldValue)} → ${JSON.stringify(e.newValue)}`}
                  >
                    {JSON.stringify(e.oldValue) ?? EMPTY} → {JSON.stringify(e.newValue) ?? EMPTY}
                  </Td>
                  <Td className="text-xs text-[#9C8E78]">{e.changeSource}</Td>
                  <Td className="text-xs text-[#9C8E78]">{e.actor ?? EMPTY}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!exhausted && (
            <div className="text-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="rounded border border-[#3A2D1F] px-4 py-1.5 text-sm text-[#D9CFBE] hover:bg-white/[0.03] disabled:opacity-40"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
