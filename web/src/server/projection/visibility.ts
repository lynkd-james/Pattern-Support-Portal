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
