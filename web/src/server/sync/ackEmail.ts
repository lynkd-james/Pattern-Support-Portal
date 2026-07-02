// =============================================================================
// Pure parser for the supportdesk "ticket has been logged" acknowledgement email.
//
// An email counts as an acknowledgement only if it contains the ack phrase AND a
// single ticket reference (e.g. "PAT3-3910"). Multiple distinct refs => ambiguous
// (never guessed). No I/O here, so it is unit-testable in isolation.
// =============================================================================

/** Phrase the automation uses: "Your ticket has been logged, with Ref. ID: PAT3-xxxx". */
export const ACK_PHRASE = "ticket has been logged";

/** Support ticket reference format (= ClickUp custom_id = internal_tickets.ticket_number). */
const REF_RE = /PAT3-\d+/gi;

export type AckRefResult =
  | { kind: "ok"; ref: string }
  | { kind: "none" }
  | { kind: "ambiguous"; refs: string[] };

export function extractAckRef(
  subject: string | null | undefined,
  bodyPreview: string | null | undefined
): AckRefResult {
  const hay = `${subject ?? ""}\n${bodyPreview ?? ""}`;
  if (!hay.toLowerCase().includes(ACK_PHRASE)) return { kind: "none" };

  const refs = [...new Set([...hay.matchAll(REF_RE)].map((m) => m[0].toUpperCase()))];
  if (refs.length === 0) return { kind: "none" };
  if (refs.length > 1) return { kind: "ambiguous", refs };
  return { kind: "ok", ref: refs[0] };
}
