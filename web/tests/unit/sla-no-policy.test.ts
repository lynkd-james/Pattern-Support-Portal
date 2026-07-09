// =============================================================================
// P4 / no-policy SLA behaviour (standalone change, 2026-07-09).
//
// The business rule "P4 has no SLA" is encoded as the ABSENCE of an
// sla_policies row, never as engine special-casing. This suite proves the
// engine's existing no-policy path carries it: policy: null (what the
// resolver produces for P4, since no policy matches) => both dimensions
// NOT_APPLICABLE, both due-times null, no applied policy.
// =============================================================================

import { describe, it, expect } from "vitest";
import { computeSlaSnapshot } from "@/server/sla/sla";

describe("SLA engine — no matching policy (the P4 path)", () => {
  it("no policy => NOT_APPLICABLE both dimensions, null due-times", () => {
    const s = computeSlaSnapshot({
      createdAt: new Date("2026-07-01T08:00:00+02:00"),
      acknowledgedAt: new Date("2026-07-01T09:00:00+02:00"),
      closedAt: null,
      now: new Date("2026-07-09T12:00:00+02:00"),
      policy: null,
      calendar: null,
    });
    expect(s.responseState).toBe("NOT_APPLICABLE");
    expect(s.resolutionState).toBe("NOT_APPLICABLE");
    expect(s.responseDueAt).toBeNull();
    expect(s.resolutionDueAt).toBeNull();
    expect(s.appliedPolicyId).toBeNull();
  });

  it("NOT_APPLICABLE regardless of milestones (a closed P4 stays no-SLA)", () => {
    const s = computeSlaSnapshot({
      createdAt: new Date("2026-07-01T08:00:00+02:00"),
      acknowledgedAt: null,
      closedAt: new Date("2026-07-08T16:00:00+02:00"),
      now: new Date("2026-07-09T12:00:00+02:00"),
      policy: null,
      calendar: null,
    });
    expect(s.responseState).toBe("NOT_APPLICABLE");
    expect(s.resolutionState).toBe("NOT_APPLICABLE");
  });
});
