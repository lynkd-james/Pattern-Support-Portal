"use client";

// =============================================================================
// Quarantine (Stage 10b) — the latest clickup sync's quarantines grouped by
// reason, with plain-language explanations. READ-ONLY (invariant 10b-1).
// Items are SYNC-REPORT ENTRIES, not database tickets (never-guess: nothing
// was fabricated) — so there is deliberately no ticket link (known limitation
// in docs/admin-portal.md). Fixing a quarantine happens at the source
// (ClickUp field / seed data), after which the next sync clears it.
// =============================================================================

import { fetchAdminQuarantine } from "../../lib/admin/api";
import { QUARANTINE_EXPLANATIONS } from "../../lib/admin/types";
import { EMPTY } from "../../lib/admin/format";
import { useAdminData } from "./useAdminData";
import { EmptyState, ErrorNotice, LoadingRows, Section, Table, Td, Th } from "./ui";

export default function QuarantinePage() {
  const q = useAdminData(() => fetchAdminQuarantine(), []);

  if (q.loading) return <LoadingRows rows={6} />;
  if (q.error) return <ErrorNotice message={q.error} onRetry={q.reload} />;
  if (!q.data) return null;

  const reasons = Object.entries(q.data.byReason).sort((a, b) => b[1] - a[1]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-[#F7F2E8]">Quarantine</h1>
        <span className="text-sm text-[#9C8E78]">
          {q.data.total} item{q.data.total === 1 ? "" : "s"} in the latest ClickUp sync
          {q.data.sourceRunId !== null && ` (run #${q.data.sourceRunId})`}
        </span>
      </div>

      {q.data.total === 0 ? (
        <EmptyState message="Nothing is quarantined — every ticket in the latest sync classified cleanly." />
      ) : (
        reasons.map(([reason, count]) => (
          <Section key={reason} title={`${reason} — ${count}`}>
            <p className="mb-3 text-sm text-[#9C8E78]">
              {QUARANTINE_EXPLANATIONS[reason] ?? "Unrecognised quarantine reason code."}
            </p>
            <Table>
              <thead>
                <tr>
                  <Th>Custom ID</Th>
                  <Th className="w-full">Detail</Th>
                </tr>
              </thead>
              <tbody>
                {q.data!.items
                  .filter((i) => i.reason === reason)
                  .map((i, idx) => (
                    <tr key={idx}>
                      <Td className="whitespace-nowrap font-medium text-[#F7F2E8]">{i.customId ?? EMPTY}</Td>
                      <Td className="text-sm">{i.detail}</Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </Section>
        ))
      )}
    </div>
  );
}
