// =============================================================================
// Projection visibility planning — pure unit suite (Stage 9a).
//
// planProjectionRows is the deterministic core of the fan-out/withdraw engine:
// given the ticket-level target visibility, the current visibility set
// (junction members) and the rows that currently exist, it decides which
// per-BU rows to publish, hide (tombstone), or remove (hard-delete).
//
// The lifecycle rule (docs/shared-tickets.md): a projection row may exist only
// while its visibility scope exists.
//   * scope exists + published  -> publish
//   * scope exists + unpublished-> hide (tombstone; junction row remains)
//   * scope gone                -> remove (hard-delete; invariant 9a-4)
// =============================================================================

import { describe, it, expect } from "vitest";
import { planProjectionRows, determineVisibility } from "@/server/projection/visibility";

const sorted = (a: string[]) => [...a].sort();

describe("planProjectionRows — published ticket", () => {
  it("single-BU: publishes the one member, nothing to hide/remove", () => {
    const p = planProjectionRows({ target: "published", visibilityBuIds: ["a"], existingRowBuIds: [] });
    expect(p).toEqual({ publish: ["a"], hide: [], remove: [] });
  });

  it("shared: fans out to every member", () => {
    const p = planProjectionRows({ target: "published", visibilityBuIds: ["a", "b"], existingRowBuIds: ["a"] });
    expect(sorted(p.publish)).toEqual(["a", "b"]);
    expect(p.hide).toEqual([]);
    expect(p.remove).toEqual([]);
  });

  it("de-listed BU: publishes survivors, REMOVES the de-listed row (scope gone)", () => {
    // Was shared {a,b}; b removed from the label set -> now {a}.
    const p = planProjectionRows({ target: "published", visibilityBuIds: ["a"], existingRowBuIds: ["a", "b"] });
    expect(p.publish).toEqual(["a"]);
    expect(p.remove).toEqual(["b"]);
    expect(p.hide).toEqual([]);
  });
});

describe("planProjectionRows — unpublished ticket", () => {
  it("member rows become tombstones (hide), scope still exists", () => {
    const p = planProjectionRows({ target: "ready_for_customer", visibilityBuIds: ["a", "b"], existingRowBuIds: ["a", "b"] });
    expect(sorted(p.hide)).toEqual(["a", "b"]);
    expect(p.publish).toEqual([]);
    expect(p.remove).toEqual([]);
  });

  it("unpublished AND de-listed: survivor tombstoned, de-listed removed", () => {
    // Ticket unpublished; and b was de-listed. a keeps scope (hide), b gone (remove).
    const p = planProjectionRows({ target: "internal_only", visibilityBuIds: ["a"], existingRowBuIds: ["a", "b"] });
    expect(p.hide).toEqual(["a"]);
    expect(p.remove).toEqual(["b"]);
    expect(p.publish).toEqual([]);
  });

  it("nothing exists yet: no-op", () => {
    const p = planProjectionRows({ target: "internal_only", visibilityBuIds: ["a"], existingRowBuIds: [] });
    expect(p).toEqual({ publish: [], hide: [], remove: [] });
  });
});

describe("determineVisibility — unchanged 8a rules still hold under 9a", () => {
  it("ADMIN lock keeps current state", () => {
    expect(
      determineVisibility({ adminLocked: true, currentVisibility: "internal_only", deletedAt: null, rawStatus: "to do", autoPublish: true })
    ).toBe("internal_only");
  });
  it("soft-delete and cancelled hide", () => {
    expect(determineVisibility({ adminLocked: false, currentVisibility: "published", deletedAt: new Date(), rawStatus: "to do", autoPublish: true })).toBe("hidden_from_customer");
    expect(determineVisibility({ adminLocked: false, currentVisibility: "published", deletedAt: null, rawStatus: "cancelled", autoPublish: true })).toBe("hidden_from_customer");
  });
  it("auto-publish on/off", () => {
    expect(determineVisibility({ adminLocked: false, currentVisibility: "internal_only", deletedAt: null, rawStatus: "to do", autoPublish: true })).toBe("published");
    expect(determineVisibility({ adminLocked: false, currentVisibility: "internal_only", deletedAt: null, rawStatus: "to do", autoPublish: false })).toBe("ready_for_customer");
  });
});
