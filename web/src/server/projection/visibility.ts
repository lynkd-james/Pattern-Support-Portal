// =============================================================================
// Visibility decision for the customer projection (pure, deterministic).
//
// Computes the TARGET visibility_state for an internal ticket. Rules, in order:
//   1. ADMIN-locked  -> keep the current state (explicit human decision wins;
//      this is what makes a rebuild preserve explicit visibility decisions).
//   2. Soft-deleted   -> hidden_from_customer.
//   3. Cancelled      -> hidden_from_customer (product decision: done is shown,
//      cancelled is not). This is the ONLY place the projection inspects the raw
//      ClickUp status, and only to decide visibility — never to re-map a stage.
//   4. AUTO_PUBLISH on  -> published.
//   5. AUTO_PUBLISH off -> ready_for_customer (eligible, staged, NOT projected).
// =============================================================================

export type Visibility =
  | "internal_only"
  | "ready_for_customer"
  | "published"
  | "hidden_from_customer";

/** Raw ClickUp status that must never be shown to customers. */
export const CANCELLED_RAW_STATUS = "cancelled";

export interface VisibilityInput {
  adminLocked: boolean;
  currentVisibility: Visibility;
  deletedAt: Date | null;
  rawStatus: string | null;
  autoPublish: boolean;
}

export function determineVisibility(input: VisibilityInput): Visibility {
  if (input.adminLocked) return input.currentVisibility;
  if (input.deletedAt) return "hidden_from_customer";
  if ((input.rawStatus ?? "").toLowerCase() === CANCELLED_RAW_STATUS) {
    return "hidden_from_customer";
  }
  return input.autoPublish ? "published" : "ready_for_customer";
}

/** Whether a target visibility means a live row should exist in customer_tickets. */
export function isPublished(v: Visibility): boolean {
  return v === "published";
}

// -----------------------------------------------------------------------------
// Stage 9a (docs/shared-tickets.md): per-(ticket x BU) row planning — pure.
//
// The projection is a DETERMINISTIC FUNCTION of the internal model
// (docs/projection.md): given the ticket-level target visibility, the current
// VISIBILITY set (junction members) and the customer rows that exist today,
// compute exactly which per-BU rows must be live and which must be withdrawn.
// Invariant: any row that would not exist in a full rebuild must not exist
// after an incremental update — withdrawals are never optional.
// -----------------------------------------------------------------------------

export interface RowPlan {
  /** BU ids that must have a live (published) customer row after this run. */
  publish: string[];
  /**
   * BU ids whose rows are hidden as TOMBSTONES (ticket unpublished but the BU
   * is still a visibility member — junction row exists, so invariant 9a-4
   * holds and 8a-era retention behaviour is preserved).
   */
  hide: string[];
  /**
   * BU ids whose rows are HARD-DELETED (the BU was de-listed — its junction
   * row is gone, entitlement revoked; a tombstone would permanently violate
   * invariant 9a-4 "no projection row without its junction row". The
   * withdrawal itself is retained in append-only audit_events).
   */
  remove: string[];
}

export function planProjectionRows(input: {
  target: Visibility;
  /** Current visibility set (junction members' BU ids). */
  visibilityBuIds: readonly string[];
  /** BU ids of customer rows that currently exist (any visibility state). */
  existingRowBuIds: readonly string[];
}): RowPlan {
  const members = new Set(input.visibilityBuIds);
  // De-listed rows are removed regardless of ticket-level visibility.
  const remove = input.existingRowBuIds.filter((id) => !members.has(id));

  if (isPublished(input.target)) {
    return { publish: [...input.visibilityBuIds], hide: [], remove };
  }
  // Not published: member rows become tombstones; de-listed rows still remove.
  return {
    publish: [],
    hide: input.existingRowBuIds.filter((id) => members.has(id)),
    remove,
  };
}
