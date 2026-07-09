// =============================================================================
// ClickUp resolver — pure unit suite (Stage 9a).
//
// Visibility-set resolution: multiple Customer labels are a legitimate SHARED
// ticket (no MULTIPLE_BUSINESS_UNITS quarantine); origin is populated only
// when the set has exactly one member, else NULL; zero matches still
// quarantine (BU_UNDETERMINED — never guess). Content hash is order-invariant
// over the set.
// =============================================================================

import { describe, it, expect } from "vitest";
import { resolveTicket, type ResolveContext, type BusinessUnitRef } from "@/server/sync/resolve";
import type { ClickUpTask } from "@/server/clickup/types";

const AYN: BusinessUnitRef = { id: "bu-ayana", accountId: "acct-ayana" };
const RFRY: BusinessUnitRef = { id: "bu-refinery", accountId: "acct-refinery" };

const ctx: ResolveContext = {
  statusMap: new Map([["to do", { stage: "NEW", paused: false }]]),
  buBySlug: new Map([
    ["AYN", AYN],
    ["RFRY", RFRY],
  ]),
  customerFieldName: "Customer",
  slaPriorityFieldName: "SLA Priority",
};

/** Build a ClickUp task with the given Customer + SLA Priority label sets. */
function task(customerLabels: string[], priorityLabels: string[] = ["P2"]): ClickUpTask {
  const labelField = (name: string, labels: string[]) => {
    const options = labels.map((l, i) => ({ id: `${name}-opt-${i}`, label: l }));
    return {
      id: `cf-${name}`,
      name,
      type: "labels",
      type_config: { options },
      value: options.map((o) => o.id),
    };
  };
  return {
    id: "task-1",
    custom_id: "PAT3-9001",
    name: "Stage 9A Shared Ticket Validation",
    description: "body",
    status: { status: "to do" },
    date_created: "1700000000000",
    date_updated: "1700000100000",
    custom_fields: [
      labelField("Customer", customerLabels),
      labelField("SLA Priority", priorityLabels),
    ],
  };
}

describe("resolver — visibility set", () => {
  it("single label -> one-member set, origin = that BU", () => {
    const r = resolveTicket(task(["AYN"]), ctx);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.data.businessUnits.map((b) => b.id)).toEqual(["bu-ayana"]);
      expect(r.data.originAccountId).toBe("acct-ayana");
      expect(r.data.originBusinessUnitId).toBe("bu-ayana");
    }
  });

  it("multiple labels -> multi-member set, origin NULL (no fabricated origin)", () => {
    const r = resolveTicket(task(["AYN", "RFRY"]), ctx);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(new Set(r.data.businessUnits.map((b) => b.id))).toEqual(
        new Set(["bu-ayana", "bu-refinery"])
      );
      expect(r.data.originAccountId).toBeNull();
      expect(r.data.originBusinessUnitId).toBeNull();
    }
  });

  it("zero mapped labels -> BU_UNDETERMINED (never guess)", () => {
    const r = resolveTicket(task(["UNKNOWN"]), ctx);
    expect(r.kind === "quarantine" && r.reason).toBe("BU_UNDETERMINED");
  });

  it("content hash is invariant to Customer label ORDER", () => {
    const a = resolveTicket(task(["AYN", "RFRY"]), ctx);
    const b = resolveTicket(task(["RFRY", "AYN"]), ctx);
    expect(a.kind === "ok" && b.kind === "ok" && a.data.contentHash).toBe(
      b.kind === "ok" ? b.data.contentHash : "x"
    );
  });

  it("content hash CHANGES when set membership changes", () => {
    const one = resolveTicket(task(["AYN"]), ctx);
    const two = resolveTicket(task(["AYN", "RFRY"]), ctx);
    expect(one.kind === "ok" && two.kind === "ok" && one.data.contentHash).not.toBe(
      two.kind === "ok" ? two.data.contentHash : "x"
    );
  });

  it("still quarantines missing SLA priority (pre-9a behaviour intact)", () => {
    const r = resolveTicket(task(["AYN"], []), ctx);
    expect(r.kind === "quarantine" && r.reason).toBe("SLA_PRIORITY_MISSING");
  });
});

describe("resolver — P4 as a first-class priority (standalone change)", () => {
  it("P4 RESOLVES like any other priority (no quarantine)", () => {
    const r = resolveTicket(task(["AYN"], ["P4"]), ctx);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.data.priority).toBe("P4");
  });

  it("an unrecognised priority label still quarantines (as MISSING — never guess)", () => {
    const r = resolveTicket(task(["AYN"], ["P5"]), ctx);
    expect(r.kind === "quarantine" && r.reason).toBe("SLA_PRIORITY_MISSING");
  });

  it("P4 alongside another priority is still ambiguous (SLA_PRIORITY_MULTIPLE)", () => {
    const r = resolveTicket(task(["AYN"], ["P2", "P4"]), ctx);
    expect(r.kind === "quarantine" && r.reason).toBe("SLA_PRIORITY_MULTIPLE");
  });
});
