// =============================================================================
// Stage 10b unit tier — pure admin display/format helpers and the URL filter
// codec (refinements R3/R5). No DB, no fetch, no React.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  EMPTY,
  SHARED_ORIGIN_LABEL,
  formatDateTime,
  formatDuration,
  relativeTime,
} from "@/lib/admin/format";
import {
  DEFAULT_TICKET_FILTERS,
  ticketFiltersFromParams,
  ticketFiltersToParams,
  ticketFiltersToQuery,
} from "@/lib/admin/types";

describe("format (frozen rules R5)", () => {
  it("formats dates in Africa/Johannesburg (SAST = UTC+2)", () => {
    // 22:30 UTC = 00:30 SAST next day.
    expect(formatDateTime("2026-07-01T22:30:00Z")).toContain("02 Jul 2026");
    expect(formatDateTime("2026-07-01T10:00:00Z")).toContain("12:00");
  });

  it("missing values render the em-dash, never blank", () => {
    expect(formatDateTime(null)).toBe(EMPTY);
    expect(formatDateTime("not-a-date")).toBe(EMPTY);
    expect(relativeTime(null)).toBe(EMPTY);
    expect(formatDuration("2026-07-01T10:00:00Z", null)).toBe(EMPTY);
  });

  it("relative time buckets minutes/hours/days", () => {
    const now = new Date("2026-07-09T12:00:00Z");
    expect(relativeTime("2026-07-09T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-07-09T11:15:00Z", now)).toBe("45m ago");
    expect(relativeTime("2026-07-09T06:00:00Z", now)).toBe("6h ago");
    expect(relativeTime("2026-07-04T12:00:00Z", now)).toBe("5d ago");
  });

  it("durations render Xs / Xm Ys", () => {
    expect(formatDuration("2026-07-01T10:00:00Z", "2026-07-01T10:00:31Z")).toBe("31s");
    expect(formatDuration("2026-07-01T10:00:00Z", "2026-07-01T10:02:05Z")).toBe("2m 5s");
  });

  it("the honest-NULL origin wording is frozen", () => {
    expect(SHARED_ORIGIN_LABEL).toBe("— Shared ticket");
  });
});

describe("URL filter codec (R3: the URL is the state)", () => {
  it("round-trips a full filter set", () => {
    const f = {
      ...DEFAULT_TICKET_FILTERS,
      q: "printer",
      customer: "ayn",
      bu: "AYN",
      stage: "NEW",
      priority: "P2",
      visibility: "published",
      published: true,
      shared: false,
      from: "2026-07-01",
      to: "2026-07-09",
      sort: "updatedAt:desc",
      page: 3,
    };
    const decoded = ticketFiltersFromParams(ticketFiltersToParams(f));
    expect(decoded).toEqual(f);
  });

  it("defaults produce an EMPTY query string (clean URLs)", () => {
    expect(ticketFiltersToParams(DEFAULT_TICKET_FILTERS).toString()).toBe("");
  });

  it("decoding tolerates junk (page NaN -> 1, missing -> defaults)", () => {
    const decoded = ticketFiltersFromParams(new URLSearchParams("page=abc"));
    expect(decoded.page).toBe(1);
    expect(decoded.sort).toBe(DEFAULT_TICKET_FILTERS.sort);
  });

  it("slug -> id resolution; unknown slug yields an impossible id (honestly empty, never unfiltered)", () => {
    const reference = {
      accounts: [{ id: "acc-1", slug: "ayn" }],
      businessUnits: [{ id: "bu-1", slug: "AYN" }],
    };
    const q = ticketFiltersToQuery({ ...DEFAULT_TICKET_FILTERS, customer: "ayn", bu: "AYN" }, reference);
    expect(q.accountId).toBe("acc-1");
    expect(q.businessUnitId).toBe("bu-1");

    const miss = ticketFiltersToQuery({ ...DEFAULT_TICKET_FILTERS, customer: "nope" }, reference);
    expect(miss.accountId).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("date filters become SAST day bounds", () => {
    const q = ticketFiltersToQuery({ ...DEFAULT_TICKET_FILTERS, from: "2026-07-01", to: "2026-07-02" }, null);
    expect(q.receivedFrom).toBe("2026-07-01T00:00:00+02:00");
    expect(q.receivedTo).toBe("2026-07-02T23:59:59+02:00");
  });
});
